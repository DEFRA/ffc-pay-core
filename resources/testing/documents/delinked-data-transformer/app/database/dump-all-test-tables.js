const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createConnection, listDatabases, getDatabaseStats } = require('./db-connection')
const os = require('os')

const { ETL_DATABASES, ETL_TABLE_PREFIX, EXCLUDE_ETL_TABLES, PROTECTED_TABLES } = require('../constants/etl-protection')

// Set maximum concurrency based on CPUs, but limit to avoid overwhelming the server
const MAX_CONCURRENT_DATABASES = Math.min(os.cpus().length, 3) // Reduced from 4 to prevent throttling

/**
 * RESTORE INSTRUCTIONS for plain SQL dumps:
 * psql --dbname=<target_db> --file=<filename.sql>
 */
async function dumpAllTestTables (dryRun = false) {
  console.log(`Running with concurrency: Up to ${MAX_CONCURRENT_DATABASES} databases in parallel`)
  if (dryRun) {
    console.log('*** DRY RUN MODE ENABLED: No actual dumps will be performed. ***')
  }

  const dumpDir = path.resolve(__dirname, '../test-dumps')
  if (!dryRun) {
    fs.mkdirSync(dumpDir, { recursive: true })
  }

  try {
    console.log('--- Database Discovery Diagnostics ---')
    const allDatabases = await listDatabases(['%'])
    console.log(`Total databases on server: ${allDatabases.length}`)

    const allFfcDatabases = allDatabases.filter(db => db.toLowerCase().includes('ffc'))
    console.log('All FFC-related databases on server:')
    allFfcDatabases.forEach(db => console.log(`  - ${db}`))

    const dbPatterns = ['ffc-doc-%-test', 'ffc-pay-%-test']
    console.log(`\nSearching for databases matching patterns: ${dbPatterns.join(', ')}`)

    const databases = await listDatabases(dbPatterns)
    console.log(`Found ${databases.length} matching databases:`)
    databases.forEach(db => console.log(`  - ${db}`))

    const missingDatabases = allFfcDatabases
      .filter(db => db.endsWith('-test'))
      .filter(db => !databases.includes(db))

    if (missingDatabases.length > 0) {
      console.warn('\n⚠️ WARNING: Some FFC test databases don\'t match the patterns:')
      missingDatabases.forEach(db => console.warn(`  - ${db} (will be skipped)`))
      console.warn('If these should be included, check database naming patterns')
    }

    for (let i = 0; i < databases.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databases.slice(i, i + MAX_CONCURRENT_DATABASES)
      console.log(`\nProcessing batch of ${batch.length} databases (${i + 1}-${Math.min(i + MAX_CONCURRENT_DATABASES, databases.length)} of ${databases.length})`)

      const results = []
      for (const database of batch) {
        try {
          const result = await processDatabase(database, dumpDir, dryRun)
          results.push(result)
        } catch (error) {
          console.error(`Batch processing error on database ${database}:`, error)
          results.push({ database, success: false, error })
        }
      }

      const failures = results.filter(r => !r.success)
      if (failures.length > 0) {
        console.error(`\n${failures.length} database(s) failed in this batch:`)
        failures.forEach(f => console.error(`  - ${f.database}: ${f.error}`))
      }
    }

    console.log('\nAll test databases have been processed.')
  } catch (error) {
    console.error('Error in dumpAllTestTables:', error)
    throw error
  }
}

async function getEtlTables (dbConnection) {
  try {
    console.log(`Identifying ETL tables in ${dbConnection.database}...`)
    const result = await dbConnection.pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name ILIKE '${ETL_TABLE_PREFIX}%'
    `)

    const tables = result.rows.map(row => row.table_name)
    if (tables.length > 0) {
      console.log(`Found ${tables.length} ETL tables to protect:`)
      tables.forEach(table => console.log(`  - ${table}`))
    } else {
      console.log('No ETL tables found in this database')
    }

    return tables
  } catch (error) {
    console.error(`Error identifying ETL tables: ${error.message}`)
    return []
  }
}

async function processDatabase (database, dumpDir, dryRun = false) {
  console.log(`\nProcessing database: ${database}`)
  const dbConnection = await createConnection(database)

  try {
    const dbDumpDir = path.join(dumpDir, database)
    if (!dryRun) {
      fs.mkdirSync(dbDumpDir, { recursive: true })
    }

    const fullDumpPath = path.join(dbDumpDir, `${database}_full.sql`)
    if (dryRun) {
      console.log(`[DRY RUN] Would perform full dump of ${database} to ${fullDumpPath}`)
      return { database, success: true, dryRun: true }
    } else {
      await performFullDump(dbConnection, fullDumpPath)
      console.log(`Completed full dump of ${database} to ${fullDumpPath}`)
      return { database, success: true }
    }
  } catch (error) {
    console.error(`Error processing database ${database}:`, error)
    return { database, success: false, error }
  } finally {
    if (dbConnection && dbConnection.pool) {
      await dbConnection.pool.end()
    }
  }
}

async function performFullDump (dbConnection, outputPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const startTime = new Date()
        console.log(`[${startTime.toISOString()}] Starting dump of ${dbConnection.database}...`)

        const dbStats = await getDatabaseStats(dbConnection)
        console.log(`Database ${dbConnection.database} stats: ${(dbStats.totalSizeMB).toFixed(2)} MB, ${dbStats.tableCount} tables`)

        let etlTables = []
        let isEtlDatabase = false

        if (EXCLUDE_ETL_TABLES && ETL_DATABASES.some(db => dbConnection.database.toLowerCase() === db.toLowerCase())) {
          isEtlDatabase = true
          console.log(`⚠️ ETL PROTECTION ACTIVE: Preparing to exclude ETL tables from ${dbConnection.database}`)
          etlTables = await getEtlTables(dbConnection)
        }

        if (dbStats.largeTables.length > 0) {
          console.log('Largest tables:')
          dbStats.largeTables.forEach(t => {
            try {
              const sizeInMB = parseFloat(t.size_mb)
              console.log(`  - ${t.table_name}: ${isNaN(sizeInMB) ? 'size unknown' : sizeInMB.toFixed(2) + ' MB'}`)
            } catch (err) {
              console.log(`  - ${t.table_name}: size unknown`)
            }
          })
        }

        const env = { ...process.env, PGPASSWORD: dbConnection.token }
        const config = dbConnection.config

        const outputDir = path.dirname(outputPath)
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true })
        }

        const args = [
          '-h', config.host,
          '-p', config.port,
          '-U', config.username,
          '-d', config.database,
          '--no-owner',
          '--no-privileges',
          '--no-tablespaces',
          '--format=plain',
          '--encoding=UTF8',
          '--file', outputPath,
          '--verbose'
        ]
        console.log(`Database check: '${dbConnection.database}' is in ETL_DATABASES: ${ETL_DATABASES.some(db => dbConnection.database.toLowerCase() === db.toLowerCase())}`)

        if (isEtlDatabase && etlTables.length > 0) {
          console.log(`⚠️ ETL PROTECTION: Adding pg_dump exclusions for ${etlTables.length} ETL tables`)
          etlTables.forEach(table => {
            args.push('--exclude-table', `public."${table}"`)
            args.push('--exclude-table-data', `public."${table}"`)
          })
        }
        
        if (isEtlDatabase) {
          console.log(`⚠️ ETL SEQUENCE PROTECTION: Excluding ETL-related sequences`)
          
          args.push('--exclude-table-data', `public."etl*_seq*"`)
          args.push('--exclude-table', `public."etl*_seq*"`)
          
          args.push('--exclude-table-data', `public."ETL*_seq*"`)
          args.push('--exclude-table', `public."ETL*_seq*"`)
          
          args.push('--exclude-table-data', `public."etlStage*_seq*"`)
          args.push('--exclude-table', `public."etlStage*_seq*"`)
        }

        console.log(`⚠️ LIQUIBASE PROTECTION: Adding pg_dump exclusions for Liquibase tracking tables`)
        PROTECTED_TABLES.forEach(table => {
          args.push('--exclude-table', `public."${table}"`)
          args.push('--exclude-table-data', `public."${table}"`)
      })

        if (dbStats.totalSizeMB > 500) {
          args.push('--data-only')
        }

        const pgDump = spawn('pg_dump', args, { env })

        let stderrOutput = ''
        let lastProgressTime = Date.now()
        const processedTables = new Set()
        let currentTable = ''

        const progressInterval = setInterval(() => {
          try {
            if (fs.existsSync(outputPath)) {
              const stats = fs.statSync(outputPath)
              const currentSizeMB = (stats.size / (1024 * 1024)).toFixed(2)
              const elapsedSeconds = Math.round((Date.now() - startTime.getTime()) / 1000)
              const mbPerSecond = (currentSizeMB / Math.max(1, elapsedSeconds)).toFixed(2)

              const percentComplete = Math.min(
                100,
                Math.round((processedTables.size / Math.max(1, dbStats.tableCount)) * 100)
              )

              console.log(
              `[${new Date().toISOString()}] ${config.database}: ` +
              `Progress: ${percentComplete}% (${processedTables.size}/${dbStats.tableCount} tables), ` +
              `Size: ${currentSizeMB} MB, Rate: ${mbPerSecond} MB/s` +
              (currentTable ? `, Current: ${currentTable}` : '')
              )
            }
          } catch (err) {
            console.log(`Warning: Could not get file size: ${err.message}`)
          }
        }, 20000) // Check every 20 seconds

        const stallCheckInterval = setInterval(() => {
          const timeSinceLastActivity = Date.now() - lastProgressTime

          if (timeSinceLastActivity > 5 * 60 * 1000) {
            console.error(`[${new Date().toISOString()}] WARNING: Dump for ${config.database} appears stalled - no activity for ${Math.round(timeSinceLastActivity / 1000)}s`)

            if (pgDump && pgDump.pid) {
              console.log(`Attempting to diagnose stalled dump process (PID: ${pgDump.pid})...`)
            }
          }
        }, 60000) // Check every minute

        pgDump.stderr.on('data', (data) => {
          const message = data.toString()
          stderrOutput += message
          lastProgressTime = Date.now()

          if (message.includes('dumping contents of table')) {
            const tableMatch = message.match(/dumping contents of table "?([^"\s]+)"?/)
            if (tableMatch && tableMatch[1]) {
              currentTable = tableMatch[1]
              processedTables.add(currentTable)

              if (processedTables.size % 5 === 0 || processedTables.size === 1) {
                console.log(`[${new Date().toISOString()}] ${config.database}: ${message.trim()} (${processedTables.size}/${dbStats.tableCount})`)
              }
            }
          } else if (message.includes('error:')) {
            console.error(`[${new Date().toISOString()}] ERROR in ${config.database}: ${message.trim()}`)
          }
        })

        pgDump.stdout.on('data', (data) => {
          lastProgressTime = Date.now()
        })

        pgDump.on('close', (code) => {
          clearInterval(progressInterval)
          clearInterval(stallCheckInterval) // Clear stall detection
          clearTimeout(dumpTimeout)
          const endTime = new Date()
          const elapsedSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)

          if (code === 0) {
            try {
              const stats = fs.statSync(outputPath)
              const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2)
              const compressionRatio = dbStats.totalSizeMB > 0
                ? (dbStats.totalSizeMB / parseFloat(fileSizeMB)).toFixed(2)
                : 'unknown'

              console.log(
              `[${endTime.toISOString()}] Full dump for ${config.database} completed successfully:\n` +
              `  - File size: ${fileSizeMB} MB (compression ratio: ${compressionRatio}x)\n` +
              `  - Duration: ${elapsedSeconds}s (${(parseFloat(fileSizeMB) / Math.max(1, elapsedSeconds)).toFixed(2)} MB/s)\n` +
              `  - Tables processed: ${processedTables.size}/${dbStats.tableCount}`
              )
              resolve()
            } catch (err) {
              console.error(`Warning: Could not get final file size: ${err.message}`)
              console.log(`[${endTime.toISOString()}] Full dump for ${config.database} completed successfully`)
              resolve()
            }
          } else {
            console.error(`[${endTime.toISOString()}] FAILED: pg_dump for ${config.database} exited with code ${code} after ${elapsedSeconds}s`)
            reject(new Error(`pg_dump process for ${config.database} exited with code ${code}: ${stderrOutput}`))
          }
        })

        pgDump.on('error', (error) => {
          clearInterval(progressInterval)
          clearInterval(stallCheckInterval) // Clear stall detection
          clearTimeout(dumpTimeout)
          console.error(`[${new Date().toISOString()}] ERROR: pg_dump process error for ${config.database}: ${error.message}`)
          reject(new Error(`pg_dump process error for ${config.database}: ${error.message}`))
        })

        const dumpTimeout = setTimeout(() => {
          if (pgDump && !pgDump.killed) {
            console.error(`[${new Date().toISOString()}] ERROR: Dump operation timeout after 60 minutes for ${config.database}`)
            pgDump.kill()
            clearInterval(progressInterval)
            clearInterval(stallCheckInterval)
            reject(new Error(`Dump operation timeout after 60 minutes for ${config.database}`))
          }
        }, 60 * 60 * 1000) // 60 minutes timeout
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ERROR: Exception in performFullDump for ${dbConnection?.config?.database || 'unknown'}: ${error.message}`)
        reject(error)
      }
    })()
  })
}

module.exports = { dumpAllTestTables }

// Run the script directly when called directly
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true'
  console.log('Starting database dump operation...')
  dumpAllTestTables(dryRun)
    .then(() => {
      console.log('Database dump completed successfully')
    })
    .catch((error) => {
      console.error('Error during database dump:', error)
      process.exit(1)
    })
}
