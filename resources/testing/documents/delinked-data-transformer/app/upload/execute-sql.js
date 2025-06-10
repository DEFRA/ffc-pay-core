const fs = require('fs')
const readline = require('readline')
const { logInfo, logError } = require('../util/logger')
const { EXCLUDE_ETL_TABLES, ETL_TABLE_PREFIX, PROTECTED_TABLES } = require('../constants/etl-protection')
const path = require('path')

/**
 * Execute an SQL file using batch processing with Azure-optimized error handling
 * @param {Object} client - Database client
 * @param {string} sqlFile - Path to SQL file
 */
async function executeSqlFile (client, sqlFile) {
  logInfo(`Executing SQL file: ${sqlFile}`)
  return loadDataInBatchesWithErrorTracking(client, sqlFile)
}

/**
 * Format file size in human readable format
 */
function formatFileSize (bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Process SQL file in batches with Azure-optimized error handling
 * @param {Object} client - Database client
 * @param {string} sqlFile - Path to SQL file
 */
async function loadDataInBatchesWithErrorTracking (client, sqlFile) {
  // Validate input
  if (!fs.existsSync(sqlFile)) {
    throw new Error(`SQL file not found: ${sqlFile}`)
  }

  // Get total file size for progress reporting
  const totalFileSize = fs.statSync(sqlFile).size
  let currentFilePosition = 0
  const fileName = path.basename(sqlFile)

  logInfo(`Starting SQL processing: ${formatFileSize(totalFileSize)} total file size for ${fileName}`)

  // Detect large files and use optimized processing strategy
  const isLargeFile = totalFileSize > 10 * 1024 * 1024 // 10MB
  if (isLargeFile) {
    logInfo(`Large SQL file detected (${formatFileSize(totalFileSize)}), using optimized processing`)
  }

  // Create error log
  const errorLogFile = `${sqlFile}.errors.log`
  const errorStream = fs.createWriteStream(errorLogFile)

  // Processing statistics
  const stats = {
    statementCount: 0,
    rowCount: 0,
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    ddlCount: 0,
    copyCount: 0,
    errorCount: 0,
    skippedCount: 0,
    protectedSkipped: 0,
    successCount: 0
  }

  // Timing variables
  const startTime = Date.now()
  let lastProgressTime = Date.now()
  let lastRowCount = 0
  let parsingCompleted = false
  let phaseStartTime = Date.now()
  let currentPhase = 'Initialization'

  // Set up heartbeat timer - runs every 10 seconds
  const heartbeatTimer = setInterval(() => {
    const currentTime = Date.now()
    const elapsedSec = Math.round((currentTime - lastProgressTime) / 1000)
    const totalElapsed = Math.round((currentTime - startTime) / 1000)

    // Only log if 30 seconds have passed without progress
    if (elapsedSec >= 30) {
      // Create detailed progress message based on current phase
      const phaseElapsed = Math.round((currentTime - phaseStartTime) / 1000)
      const memoryUsage = process.memoryUsage()
      const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024)
      const totalMemory = Math.round(memoryUsage.rss / 1024 / 1024)

      // Get phase-specific details
      let phaseDetails = ''
      let progressMetric = ''

      if (!parsingCompleted) {
        // File parsing phase
        const percentComplete = currentFilePosition > 0
          ? `${((currentFilePosition / totalFileSize) * 100).toFixed(1)}%`
          : 'initializing'

        phaseDetails = `SQL parsing at ${percentComplete}`
        progressMetric = `${formatFileSize(currentFilePosition)} of ${formatFileSize(totalFileSize)}`
      } else {
        // Execution phase
        phaseDetails = `Statement execution (${stats.statementCount} parsed)`
        progressMetric = `${stats.rowCount} rows, ${stats.insertCount} inserts, ${stats.errorCount} errors`
      }

      // Log comprehensive status
      logInfo(`⏳ PROGRESS REPORT [${currentPhase}]: ${phaseDetails}`)
      logInfo(`📊 File: ${fileName} | Progress: ${progressMetric} | Time: ${phaseElapsed}s in phase, ${totalElapsed}s total`)
      logInfo(`🔧 Memory: ${heapUsed}MB/${totalMemory}MB | Phase: ${currentPhase}`)

      // Reset timer only if actual progress was made since last check
      if (stats.rowCount > lastRowCount || currentFilePosition > 0) {
        lastProgressTime = currentTime
        lastRowCount = stats.rowCount
      }
    }
  }, 10000) // Check every 10 seconds

  try {
    // PHASE 1: Parse SQL into efficient statement batches
    updatePhase('SQL Parsing')
    const statements = await parseAndProcessSqlFile(
      sqlFile,
      (position) => { currentFilePosition = position },
      errorStream,
      isLargeFile
    )

    parsingCompleted = true
    stats.statementCount = statements.length
    logInfo(`Parsing complete: ${statements.length} SQL statements extracted in ${Math.round((Date.now() - phaseStartTime) / 1000)}s`)

    // PHASE 2: Execute statement batches
    updatePhase('SQL Execution')
    const BATCH_SIZE = isLargeFile ? 50 : 200 // Smaller batches for large files to prevent timeouts
    const batchCount = Math.ceil(statements.length / BATCH_SIZE)

    logInfo(`Starting execution: ${batchCount} batches of max ${BATCH_SIZE} statements each`)

    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      const batchStart = batchIndex * BATCH_SIZE
      const batchEnd = Math.min((batchIndex + 1) * BATCH_SIZE, statements.length)
      const currentBatch = statements.slice(batchStart, batchEnd)

      if (batchIndex % 5 === 0 || batchIndex === batchCount - 1) {
        logInfo(`Executing batch ${batchIndex + 1}/${batchCount} (${currentBatch.length} statements)`)
      }

      // Execute each statement in the batch
      const batchResults = await executeBatch(client, currentBatch, errorStream)

      // Update statistics
      stats.rowCount += batchResults.rowCount
      stats.errorCount += batchResults.errorCount
      stats.successCount += batchResults.successCount
      stats.insertCount += batchResults.insertCount
      stats.updateCount += batchResults.updateCount
      stats.deleteCount += batchResults.deleteCount
      stats.skippedCount += batchResults.skippedCount
      stats.protectedSkipped += batchResults.protectedSkipped

      // Log batch completion
      const currentTime = Date.now()
      const batchTime = Math.round((currentTime - phaseStartTime) / 1000)
      if (batchIndex % 5 === 0 || batchIndex === batchCount - 1 || stats.rowCount >= lastRowCount + 1000) {
        logInfo(`📊 Progress: ${stats.rowCount} rows (${stats.insertCount} inserts, ${stats.errorCount} errors) - Batch ${batchIndex + 1}/${batchCount}`)
        lastProgressTime = currentTime
        lastRowCount = stats.rowCount
      }
    }

    // Final stats
    const totalDuration = Math.round((Date.now() - startTime) / 1000)
    logInfo(`✅ SQL execution complete in ${totalDuration}s: ${stats.rowCount} rows affected, ${stats.errorCount} errors`)

    return stats.rowCount
  } catch (error) {
    const totalDuration = Math.round((Date.now() - startTime) / 1000)
    logError(`❌ SQL execution failed after ${totalDuration}s: ${error.message}`)
    errorStream.write(`FATAL ERROR: ${error.message}\n${error.stack}\n`)
    throw error
  } finally {
    clearInterval(heartbeatTimer)
    errorStream.end()
  }

  // Helper function to update the current phase
  function updatePhase (phase) {
    currentPhase = phase
    phaseStartTime = Date.now()
    logInfo(`Starting phase: ${phase}`)
  }
}

/**
 * Parse SQL file into discrete executable statements with efficient streaming
 * @param {string} sqlFile Path to SQL file
 * @param {function} progressCallback Callback with current position
 * @param {WriteStream} errorStream Error log stream
 * @param {boolean} isLargeFile Flag for large file optimizations
 * @returns {Promise<string[]>} Array of SQL statements
 */
async function parseAndProcessSqlFile (sqlFile, progressCallback, errorStream, isLargeFile = false) {
  return new Promise((resolve, reject) => {
    // Streaming setup
    const fileStream = fs.createReadStream(sqlFile, {
      encoding: 'utf8',
      highWaterMark: isLargeFile ? 1024 * 1024 : 256 * 1024 // 1MB chunks for large files, 256KB for smaller ones
    })

    const statements = []
    let currentStatement = ''
    let inComment = false
    let inSingleQuote = false
    let inDoubleQuote = false
    let escapeNext = false
    let lineNum = 0
    let currentPosition = 0
    const reportingThreshold = isLargeFile ? 2 * 1024 * 1024 : 512 * 1024 // 2MB or 512KB
    let lastReportedPosition = 0

    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
      highWaterMark: isLargeFile ? 1024 * 1024 : 256 * 1024
    })

    rl.on('line', (line) => {
      lineNum++
      currentPosition += line.length + 1 // +1 for the newline

      if (currentPosition - lastReportedPosition > reportingThreshold) {
        progressCallback(currentPosition)
        lastReportedPosition = currentPosition
      }

      // Skip empty lines and comments
      if (line.trim() === '' || line.trim().startsWith('--')) {
        return
      }

      // Add line to current statement
      currentStatement += line + '\n'

      // Check for statement termination (properly handling quotes and comments)
      // This is a simplified version, a full SQL parser would be more robust
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        const nextChar = i < line.length - 1 ? line[i + 1] : null

        if (escapeNext) {
          escapeNext = false
          continue
        }

        // Handle escape characters
        if (char === '\\') {
          escapeNext = true
          continue
        }

        // Handle comments
        if (!inSingleQuote && !inDoubleQuote) {
          // Start of multi-line comment
          if (char === '/' && nextChar === '*') {
            inComment = true
            i++
            continue
          }

          // End of multi-line comment
          if (inComment && char === '*' && nextChar === '/') {
            inComment = false
            i++
            continue
          }

          // Line comment - skip rest of line
          if (char === '-' && nextChar === '-') {
            break
          }
        }

        // Skip content inside comments
        if (inComment) continue

        // Handle quotes
        if (char === '\'' && !inDoubleQuote && !escapeNext) {
          inSingleQuote = !inSingleQuote
          continue
        }

        if (char === '"' && !inSingleQuote && !escapeNext) {
          inDoubleQuote = !inDoubleQuote
          continue
        }

        // Statement terminator found outside quotes
        if (char === ';' && !inSingleQuote && !inDoubleQuote) {
          // Extract the actual statement
          const statement = currentStatement.trim()

          // Don't add empty statements
          if (statement !== '' && statement !== ';') {
            statements.push(statement)
          }

          // Reset for next statement
          currentStatement = ''
        }
      }
    })

    rl.on('close', () => {
      // Check if there's an unterminated statement left
      if (currentStatement.trim() !== '') {
        // If statement doesn't end with semicolon, add it to make it valid
        if (!currentStatement.trim().endsWith(';')) {
          currentStatement = currentStatement.trim() + ';'
        }
        statements.push(currentStatement.trim())
      }

      progressCallback(currentPosition) // Final position report
      logInfo(`SQL parsing complete: ${statements.length} statements, ${currentPosition} bytes processed`)
      resolve(statements)
    })

    rl.on('error', (err) => {
      errorStream.write(`ERROR parsing SQL file: ${err.message}\n`)
      reject(err)
    })
  })
}

/**
 * Execute a batch of SQL statements
 * @param {Object} client PostgreSQL client
 * @param {string[]} statements Array of SQL statements
 * @param {WriteStream} errorStream Error log stream
 * @returns {Object} Batch execution results
 */
async function executeBatch (client, statements, errorStream) {
  // Results tracking
  const results = {
    rowCount: 0,
    errorCount: 0,
    successCount: 0,
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    skippedCount: 0,
    protectedSkipped: 0
  }

  // Process each statement in sequence (not in parallel to maintain order)
  for (const statement of statements) {
    try {
      // Check for protected tables (ETL or Liquibase)
      if (isProtectedTableStatement(statement)) {
        results.protectedSkipped++
        continue
      }

      // Skip DDL in data-only mode (if enabled)
      const stmtType = getStatementType(statement)
      if (isSchemaStatement(stmtType)) {
        results.skippedCount++
        continue
      }

      // Execute the statement
      const result = await client.query(statement)

      // Update statistics based on statement type
      results.successCount++

      // Count rows affected
      const rowCount = result.rowCount || 0
      results.rowCount += rowCount

      // Track statement types
      switch (stmtType) {
        case 'INSERT':
          results.insertCount++
          break
        case 'UPDATE':
          results.updateCount++
          break
        case 'DELETE':
          results.deleteCount++
          break
      }
    } catch (error) {
      results.errorCount++

      // Log error details
      const errorMessage = `ERROR in SQL statement: ${error.message}\nStatement: ${truncateString(statement, 500)}`
      errorStream.write(errorMessage + '\n')

      // Don't fail on individual statement errors to allow best-effort completion
      logError(`SQL error (continuing): ${error.message.substring(0, 100)}${error.message.length > 100 ? '...' : ''}`)
    }
  }

  return results
}

/**
 * Check if statement operates on protected tables (ETL or Liquibase)
 * @param {string} statement SQL statement
 * @returns {boolean} True if statement accesses protected tables
 */
function isProtectedTableStatement (statement) {
  // Unified check for ETL tables
  const etlPattern = new RegExp(
    `(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\\s+(?:public\\.)?(["']?${ETL_TABLE_PREFIX}[^"']*["']?|${ETL_TABLE_PREFIX}[^\\s(]*)`,
    'i'
  )

  // Check for Liquibase tables
  const liquibaseTablesPattern = new RegExp(
    `(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\\s+(?:public\\.)?("?(${PROTECTED_TABLES.join('|')})"?|(${PROTECTED_TABLES.join('|')})[\\s,);])`,
    'i'
  )

  return etlPattern.test(statement) || liquibaseTablesPattern.test(statement)
}

/**
 * Get the type of SQL statement
 * @param {string} statement SQL statement
 * @returns {string} Statement type (INSERT, UPDATE, etc)
 */
function getStatementType (statement) {
  const trimmed = statement.trim().toUpperCase()

  if (trimmed.startsWith('INSERT')) return 'INSERT'
  if (trimmed.startsWith('UPDATE')) return 'UPDATE'
  if (trimmed.startsWith('DELETE')) return 'DELETE'
  if (trimmed.startsWith('CREATE TABLE')) return 'CREATE_TABLE'
  if (trimmed.startsWith('DROP TABLE')) return 'DROP_TABLE'
  if (trimmed.startsWith('ALTER TABLE')) return 'ALTER_TABLE'
  if (trimmed.startsWith('CREATE INDEX')) return 'CREATE_INDEX'
  if (trimmed.startsWith('DROP INDEX')) return 'DROP_INDEX'
  if (trimmed.startsWith('TRUNCATE')) return 'TRUNCATE'
  if (trimmed.startsWith('COPY')) return 'COPY'
  if (trimmed.startsWith('SELECT')) return 'SELECT'

  return 'OTHER'
}

/**
 * Check if a statement is schema-related
 * @param {string} type Statement type
 * @returns {boolean} True if statement modifies schema
 */
function isSchemaStatement (type) {
  return ['CREATE_TABLE', 'DROP_TABLE', 'ALTER_TABLE', 'CREATE_INDEX', 'DROP_INDEX'].includes(type)
}

/**
 * Truncate a string to a maximum length
 * @param {string} str String to truncate
 * @param {number} maxLength Maximum length
 * @returns {string} Truncated string
 */
function truncateString (str, maxLength) {
  if (str.length <= maxLength) return str
  return str.substring(0, maxLength) + '...'
}

module.exports = {
  executeSqlFile,
  loadDataInBatchesWithErrorTracking,
  parseAndProcessSqlFile,
  isProtectedTableStatement,
  getStatementType,
  isSchemaStatement,
  truncateString,
  formatFileSize
}
