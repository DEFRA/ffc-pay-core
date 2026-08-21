const fs = require('fs')
const readline = require('readline')
const { logInfo, logError } = require('../util/logger')
const { getSchemaInfo } = require('./schema-validator')
const { EXCLUDE_ETL_TABLES, ETL_TABLE_PREFIX, PROTECTED_TABLES } = require('../constants/etl-protection')
const path = require('path')

/**
 * Async generator: yields SQL statements from a file, streaming and batching-friendly.
 */
async function * streamSqlStatements (sqlFile, progressCallback, isLargeFile = false) {
  const fileStream = fs.createReadStream(sqlFile, {
    encoding: 'utf8',
    highWaterMark: isLargeFile ? 1024 * 1024 : 256 * 1024
  })

  let currentStatement = ''
  let inComment = false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escapeNext = false
  let currentPosition = 0
  let lastReportedPosition = 0
  const reportingThreshold = isLargeFile ? 2 * 1024 * 1024 : 512 * 1024

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })

  for await (const line of rl) {
    currentPosition += line.length + 1
    if (progressCallback && currentPosition - lastReportedPosition > reportingThreshold) {
      progressCallback(currentPosition)
      lastReportedPosition = currentPosition
    }
    if (line.trim() === '' || line.trim().startsWith('--')) continue
    currentStatement += line + '\n'
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const nextChar = i < line.length - 1 ? line[i + 1] : null
      if (escapeNext) { escapeNext = false; continue }
      if (char === '\\') { escapeNext = true; continue }
      if (!inSingleQuote && !inDoubleQuote) {
        if (char === '/' && nextChar === '*') { inComment = true; i++; continue }
        if (inComment && char === '*' && nextChar === '/') { inComment = false; i++; continue }
        if (char === '-' && nextChar === '-') break
      }
      if (inComment) continue
      if (char === '\'' && !inDoubleQuote && !escapeNext) { inSingleQuote = !inSingleQuote; continue }
      if (char === '"' && !inSingleQuote && !escapeNext) { inDoubleQuote = !inDoubleQuote; continue }
      if (char === ';' && !inSingleQuote && !inDoubleQuote) {
        const statement = currentStatement.trim()
        if (statement && statement !== ';') yield statement
        currentStatement = ''
      }
    }
  }
  if (currentStatement.trim() !== '') {
    if (!currentStatement.trim().endsWith(';')) currentStatement = currentStatement.trim() + ';'
    yield currentStatement.trim()
  }
}

/**
 * Stream and execute SQL file in batches, never holding all statements in memory.
 */
async function streamAndExecuteSqlFile (
  client,
  sqlFile,
  errorStream,
  batchSize = 200,
  isLargeFile = false,
  progressCallback
) {
  let batch = []
  const totalStats = {
    rowCount: 0,
    errorCount: 0,
    successCount: 0,
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    skippedCount: 0,
    protectedSkipped: 0
  }
  let statementCount = 0
  let batchIndex = 0

  for await (const statement of streamSqlStatements(sqlFile, progressCallback, isLargeFile)) {
    batch.push(statement)
    statementCount++
    if (batch.length >= batchSize) {
      const batchResults = await executeBatch(client, batch, errorStream, batchIndex)
      Object.keys(totalStats).forEach(k => totalStats[k] += batchResults[k] || 0)
      logInfo(
        `Batch ${batchIndex + 1}: ${batch.length} statements processed. Successes: ${batchResults.successCount}, Errors: ${batchResults.errorCount}, Skipped: ${batchResults.skippedCount}, Protected Skipped: ${batchResults.protectedSkipped}`
      )
      batchIndex++
      batch = []
    }
  }
  // Final batch
  if (batch.length > 0) {
    const batchResults = await executeBatch(client, batch, errorStream, batchIndex)
    Object.keys(totalStats).forEach(k => totalStats[k] += batchResults[k] || 0)
    logInfo(
      `Batch ${batchIndex + 1} (final): ${batch.length} statements processed. Successes: ${batchResults.successCount}, Errors: ${batchResults.errorCount}, Skipped: ${batchResults.skippedCount}, Protected Skipped: ${batchResults.protectedSkipped}`
    )
  }
  totalStats.statementCount = statementCount

  // Summary logging
  logInfo(
    `SQL streaming execution complete: ${totalStats.statementCount} statements, ${totalStats.rowCount} rows, ${totalStats.successCount} successes, ${totalStats.errorCount} errors, ${totalStats.skippedCount} skipped, ${totalStats.protectedSkipped} protected skipped`
  )

  return totalStats
}

async function executeSqlFile (client, sqlFile) {
  logInfo(`Executing SQL file: ${sqlFile}`)
  return loadDataInBatchesWithErrorTracking(client, sqlFile)
}

function formatFileSize (bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

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

  const isLargeFile = totalFileSize > 10 * 1024 * 1024 // 10MB
  if (isLargeFile) {
    logInfo(`Large SQL file detected (${formatFileSize(totalFileSize)}), using optimized processing`)
  }

  const errorLogFile = `${sqlFile}.errors.log`
  const errorStream = fs.createWriteStream(errorLogFile)

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

  const startTime = Date.now()
  let lastProgressTime = Date.now()
  let lastRowCount = 0
  let parsingCompleted = false
  let phaseStartTime = Date.now()
  let currentPhase = 'Initialization'

  const heartbeatTimer = setInterval(() => {
    const currentTime = Date.now()
    const elapsedSec = Math.round((currentTime - lastProgressTime) / 1000)
    const totalElapsed = Math.round((currentTime - startTime) / 1000)

    if (elapsedSec >= 30) {
      // Create detailed progress message based on current phase
      const phaseElapsed = Math.round((currentTime - phaseStartTime) / 1000)
      const memoryUsage = process.memoryUsage()
      const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024)
      const totalMemory = Math.round(memoryUsage.rss / 1024 / 1024)

      let phaseDetails = ''
      let progressMetric = ''

      if (!parsingCompleted) {
        const percentComplete = currentFilePosition > 0
          ? `${((currentFilePosition / totalFileSize) * 100).toFixed(1)}%`
          : 'initializing'

        phaseDetails = `SQL parsing at ${percentComplete}`
        progressMetric = `${formatFileSize(currentFilePosition)} of ${formatFileSize(totalFileSize)}`
      } else {
        phaseDetails = `Statement execution (${stats.statementCount} parsed)`
        progressMetric = `${stats.rowCount} rows, ${stats.insertCount} inserts, ${stats.errorCount} errors`
      }

      logInfo(`⏳ PROGRESS REPORT [${currentPhase}]: ${phaseDetails}`)
      logInfo(`📊 File: ${fileName} | Progress: ${progressMetric} | Time: ${phaseElapsed}s in phase, ${totalElapsed}s total`)
      logInfo(`🔧 Memory: ${heapUsed}MB/${totalMemory}MB | Phase: ${currentPhase}`)

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
      const batch = statements.slice(batchStart, batchEnd)

      if (batchIndex % 5 === 0 || batchIndex === batchCount - 1) {
        logInfo(`Executing batch ${batchIndex + 1}/${batchCount} (${batch.length} statements)`)
      }

      // Execute each statement in the batch
      const batchResults = await executeBatch(client, batch, errorStream)

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

async function executeBatch (client, statements, errorStream, batchIndex = '?') {
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

  for (const statement of statements) {
    try {
      // Optional: validate statement before execution
      if (typeof validateAndTransformSqlStatement === 'function') {
        const validationResult = await validateAndTransformSqlStatement(statement, client)
        if (validationResult && !validationResult.isValid) {
          results.skippedCount++
          errorStream.write(`SKIPPED: ${validationResult.reason}\nStatement: ${truncateString(statement, 1000)}\n`)
          logInfo(`Skipped statement: ${validationResult.reason}`)
          continue
        }
      }

      if (isProtectedTableStatement(statement)) {
        results.protectedSkipped++
        continue
      }

      const stmtType = getStatementType(statement)
      if (isSchemaStatement(stmtType)) {
        results.skippedCount++
        continue
      }

      const result = await client.query(statement)
      results.successCount++
      const rowCount = result.rowCount || 0
      results.rowCount += rowCount

      switch (stmtType) {
        case 'INSERT': results.insertCount++; break
        case 'UPDATE': results.updateCount++; break
        case 'DELETE': results.deleteCount++; break
      }
    } catch (error) {
      results.errorCount++
      let extraDetails = ''
      if (error.message.includes('value too long for type character varying')) {
        extraDetails = ' [Possible column length violation]'
      }
      if (error.message.includes('violates foreign key constraint')) {
        extraDetails = ' [Foreign key violation]'
      }
      // Extract table name for logging
      let tableName = ''
      const match = statement.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+["']?([a-zA-Z0-9_]+)["']?/i)
      if (match && match[2]) tableName = match[2]
      const errorMessage = `Batch ${batchIndex}${tableName ? ', Table: ' + tableName : ''}, Error: ${error.message}${extraDetails}\nStatement: ${truncateString(statement, 1000)}`
      errorStream.write(errorMessage + '\n')
      logError(errorMessage)
    }
  }

  return results
}

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

function isSchemaStatement (type) {
  return ['CREATE_TABLE', 'DROP_TABLE', 'ALTER_TABLE', 'CREATE_INDEX', 'DROP_INDEX'].includes(type)
}

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
  formatFileSize,
  streamAndExecuteSqlFile,
  streamSqlStatements
}
