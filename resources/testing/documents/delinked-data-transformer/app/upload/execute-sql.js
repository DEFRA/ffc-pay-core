const fs = require('fs')
const readline = require('readline')
const { logInfo, logProgress, logError } = require('../util/logger')
const { EXCLUDE_ETL_TABLES, ETL_TABLE_PREFIX, PROTECTED_TABLES } = require('../constants/etl-protection')

/**
 * Execute an SQL file using batch processing with Azure-optimized error handling
 * @param {Object} client - Database client
 * @param {string} sqlFile - Path to SQL file
 */
async function executeSqlFile(client, sqlFile) {
  logInfo(`Executing SQL file: ${sqlFile}`)
  return loadDataInBatchesWithErrorTracking(client, sqlFile)
}

/**
 * Process SQL file in batches with Azure-optimized error handling
 * @param {Object} client - Database client
 * @param {string} sqlFile - Path to SQL file
 */
async function loadDataInBatchesWithErrorTracking(client, sqlFile) {
  // Validate input
  if (!fs.existsSync(sqlFile)) {
    throw new Error(`SQL file not found: ${sqlFile}`)
  }

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
  let errorCount = 0
  let skippedSchemaCount = 0
  let successCount = 0
  const BATCH_SIZE = 200  // Optimized for Azure PostgreSQL
  const errorLogFile = `${sqlFile}.errors.log`
  
  // Timing variables for better reporting
  const startTime = Date.now()
  let lastProgressTime = Date.now()
  let lastRowCount = 0

  // Azure PostgreSQL has timeouts for long-running operations
  const MAX_EXECUTION_TIME = 3 * 60 * 60 * 1000 // 3 hours timeout (Azure's longest query timeout)
  const importTimeout = setTimeout(() => {
    logError('Import operation timeout exceeded - process terminated')
    process.exit(1)
  }, MAX_EXECUTION_TIME)

  fs.writeFileSync(errorLogFile, `SQL Error Log for ${sqlFile}\n${new Date().toISOString()}\n\n`, 'utf8')
  logInfo(`SQL errors will be logged to ${errorLogFile}`)

  // Error classifications
  const schemaErrorPatterns = {
    alreadyExists: /(relation|constraint|index|table|sequence) .* already exists/i,
    primaryKeyExists: /multiple primary keys for table .* are not allowed/i,
    duplicateKey: /duplicate key/i,
    cannotDrop: /cannot drop .* because other objects depend on it/i,
    insufficientPrivilege: /permission denied|insufficient privilege/i
  }

  await client.query('BEGIN')

  try {
    // Try to use session_replication_role for better performance
    try {
      await client.query('SET session_replication_role = replica')
      logInfo('Foreign key constraints and triggers temporarily disabled')
    } catch (err) {
      logInfo(`Note: Could not set session_replication_role: ${err.message}`)
      logInfo('Continuing with standard transaction - constraints will be enforced')
    }
    
    // Create monitoring timers
    const heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - lastProgressTime) / 1000)
      if (elapsedSec > 30) {
        logInfo(`Still processing - ${rowCount} rows so far (no change in last ${elapsedSec} seconds)`)
      }
    }, 30000)  // Log every 30 seconds of inactivity

    const memoryMonitor = setInterval(() => {
      const memoryUsage = process.memoryUsage()
      logInfo(`Memory usage: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memoryUsage.rss / 1024 / 1024)} MB (heap/total)`)
      
      // Check for potential memory issues in Azure environment
      const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
      if (heapUsedMB > 1000) { // 1GB warning threshold
        logInfo(`Memory usage approaching Azure Functions limit: ${Math.round(heapUsedMB)} MB`)
      }
    }, 60000) // Check every minute

    for await (const line of lineReader) {
      lineNum++

      if (statement === '') {
        statementStartLine = lineNum
      }

      // Skip comments
      if (line.trim().startsWith('--')) {
        continue
      }

      statement += line + '\n'

      // Process complete statements
      if (line.trim().endsWith(';')) {
        const statementType = getStatementType(statement);
        
        // ETL protection check (redundant safeguard)
        if (EXCLUDE_ETL_TABLES && isEtlTableStatement(statement)) {
          logInfo(`⚠️ ETL PROTECTION: Skipping operation on ETL table at line ${statementStartLine}`)
          fs.appendFileSync(errorLogFile, `\nETL PROTECTION: Skipped statement at line ${statementStartLine}:\n${statement}\n---\n`, 'utf8')
          statement = ''
          continue
        }

        try {
          // Special handling for schema objects in Azure PostgreSQL
          if (isSchemaStatement(statementType)) {
            try {
              await client.query(statement)
              successCount++
            } catch (err) {
              // Check for expected schema errors in Azure
              let isExpectedError = false;
              
              for (const [errorType, pattern] of Object.entries(schemaErrorPatterns)) {
                if (pattern.test(err.message)) {
                  logInfo(`Expected schema error (${errorType}): ${truncateString(err.message, 100)}`)
                  skippedSchemaCount++
                  isExpectedError = true
                  break
                }
              }
              
              if (!isExpectedError) {
                // Unexpected schema error - log but continue
                const errorMessage = `Schema Error at line ${statementStartLine}: ${err.message}`
                logInfo(errorMessage)
                fs.appendFileSync(errorLogFile, `\n${errorMessage}\n${statement}\n---\n`, 'utf8')
                errorCount++
              }
            }
          } else {
            // Data modification statement - standard processing
            await client.query(statement)
            
            // Count rows for INSERT statements
            if (statementType === 'INSERT') {
              // Simple heuristic to count rows in multi-value INSERT
              const valueMatches = statement.match(/VALUES\s*\(/gi)
              const rowsInStatement = valueMatches ? valueMatches.length : 1
              rowCount += rowsInStatement
            }
            
            batchSize++
            statementCount++
            successCount++
            
            // Progress updates
            const currentTime = Date.now()
            if (currentTime - lastProgressTime > 5000 || batchSize >= BATCH_SIZE) {
              const rowsPerSecond = Math.round((rowCount - lastRowCount) / ((currentTime - lastProgressTime) / 1000 || 1))
              const elapsedTime = Math.round((currentTime - startTime) / 1000)
              
              logInfo(`Processed ${rowCount} total rows (${rowsPerSecond} rows/sec) - ${Math.round(elapsedTime / 60)}m ${elapsedTime % 60}s elapsed`)
              
              lastProgressTime = currentTime
              lastRowCount = rowCount
            }

            // Batch commits to avoid Azure PostgreSQL transaction timeout
            if (batchSize >= BATCH_SIZE) {
              await client.query('COMMIT')
              await client.query('BEGIN')
              logInfo(`Committed batch - ${batchSize} statements (${rowCount} total rows)`)
              batchSize = 0
            }
          }
        } catch (err) {
          // Handle data errors
          const errorMessage = `SQL Error at line ${statementStartLine}: ${err.message}`
          logInfo(errorMessage)
          fs.appendFileSync(errorLogFile, `\n${errorMessage}\n${statement}\n---\n`, 'utf8')
          errorCount++
          
          // Check for severe errors that might require special handling
          const severeErrors = [
            'insufficient privilege',
            'permission denied',
            'terminating connection',
            'deadlock detected'
          ];
          
          if (severeErrors.some(e => err.message.toLowerCase().includes(e))) {
            logError(`Severe error detected - may require attention: ${err.message}`)
          }
        }
        
        statement = ''
      }
    }

    // Clean up all timers
    clearInterval(heartbeatTimer)
    clearInterval(memoryMonitor)
    clearTimeout(importTimeout)

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

    const totalTimeMin = Math.round((Date.now() - startTime) / 60000)
    
    // Final summary
    logInfo('\n===== SQL Execution Summary =====')
    logInfo(`✅ Execution complete: ${rowCount} rows in ${totalTimeMin} minutes`)
    logInfo(`✅ Successful statements: ${successCount}`)
    if (skippedSchemaCount > 0) {
      logInfo(`⚠️ Schema statements skipped: ${skippedSchemaCount} (objects already existed)`)
    }
    if (errorCount > 0) {
      logError(`❌ Errors encountered: ${errorCount} (see ${errorLogFile} for details)`)
    }
    logInfo('================================\n')

    return rowCount

  } catch (error) {
    // Major unhandled error
    clearTimeout(importTimeout)
    logError(`Critical error during execution: ${error.message}`)
    logError(error.stack)
    await client.query('ROLLBACK')
    throw error;
  }
}

/**
 * Check if statement operates on protected tables (ETL or Liquibase)
 */
function isEtlTableStatement(statement) {
  // Original ETL table check
  const etlTablePattern = new RegExp(
    `(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\\s+(?:public\\.)?("?${ETL_TABLE_PREFIX}[^"]*"?|${ETL_TABLE_PREFIX}[^\\s(]*)`, 'i'
  )
  
  // Check Liquibase tables
  const liquibasePattern = new RegExp(
    `(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\\s+(?:public\\.)?("?(${PROTECTED_TABLES.join('|')})[^"]*"?|(${PROTECTED_TABLES.join('|')})[^\\s(]*)`, 'i'
  )
  
  return etlTablePattern.test(statement) || liquibasePattern.test(statement)
}

/**
 * Get the type of SQL statement
 */
function getStatementType(statement) {
  const trimmedStmt = statement.trim().toUpperCase()
  
  if (trimmedStmt.startsWith('INSERT')) return 'INSERT'
  if (trimmedStmt.startsWith('UPDATE')) return 'UPDATE'
  if (trimmedStmt.startsWith('DELETE')) return 'DELETE'
  if (trimmedStmt.startsWith('CREATE TABLE')) return 'CREATE_TABLE'
  if (trimmedStmt.startsWith('CREATE INDEX')) return 'CREATE_INDEX'
  if (trimmedStmt.startsWith('CREATE SEQUENCE')) return 'CREATE_SEQUENCE'
  if (trimmedStmt.startsWith('CREATE')) return 'CREATE'
  if (trimmedStmt.startsWith('ALTER')) return 'ALTER'
  if (trimmedStmt.startsWith('DROP')) return 'DROP'
  if (trimmedStmt.startsWith('TRUNCATE')) return 'TRUNCATE'
  if (trimmedStmt.startsWith('SELECT')) return 'SELECT'
  if (trimmedStmt.startsWith('COPY')) return 'COPY'
  
  return 'OTHER'
}

/**
 * Check if a statement is schema-related
 */
function isSchemaStatement(type) {
  return [
    'CREATE_TABLE', 
    'CREATE_INDEX', 
    'CREATE_SEQUENCE', 
    'CREATE', 
    'ALTER', 
    'DROP'
  ].includes(type)
}

/**
 * Execute a single SQL statement with logging and ETL protection
 */
async function executeStatement(stmt, client, stats = {}, schemaOnly = false) {
  const queryType = getStatementType(stmt)

  // Skip data modification statements in schema-only mode
  if (schemaOnly && ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(queryType)) {
    stats.skipped = (stats.skipped || 0) + 1
    stats[`skipped_${queryType.toLowerCase()}`] = (stats[`skipped_${queryType.toLowerCase()}`] || 0) + 1
    return
  }

  // ETL protection check
  if (EXCLUDE_ETL_TABLES && isEtlTableStatement(stmt)) {
    stats.skippedEtl = (stats.skippedEtl || 0) + 1
    logInfo(`⚠️ ETL PROTECTION: Skipping operation on ETL table: ${truncateString(stmt, 100)}`)
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
      logInfo(`Long-running query (${duration}ms): ${truncateString(stmt, 100)}`)
    }

    return result
  } catch (error) {
    stats.errors = (stats.errors || 0) + 1
    logError(`Error executing statement: ${error.message}`)
    logInfo(`Statement: ${truncateString(stmt, 200)}`)
    throw error
  }
}

/**
 * Log execution statistics
 */
function logSkippedStatistics(stats) {
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
    logError(`❌ Errors: ${stats.errors}`)
  }

  if (stats.totalTimeMs) {
    logInfo(`⏱️ Total execution time: ${(stats.totalTimeMs / 1000).toFixed(2)} seconds`)
  }

  logInfo('--------------------------------')
}

/**
 * Truncate a string to a maximum length
 */
function truncateString(str, maxLength) {
  if (!str) return ''
  if (str.length <= maxLength) return str

  return str.substring(0, maxLength - 3) + '...'
}

module.exports = {
  executeSqlFile,
  loadDataInBatchesWithErrorTracking,
  executeStatement,
  logSkippedStatistics,
  truncateString
}