const { createConnection, listDatabases } = require('../database/db-connection')
const { findSqlDumpFiles, safeRemoveFile } = require('../util/file-utils')
const { logInfo, logError, logWarning } = require('../util/logger')
const { processForAzure } = require('../transform/sql-processor')
const { streamAndExecuteSqlFile } = require('./execute-sql') // <-- use streaming batch execution
const { ETL_TABLE_PREFIX, PROTECTED_TABLES } = require('../constants/etl-protection')
const { loadInDependencyOrder } = require('./dependency-loader')
const { backupDatabase } = require('../database/backup-and-restore')
const fs = require('fs')
const os = require('os')

async function uploadToDev (type = 'all', dryRun = false) {
  if (dryRun) {
    logInfo('🔍 DRY RUN MODE: All operations will be simulated without making actual changes')
  }

  // OOM and error catch-all
  const failedUploads = []
  process.on('uncaughtException', (err) => {
    if (err && err.message && err.message.includes('JavaScript heap out of memory')) {
      logError('❌ Out of memory error detected. Skipping current upload and moving to next.')
    } else {
      logError(`❌ Uncaught Exception: ${err.message}`)
    }
  })
  process.on('unhandledRejection', (reason) => {
    logError(`❌ Unhandled Rejection: ${reason}`)
  })

  logInfo(`Starting database restoration process for type: ${type} (data-only approach)...`)
  logInfo(`Running on ${os.hostname()} with Node.js ${process.version}`)
  logInfo(`System resources: ${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB RAM`)

  let dbPatterns = []
  if (type === 'ffc-pay') dbPatterns = ['ffc-pay-%-dev', 'ffc-pay-%-test']
  else if (type === 'ffc-doc') dbPatterns = ['ffc-doc-%-dev', 'ffc-doc-%-test']
  else dbPatterns = ['ffc-doc-%-dev', 'ffc-pay-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-test']

  let targetDatabases = []
  try {
    logInfo('--- Database Discovery ---')
    targetDatabases = await listDatabases(dbPatterns)
    logInfo(`Found ${targetDatabases.length} available target databases:`)
    logInfo(targetDatabases)
    logInfo('------------------------')
  } catch (err) {
    logError(`Database discovery failed: ${err.message}`)
  }

  const databaseFiles = findSqlDumpFiles().filter(({ sourceDbName }) => {
    if (type === 'ffc-pay') return sourceDbName.startsWith('ffc-pay')
    if (type === 'ffc-doc') return sourceDbName.startsWith('ffc-doc')
    return true
  })
  logInfo(`Found ${databaseFiles.length} database files to process for type: ${type}`)

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
      if (!dryRun) {
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
      } else {
        logInfo('[DRY RUN] Would connect to database and retrieve connection details')
      }

      let schemaExists = false
      if (!dryRun) {
        schemaExists = await verifySchema(client, targetDbName)
      } else {
        logInfo('[DRY RUN] Would verify schema existence')
        schemaExists = true // Assume schema exists for dry run
      }

      if (!dryRun) {
        await backupDatabase(targetDbName, '../dev-backups')
      } else {
        logInfo(`[DRY RUN] Would backup database ${targetDbName} to 'dev-backups'`)
      }

      if (!dryRun) {
        await clearDatabaseSimple(client, dryRun)
      } else {
        logInfo('[DRY RUN] Would clear database tables while preserving schema and respecting ETL/Liquibase protections')
      }

      const dataOnlyMode = schemaExists
      if (dataOnlyMode) {
        logInfo('Schema already exists - processing for data-only import')
      }

      logInfo(`Processing SQL dump file: ${filePath} (${formatFileSize(fs.statSync(filePath).size)})`)

      let processingResult
      if (!dryRun) {
        processingResult = await withStallDetection(
          () => processForAzure(filePath, sourceDbName, targetDbName, dataOnlyMode, dryRun),
          'SQL processing',
          120 // 2 minute stall threshold
        )
      } else {
        logInfo('[DRY RUN] Would process SQL file for Azure compatibility')
        processingResult = {
          processedFilePath: `${filePath}.processed`,
          stats: {
            copyBlocksConverted: 'X',
            copyRowsConverted: 1000 // Mock value for dry run
          }
        }
      }

      const { processedFilePath, stats } = processingResult

      logInfo(`SQL file processed: ${stats.copyBlocksConverted} COPY blocks, ${stats.copyRowsConverted} rows converted`)
      if (!dryRun) {
        logInfo(`Processed file size: ${formatFileSize(fs.statSync(processedFilePath).size)}`)
      } else {
        logInfo('[DRY RUN] Would report processed file size')
      }

      const MAX_ROWS_PER_TRANSACTION = 50000
      const isLargeFile = stats.copyRowsConverted > MAX_ROWS_PER_TRANSACTION
      if (isLargeFile) {
        logInfo(`Large dataset detected (${stats.copyRowsConverted} rows), implementing streaming batched processing`)
      }

if (!dryRun) {
  logInfo('Streaming and executing SQL file in dependency order...')
  const errorLogFile = `${processedFilePath}.errors.log`
  const errorStream = fs.createWriteStream(errorLogFile)
  let currentPosition = 0
  const progressCallback = (position) => {
    currentPosition = position
  }
  const batchSize = isLargeFile ? 50 : 200

  // Read SQL statements from processedFilePath
  const sqlStatements = fs.readFileSync(processedFilePath, 'utf8')
    .split(/;\s*\n/) // Split by semicolon followed by newline
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0)

  // Use dependency-ordered batch execution
  const results = await loadInDependencyOrder(
    client,
    sqlStatements,
    dryRun,
    batchSize
  )

  errorStream.end()

  logInfo(`Dependency-ordered execution complete: ${results.rowsInserted} rows, ${results.success} successes, ${results.errors} errors`)
} else {
  logInfo('[DRY RUN] Would stream and execute SQL file in dependency order')
}

      if (!dryRun) {
        safeRemoveFile(processedFilePath)
      } else {
        logInfo(`[DRY RUN] Would remove temporary file: ${processedFilePath}`)
      }
      successCount++
    } catch (error) {
      logError(`❌ Error ${dryRun ? 'simulating' : 'processing'} ${sourceDbName}: ${error.message}`)
      logError(error.stack)
      errorCount++
      failedUploads.push({ sourceDbName, targetDbName, filePath, error: error.message })
      global.gc && global.gc()
      continue
    } finally {
      if (client && !dryRun) {
        try {
          if (typeof client.release === 'function') {
            client.release()
            logInfo(`Released connection to ${targetDbName}`)
          } else if (typeof client.end === 'function') {
            await client.end()
            logInfo(`Disconnected from ${targetDbName}`)
          }
        } catch (e) {
          logError(`Error disconnecting: ${e.message}`)
        }
      }
      client = null
      global.gc && global.gc()
    }
  }

  if (failedUploads.length > 0) {
    const failedLogPath = `failed-uploads-${Date.now()}.json`
    fs.writeFileSync(failedLogPath, JSON.stringify(failedUploads, null, 2))
    logWarning(`Some uploads failed. See details in ${failedLogPath}`)
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000)
  logInfo('\n======== Database Restoration Summary ========')
  logInfo(`${dryRun ? '[DRY RUN]' : 'Actual'} Total time: ${formatDuration(totalDuration)}`)
  logInfo(`${dryRun ? '[DRY RUN] Would complete' : '✅ Success:'} ${successCount} databases`)
  if (errorCount) logInfo(`❌ Failures: ${errorCount} databases`)
  logInfo('==========================================')

  return errorCount === 0
}

const uploadFfcPayToDev = (dryRun = false) => uploadToDev('ffc-pay', dryRun)
const uploadFfcDocToDev = (dryRun = false) => uploadToDev('ffc-doc', dryRun)

async function withStallDetection (fn, operationName, stallThresholdSec = 120) {
  let lastActivityTime = Date.now()
  let isComplete = false

  const stallDetector = setInterval(() => {
    const stallTime = Math.round((Date.now() - lastActivityTime) / 1000)

    if (stallTime > stallThresholdSec && !isComplete) {
      logInfo(`⚠️ Possible stall detected in ${operationName} (${stallTime} seconds without progress)`)
      logInfo(`Current memory usage: ${formatFileSize(process.memoryUsage().heapUsed)} heap / ${formatFileSize(process.memoryUsage().rss)} total`)

      if (stallTime > stallThresholdSec * 2) {
        logInfo(`⚠️ Extended stall in ${operationName} - check Azure portal for resource limitations or throttling events`)
      }
    }
  }, 30000) // Check every 30 seconds

  const updateActivity = () => { lastActivityTime = Date.now() }
  const originalLog = console.log
  console.log = (...args) => {
    updateActivity()
    originalLog.apply(console, args)
  }

  try {
    const result = await fn()
    isComplete = true
    return result
  } finally {
    clearInterval(stallDetector)
    console.log = originalLog
  }
}

async function verifySchema (client, dbName) {
  const { rows } = await client.query(`
    SELECT COUNT(*) as table_count
    FROM pg_tables
    WHERE schemaname = 'public'
  `)

  const tableCount = parseInt(rows[0].table_count)
  logInfo(`Found ${tableCount} tables in target database`)

  return tableCount > 0
}

async function extractSchemaOnly (sqlFile, targetDb, dryRun = false) {
  const outputFile = `/tmp/schema_only_${targetDb}_${Date.now()}.sql`

  if (dryRun) {
    logInfo(`[DRY RUN] Would extract schema from ${sqlFile} to ${outputFile}`)
    return outputFile
  }

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

      if (line.trim().startsWith('INSERT INTO')) {
        return
      }

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

async function applySchema (client, schemaFile, dryRun = false) {
  logInfo('Applying schema to target database')

  if (dryRun) {
    logInfo(`[DRY RUN] Would apply schema from ${schemaFile} to database`)
    return { success: 0, errors: 0 }
  }

  const lineReader = require('readline').createInterface({
    input: fs.createReadStream(schemaFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let statement = ''
  let successCount = 0
  let errorCount = 0

  await client.query('BEGIN')

  for await (const line of lineReader) {
    if (line.trim().startsWith('--')) {
      continue
    }

    statement += line + '\n'

    if (line.trim().endsWith(';')) {
      try {
        await client.query(statement)
        successCount++
      } catch (err) {
        errorCount++
      }
      statement = ''
    }
  }

  await client.query('COMMIT')
  logInfo(`Schema applied: ${successCount} statements executed, ${errorCount} errors (warnings)`)

  return { success: successCount, errors: errorCount }
}

async function clearDatabaseSimple (client, dryRun = false) {
  try {
    const { rows } = dryRun
      ? { rows: [] }
      : await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
    `)

    if (dryRun) {
      logInfo('[DRY RUN] Would query database for all public tables')
    } else if (rows.length === 0) {
      logInfo('No tables found to clear')
      return
    } else {
      logInfo(`Found ${rows.length} tables in database`)
    }

    const tablesToClear = dryRun
      ? []
      : rows.filter(row => {
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

    if (dryRun) {
      logInfo('[DRY RUN] Would filter tables based on ETL and Liquibase protection rules')
    } else {
      logInfo(`After ETL protection, will clear ${tablesToClear.length} of ${rows.length} tables`)
    }

    if (!dryRun) {
      await client.query('BEGIN')
    } else {
      logInfo('[DRY RUN] Would begin transaction')
    }

    if (dryRun) {
      logInfo('[DRY RUN] Would query table relationships to determine deletion order')
    } else {
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

      for (const tablename of processOrder.reverse()) {
        try {
          await client.query(`TRUNCATE TABLE "${tablename}" CASCADE`)
          logInfo(`Cleared table: ${tablename}`)
        } catch (err) {
          logInfo(`Note: Could not clear table ${tablename}: ${err.message}. Trying alternative approach.`)
          try {
            await client.query(`DELETE FROM "${tablename}"`)
            logInfo(`Cleared table: ${tablename} (using DELETE)`)
          } catch (err2) {
            logError(`Failed to clear table ${tablename}: ${err2.message}`)
          }
        }
      }
    }

    if (!dryRun) {
      await client.query('COMMIT')
      logInfo('Tables cleared successfully')
    } else {
      logInfo('[DRY RUN] Would commit transaction after clearing tables')
    }
  } catch (err) {
    if (!dryRun) {
      await client.query('ROLLBACK')
    } else {
      logInfo('[DRY RUN] Would rollback transaction due to error')
    }
    throw err
  }
}

function formatFileSize (bytes) {
  if (bytes < 1024) return bytes + ' bytes'
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function formatDuration (seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function parseCommandLineArgs () {
  const args = process.argv.slice(2)
  const options = {
    dryRun: process.env.DRY_RUN === 'true' || false
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      options.dryRun = true
    }
  }

  return options
}

module.exports = {
  uploadToDev,
  uploadFfcPayToDev,
  uploadFfcDocToDev,
  extractSchemaOnly,
  applySchema,
  clearDatabaseSimple
}

// Allow direct execution
if (require.main === module) {
  const { dryRun } = parseCommandLineArgs()
  // Default to 'all' if not specified
  const type = process.argv[2] || 'all'
  uploadToDev(type, dryRun)
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      logError(`Upload process failed: ${error}`)
      process.exit(1)
    })
}
