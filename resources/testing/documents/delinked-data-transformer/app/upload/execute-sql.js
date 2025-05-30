const fs = require('fs')
const readline = require('readline')
const { logInfo, logProgress, logError } = require('../util/logger')
const { EXCLUDE_ETL_TABLES } = require('../constants/etl-protection')

async function executeSqlFile (sqlFile, client, schemaOnly = false) {
  const stats = {
    executed: 0,
    skipped: {
      total: 0,
      metaCommands: 0,
      constraints: 0,
      alreadyExists: 0,
      otherErrors: 0
    },
    skippedExamples: {
      metaCommands: [],
      constraints: [],
      alreadyExists: [],
      otherErrors: []
    },
    statementTypes: {
      INSERT: 0,
      UPDATE: 0,
      DELETE: 0,
      CREATE: 0,
      ALTER: 0,
      other: 0
    }
  }

  logInfo(`Executing ${schemaOnly ? 'schema-only' : 'data-only'} SQL in transaction...`)

  // Read and process in manageable chunks
  const fileStream = fs.createReadStream(sqlFile, { encoding: 'utf8' })
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })

  let inFunctionBlock = false
  let inMultilineComment = false
  let parenCount = 0
  let statementCount = 0
  let batchSize = 0
  let currentStatement = ''
  const BATCH_COMMIT_SIZE = 10000 // Commit every 10k statements for large imports

  for await (const line of rl) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('--')) {
      continue
    }

    if (!inMultilineComment && trimmedLine.includes('/*')) {
      inMultilineComment = true
    }
    if (inMultilineComment && trimmedLine.includes('*/')) {
      inMultilineComment = false
      continue
    }
    if (inMultilineComment) {
      continue
    }

    if (!inFunctionBlock &&
      (trimmedLine.match(/^\s*CREATE(\s+OR\s+REPLACE)?\s+FUNCTION/i) ||
        trimmedLine.match(/^\s*CREATE(\s+OR\s+REPLACE)?\s+PROCEDURE/i))) {
      inFunctionBlock = true
    }

    if (!inFunctionBlock) {
      for (const char of trimmedLine) {
        if (char === '(') parenCount++
        if (char === ')') parenCount--
      }
    }

    currentStatement += line + '\n'

    if (!inFunctionBlock &&
      trimmedLine.endsWith(';') &&
      parenCount <= 0) {
      try {
        await executeStatement(currentStatement.trim(), client, stats, schemaOnly)
      } catch (error) {
        logError(`ERROR processing statement: ${error.message}`)
        logError(`Statement content: ${truncateString(currentStatement, 150)}`)
        throw error
      }
      currentStatement = ''
      parenCount = 0
      statementCount++
      batchSize++

      if (batchSize >= BATCH_COMMIT_SIZE) {
        await client.query('COMMIT')
        await client.query('BEGIN')
        logInfo(`Committed batch of ${batchSize} statements, starting new transaction`)
        batchSize = 0
      }

      if (statementCount % 100 === 0) {
        logProgress('.')
      }
    } else if (inFunctionBlock &&
      ((trimmedLine.includes('$$') && trimmedLine.endsWith(';')) ||
        trimmedLine.endsWith('$$;'))) {
      await executeStatement(currentStatement.trim(), client, stats, schemaOnly)
      currentStatement = ''
      inFunctionBlock = false
      statementCount++
      batchSize++
    }
  }

  if (currentStatement.trim()) {
    await executeStatement(currentStatement.trim(), client, stats, schemaOnly)
  }

  logSkippedStatistics(stats)

  return stats
}

async function loadDataInBatchesWithErrorTracking (client, sqlFile) {
  const lineReader = require('readline').createInterface({
    input: fs.createReadStream(sqlFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let statement = ''
  let statementCount = 0
  let batchSize = 0
  let rowCount = 0
  let lineNum = 0
  let statementStartLine = 0
  const BATCH_SIZE = 500
  const errorLogFile = `${sqlFile}.errors.log`

  fs.writeFileSync(errorLogFile, `SQL Error Log for ${sqlFile}\n${new Date().toISOString()}\n\n`, 'utf8')
  logInfo(`SQL errors will be logged to ${errorLogFile}`)

  await client.query('BEGIN')

  try {
    // Try to use session_replication_role if available
    await client.query('SET session_replication_role = replica')
    logInfo('Foreign key constraints and triggers temporarily disabled')
  } catch (err) {
    // If not available (lack of permissions), try alternative approach
    logInfo(`Note: Could not set session_replication_role: ${err.message}`)
    logInfo('Trying alternative approach for handling constraints...')

    try {
      // Get all constraints
      const { rows: constraints } = await client.query(`
        SELECT 
          tc.constraint_name, 
          tc.table_name
        FROM 
          information_schema.table_constraints tc 
        WHERE 
          tc.constraint_type = 'FOREIGN KEY' 
          AND tc.table_schema = 'public'
      `)

      logInfo(`Found ${constraints.length} foreign key constraints - will handle errors individually`)
    } catch (err) {
      logInfo(`Could not query constraints: ${err.message}`)
    }
  }

  for await (const line of lineReader) {
    lineNum++

    if (statement === '') {
      statementStartLine = lineNum
    }

    if (line.trim().startsWith('--')) continue

    statement += line + '\n'

    if (line.trim().endsWith(';')) {
      try {
        await client.query(statement)
        statementCount++
        batchSize++

        // Count rows in multi-row INSERT (VALUES has line breaks)
        if (statement.includes('VALUES\n')) {
          const insertedRows = (statement.match(/\),\s*\(/g) || []).length + 1
          rowCount += insertedRows
        } else {
          rowCount++
        }

        statement = ''

        // Commit in batches
        if (batchSize >= BATCH_SIZE) {
          await client.query('COMMIT')
          await client.query('BEGIN')
          logInfo(`Committed batch of ${batchSize} statements (${rowCount} rows)`)
          batchSize = 0
        }
      } catch (err) {
        const errorDetail = `\n===== ERROR at statement #${statementCount + 1} (lines ${statementStartLine}-${lineNum}) =====\n` +
          `Error: ${err.message}\n` +
          `Statement:\n${statement}\n`

        fs.appendFileSync(errorLogFile, errorDetail, 'utf8')

        let errorContext = ''
        const errorTokenMatch = err.message.match(/at or near "([^"]+)"/)

        if (errorTokenMatch) {
          const errorToken = errorTokenMatch[1]
          const tokenPos = statement.indexOf(errorToken)

          if (tokenPos !== -1) {
            const start = Math.max(0, tokenPos - 30)
            const end = Math.min(statement.length, tokenPos + errorToken.length + 30)
            errorContext = `... ${statement.substring(start, end)} ...`

            fs.appendFileSync(errorLogFile, `Likely error context: ${errorContext}\n`, 'utf8')
          }
        }

        if (err.message.includes('syntax error')) {
          logError(`❌ Error at statement #${statementCount + 1} (lines ${statementStartLine}-${lineNum}): ${err.message}`)
          if (errorContext) {
            logError(`❌ Error context: ${errorContext}`)
          }
        } else if (err.message.includes('multiple primary keys') ||
          err.message.includes('already exists') ||
          err.message.includes('duplicate key')) {
          logInfo(`⚠️ Skipping statement with schema error: ${err.message}`)
        } else if (err.message.includes('violates foreign key constraint')) {
          logInfo(`⚠️ Foreign key violation (continuing): ${err.message}`)
        } else {
          logError(`❌ Error at statement #${statementCount + 1}: ${err.message}`)
        }

        statement = ''
      }
    }
  }

  // Re-enable constraints if we disabled them
  try {
    await client.query('SET session_replication_role = DEFAULT')
    logInfo('Foreign key constraints and triggers re-enabled')
  } catch (err) {
    logInfo(`Note: Could not reset session_replication_role: ${err.message}`)
  }

  if (batchSize > 0) {
    await client.query('COMMIT')
    logInfo(`Final batch: ${batchSize} statements (${rowCount} total rows)`)
  }

  return rowCount
}

async function executeStatement (stmt, client, stats = {}, schemaOnly = false) {
  const queryType = determineQueryType(stmt)

  // Skip data modification statements in schema-only mode
  if (schemaOnly && ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(queryType)) {
    stats.skipped = (stats.skipped || 0) + 1
    stats[`skipped_${queryType.toLowerCase()}`] = (stats[`skipped_${queryType.toLowerCase()}`] || 0) + 1
    return
  }

  // ETL protection check
  const isEtlOperation = EXCLUDE_ETL_TABLES &&
                        /^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE)\s+(?:public\.)?("?etl[^"]*"?|etl[^\s(]*)/i.test(stmt)

  if (isEtlOperation) {
    stats.skippedEtl = (stats.skippedEtl || 0) + 1
    console.log(`⚠️ ETL PROTECTION: Skipping operation on ETL table: ${truncateString(stmt, 100)}`)
    return
  }

  try {
    const startTime = Date.now()
    const result = await client.query(stmt)
    const duration = Date.now() - startTime

    // Update statistics
    stats.executed = (stats.executed || 0) + 1
    stats[`executed_${queryType.toLowerCase()}`] = (stats[`executed_${queryType.toLowerCase()}`] || 0) + 1
    stats.totalTimeMs = (stats.totalTimeMs || 0) + duration

    if (duration > 1000) {
      console.log(`Long-running query (${duration}ms): ${truncateString(stmt, 100)}`)
    }

    return result
  } catch (error) {
    stats.errors = (stats.errors || 0) + 1
    console.error(`Error executing statement: ${error.message}`)
    console.error(`Statement: ${truncateString(stmt, 200)}`)
    throw error
  }
}

function determineQueryType (stmt) {
  const trimmedStmt = stmt.trim().toUpperCase()

  if (trimmedStmt.startsWith('INSERT')) return 'INSERT'
  if (trimmedStmt.startsWith('UPDATE')) return 'UPDATE'
  if (trimmedStmt.startsWith('DELETE')) return 'DELETE'
  if (trimmedStmt.startsWith('CREATE TABLE')) return 'CREATE_TABLE'
  if (trimmedStmt.startsWith('CREATE')) return 'CREATE'
  if (trimmedStmt.startsWith('ALTER')) return 'ALTER'
  if (trimmedStmt.startsWith('DROP')) return 'DROP'
  if (trimmedStmt.startsWith('TRUNCATE')) return 'TRUNCATE'
  if (trimmedStmt.startsWith('SELECT')) return 'SELECT'
  if (trimmedStmt.startsWith('COPY')) return 'COPY'

  return 'OTHER'
}

function logSkippedStatistics (stats) {
  if (!stats) return

  logInfo('\n--- SQL Execution Statistics ---')

  if (stats.executed) {
    logInfo(`✅ Executed statements: ${stats.executed}`)
  }

  if (stats.skipped && stats.skipped > 0) {
    logInfo(`⏭️ Skipped statements: ${stats.skipped}`)

    // Report on specific types of skipped statements
    const skippedByType = []

    if (stats.skipped_insert) skippedByType.push(`${stats.skipped_insert} INSERTs`)
    if (stats.skipped_update) skippedByType.push(`${stats.skipped_update} UPDATEs`)
    if (stats.skipped_delete) skippedByType.push(`${stats.skipped_delete} DELETEs`)
    if (stats.skipped_truncate) skippedByType.push(`${stats.skipped_truncate} TRUNCATEs`)

    if (skippedByType.length > 0) {
      logInfo(`   Breakdown: ${skippedByType.join(', ')}`)
    }
  }

  if (stats.skippedEtl) {
    logInfo(`🛡️ ETL Protection: ${stats.skippedEtl} operations on ETL tables prevented`)
  }

  if (stats.errors) {
    logInfo(`❌ Errors: ${stats.errors}`)
  }

  if (stats.totalTimeMs) {
    logInfo(`⏱️ Total execution time: ${(stats.totalTimeMs / 1000).toFixed(2)} seconds`)
  }

  logInfo('--------------------------------')
}

function truncateString (str, maxLength) {
  if (!str) return ''
  if (str.length <= maxLength) return str

  return str.substring(0, maxLength - 3) + '...'
}

module.exports = {
  executeSqlFile,
  loadDataInBatchesWithErrorTracking,
  truncateString
}
