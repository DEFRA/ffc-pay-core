const fs = require('fs')
const readline = require('readline')
const { logInfo, logProgress, logError } = require('../util/logger')

async function executeSqlFile(sqlFile, client, schemaOnly = false) {
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
  let currentStatement = '' // Fix: Initialize currentStatement
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
    }
    else if (inFunctionBlock &&
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

async function loadDataInBatchesWithErrorTracking(client, sqlFile) {
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

    // Track statement start lines for error reporting
    if (statement === '') {
      statementStartLine = lineNum
    }

    // Skip comments
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
          `Statement:\n${statement}\n`;

        fs.appendFileSync(errorLogFile, errorDetail, 'utf8');

        let errorContext = '';
        const errorTokenMatch = err.message.match(/at or near "([^"]+)"/);

        if (errorTokenMatch) {
          const errorToken = errorTokenMatch[1];
          const tokenPos = statement.indexOf(errorToken);

          if (tokenPos !== -1) {
            const start = Math.max(0, tokenPos - 30);
            const end = Math.min(statement.length, tokenPos + errorToken.length + 30);
            errorContext = `... ${statement.substring(start, end)} ...`;

            fs.appendFileSync(errorLogFile, `Likely error context: ${errorContext}\n`, 'utf8');
          }
        }

        if (err.message.includes('syntax error')) {
          logError(`❌ Error at statement #${statementCount + 1} (lines ${statementStartLine}-${lineNum}): ${err.message}`);
          if (errorContext) {
            logError(`❌ Error context: ${errorContext}`);
          }
        }
        else if (err.message.includes('multiple primary keys') ||
          err.message.includes('already exists') ||
          err.message.includes('duplicate key')) {
          logInfo(`⚠️ Skipping statement with schema error: ${err.message}`);
        }
        else if (err.message.includes('violates foreign key constraint')) {
          logInfo(`⚠️ Foreign key violation (continuing): ${err.message}`);
        }
        else {
          logError(`❌ Error at statement #${statementCount + 1}: ${err.message}`);
        }

        statement = '';
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

async function executeStatement(stmt, client, stats, schemaOnly = false) {
  //  function implementation...
}

function determineQueryType(stmt) {
  // function implementation...
}

function logSkippedStatistics(stats) {
  // function implementation...
}

function truncateString(str, maxLength) {
  // function implementation...
}

module.exports = {
  executeSqlFile,
  loadDataInBatchesWithErrorTracking,
  truncateString
}