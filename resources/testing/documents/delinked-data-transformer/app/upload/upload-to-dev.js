const { createConnection, listDatabases } = require('../database/db-connection')
const { findSqlDumpFiles, safeRemoveFile } = require('../util/file-utils')
const { logInfo, logError } = require('../util/logger')
const { processForAzure } = require('../transform/sql-processor')
const { loadDataInBatchesWithErrorTracking } = require('./execute-sql')
const { ETL_TABLE_PREFIX, PROTECTED_TABLES } = require('../constants/etl-protection')
const fs = require('fs')
const os = require('os')

/**
 * Main function to handle database restoration to dev environments
 * Optimized for Azure PostgreSQL
 */
async function uploadToDev () {
  logInfo('Starting database restoration process (data-only approach)...')
  logInfo(`Running on ${os.hostname()} with Node.js ${process.version}`)
  logInfo(`System resources: ${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB RAM`)

  try {
    logInfo('--- Database Discovery ---')
    // Look for both test and dev databases
    const targetDatabases = await listDatabases(['ffc-doc-%-dev', 'ffc-pay-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-test'])
    logInfo(`Found ${targetDatabases.length} available target databases:`)
    logInfo(targetDatabases)
    logInfo('------------------------')
  } catch (err) {
    logError(`Database discovery failed: ${err.message}`)
  }

  const databaseFiles = findSqlDumpFiles()
  logInfo(`Found ${databaseFiles.length} database files to process`)

  let successCount = 0
  let errorCount = 0
  const startTime = Date.now()

  for (const { sourceDbName, targetDbName, filePath } of databaseFiles) {
    const dbStartTime = Date.now()
    logInfo(`\n📦 Processing database: ${sourceDbName}`)
    logInfo(`File: ${filePath}`)
    logInfo(`Target DB: ${targetDbName}`)

    let client
    try {
      logInfo(`Connecting to ${targetDbName}...`)
      client = await createConnection(targetDbName)

      const { rows } = await client.query(
        'SELECT current_database(), current_user, version(), current_timestamp'
      )

      logInfo('=== Connection Details ===')
      logInfo(`Database: ${rows[0].current_database}`)
      logInfo(`User: ${rows[0].current_user}`)
      logInfo(`PostgreSQL: ${rows[0].version.split(',')[0]}`)
      logInfo(`Connection time: ${rows[0].current_timestamp}`)
      logInfo('========================')

      // Step 2: Schema verification
      const schemaExists = await verifySchema(client, targetDbName)

      // Step 3: Clear existing data before import
      await clearDatabaseSimple(client)

      // Step 4: Process SQL file
      // Removed duplicate processing message
      const dataOnlyMode = schemaExists
      if (dataOnlyMode) {
        logInfo('Schema already exists - processing for data-only import')
      }

      logInfo(`Processing SQL dump file: ${filePath} (${formatFileSize(fs.statSync(filePath).size)})`)

      const processingResult = await withStallDetection(
        () => processForAzure(filePath, sourceDbName, targetDbName, dataOnlyMode),
        'SQL processing',
        120 // 2 minute stall threshold
      )

      const { processedFilePath, stats } = processingResult

      logInfo(`SQL file processed: ${stats.copyBlocksConverted} COPY blocks, ${stats.copyRowsConverted} rows converted`)
      logInfo(`Processed file size: ${formatFileSize(fs.statSync(processedFilePath).size)}`)

      // Check if the dataset is large and needs special handling
      const MAX_ROWS_PER_TRANSACTION = 50000
      if (stats.copyRowsConverted > MAX_ROWS_PER_TRANSACTION) {
        logInfo(`Large dataset detected (${stats.copyRowsConverted} rows), implementing batched processing`)
      }

      // Step 5: Execute SQL
      const insertCount = await withStallDetection(
        () => loadDataInBatchesWithErrorTracking(client, processedFilePath),
        'SQL execution',
        180 // 3 minute stall threshold
      )

      const dbDuration = Math.round((Date.now() - dbStartTime) / 1000)
      logInfo(`✅ Successfully restored ${sourceDbName} to ${targetDbName}`)
      logInfo(`📊 Results: ${insertCount} rows inserted in ${formatDuration(dbDuration)}`)

      // Clean up temp files
      safeRemoveFile(processedFilePath)
      successCount++
    } catch (error) {
      logError(`❌ Error processing ${sourceDbName}: ${error.message}`)
      logError(error.stack)
      errorCount++
    } finally {
      if (client) {
        try {
          // Check which method is available for this connection type
          if (typeof client.release === 'function') {
            // For connection pools
            client.release()
            logInfo(`Released connection to ${targetDbName}`)
          } else if (typeof client.end === 'function') {
            // For direct clients
            await client.end()
            logInfo(`Disconnected from ${targetDbName}`)
          }
        } catch (e) {
          logError(`Error disconnecting: ${e.message}`)
        }
      }
    }
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000)
  logInfo('\n======== Database Restoration Summary ========')
  logInfo(`Total time: ${formatDuration(totalDuration)}`)
  logInfo(`✅ Success: ${successCount} databases`)
  if (errorCount) logInfo(`❌ Failures: ${errorCount} databases`)
  logInfo('==========================================')

  return errorCount === 0
}

async function withStallDetection (fn, operationName, stallThresholdSec = 120) {
  let lastActivityTime = Date.now()
  let isComplete = false

  // Create heartbeat function to check for stalls
  const stallDetector = setInterval(() => {
    const stallTime = Math.round((Date.now() - lastActivityTime) / 1000)

    if (stallTime > stallThresholdSec && !isComplete) {
      logInfo(`⚠️ Possible stall detected in ${operationName} (${stallTime} seconds without progress)`)
      logInfo(`Current memory usage: ${formatFileSize(process.memoryUsage().heapUsed)} heap / ${formatFileSize(process.memoryUsage().rss)} total`)

      // For Azure PostgreSQL, long-running operations might be throttled
      if (stallTime > stallThresholdSec * 2) {
        logInfo(`⚠️ Extended stall in ${operationName} - check Azure portal for resource limitations or throttling events`)
      }
    }
  }, 30000) // Check every 30 seconds

  // Progress monitoring function wrapper
  const updateActivity = () => { lastActivityTime = Date.now() }
  const originalLog = console.log
  console.log = (...args) => {
    updateActivity()
    originalLog.apply(console, args)
  }

  try {
    // Run the actual function
    const result = await fn()
    isComplete = true
    return result
  } finally {
    // Cleanup
    clearInterval(stallDetector)
    console.log = originalLog
  }
}

async function verifySchema (client, dbName) {
  // Check if essential tables exist
  const { rows } = await client.query(`
    SELECT COUNT(*) as table_count
    FROM pg_tables
    WHERE schemaname = 'public'
  `)

  const tableCount = parseInt(rows[0].table_count)
  logInfo(`Found ${tableCount} tables in target database`)

  return tableCount > 0
}

/**
 * Extract schema-only SQL from a full dump
 */
async function extractSchemaOnly (sqlFile, targetDb) {
  const outputFile = `/tmp/schema_only_${targetDb}_${Date.now()}.sql`
  const writeStream = fs.createWriteStream(outputFile)

  return new Promise((resolve, reject) => {
    const lineReader = require('readline').createInterface({
      input: fs.createReadStream(sqlFile, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    const statement = ''
    let inCopy = false
    let statementCount = 0

    writeStream.write('-- SCHEMA ONLY IMPORT\n\n')

    lineReader.on('line', (line) => {
      // Skip COPY data blocks
      if (line.startsWith('COPY ')) {
        inCopy = true
        writeStream.write(line + '\n')
        return
      }

      if (inCopy) {
        if (line === '\\.') {
          inCopy = false
          writeStream.write(line + '\n')
        }
        return
      }

      // Skip INSERT statements
      if (line.trim().startsWith('INSERT INTO')) {
        return
      }

      // Include CREATE TABLE and other schema statements
      writeStream.write(line + '\n')
      if (line.includes('CREATE TABLE') || line.includes('CREATE INDEX')) {
        statementCount++
      }
    })

    lineReader.on('close', () => {
      writeStream.end()
      logInfo(`Schema extracted to ${outputFile} (${statementCount} schema objects)`)
      resolve(outputFile)
    })

    lineReader.on('error', reject)
    writeStream.on('error', reject)
  })
}

/**
 * Applies schema to target database
 */
async function applySchema (client, schemaFile) {
  logInfo('Applying schema to target database')

  const lineReader = require('readline').createInterface({
    input: fs.createReadStream(schemaFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let statement = ''
  let successCount = 0
  let errorCount = 0

  await client.query('BEGIN')

  for await (const line of lineReader) {
    // Skip comments
    if (line.trim().startsWith('--')) {
      continue
    }

    statement += line + '\n'

    if (line.trim().endsWith(';')) {
      try {
        await client.query(statement)
        successCount++
      } catch (err) {
        // Ignore errors for now - some might be expected
        errorCount++
      }
      statement = ''
    }
  }

  await client.query('COMMIT')
  logInfo(`Schema applied: ${successCount} statements executed, ${errorCount} errors (warnings)`)
}

/**
 * Clears all data from database tables while respecting ETL and liquibase protection
 */
async function clearDatabaseSimple (client) {
  try {
    // Step 1: Get all tables
    const { rows } = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
    `)

    if (rows.length === 0) {
      logInfo('No tables found to clear')
      return
    }

    logInfo(`Found ${rows.length} tables in database`)

    // Filter out ETL tables and Liquibase tables
    const tablesToClear = rows.filter(row => {
      const isEtlTable = row.tablename.toLowerCase().startsWith(ETL_TABLE_PREFIX) ||
                         row.tablename.startsWith(ETL_TABLE_PREFIX.toUpperCase())
      const isLiquibaseTable = PROTECTED_TABLES.includes(row.tablename.toLowerCase())

      if (isEtlTable) {
        logInfo(`⚠️ ETL PROTECTION: Skipping ETL table: ${row.tablename}`)
        return false
      }

      if (isLiquibaseTable) {
        logInfo(`⚠️ LIQUIBASE PROTECTION: Skipping Liquibase table: ${row.tablename}`)
        return false
      }

      return true
    })

    logInfo(`After ETL protection, will clear ${tablesToClear.length} of ${rows.length} tables`)

    // Step 2: Begin transaction
    await client.query('BEGIN')

    // Step 3: Get table relationships to determine proper deletion order
    const { rows: tableRelationships } = await client.query(`
      SELECT 
        tc.table_name, 
        ccu.table_name AS referenced_table
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
      WHERE 
        tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_schema = 'public'
    `)

    const dependencyGraph = {}
    for (const { tablename } of tablesToClear) {
      dependencyGraph[tablename] = []
    }

    for (const rel of tableRelationships) {
      if (dependencyGraph[rel.table_name] && dependencyGraph[rel.referenced_table]) {
        dependencyGraph[rel.table_name].push(rel.referenced_table)
      }
    }

    // Find tables with no dependencies first
    const processOrder = []
    const visited = new Set()

    const visit = (table) => {
      if (visited.has(table)) return
      visited.add(table)

      if (dependencyGraph[table]) {
        for (const dependency of dependencyGraph[table]) {
          visit(dependency)
        }
      }

      processOrder.push(table)
    }

    for (const table in dependencyGraph) {
      if (!visited.has(table)) {
        visit(table)
      }
    }

    // Now process in reverse order (leaf nodes first)
    for (const tablename of processOrder.reverse()) {
      try {
        // Try Azure-optimized truncation first
        await client.query(`TRUNCATE TABLE "${tablename}" CASCADE`)
        logInfo(`Cleared table: ${tablename}`)
      } catch (err) {
        logInfo(`Note: Could not clear table ${tablename}: ${err.message}. Trying alternative approach.`)
        try {
          // On Azure PostgreSQL, sometimes DELETE works better than TRUNCATE
          await client.query(`DELETE FROM "${tablename}"`)
          logInfo(`Cleared table: ${tablename} (using DELETE)`)
        } catch (err2) {
          logError(`Failed to clear table ${tablename}: ${err2.message}`)
        }
      }
    }

    await client.query('COMMIT')
    logInfo('Tables cleared successfully')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * Format file size in human readable format
 */
function formatFileSize (bytes) {
  if (bytes < 1024) return bytes + ' bytes'
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

/**
 * Format duration in human readable format
 */
function formatDuration (seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

module.exports = {
  uploadToDev,
  extractSchemaOnly,
  applySchema,
  clearDatabaseSimple
}

// Allow direct execution
if (require.main === module) {
  uploadToDev()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      logError(`Upload process failed: ${error}`)
      process.exit(1)
    })
}
