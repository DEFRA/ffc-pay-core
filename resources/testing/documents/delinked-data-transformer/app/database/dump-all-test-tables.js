const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { listDatabases, createConnection } = require('./db-connection')
const os = require('os')

const { ETL_DATABASES, ETL_TABLE_PREFIX, EXCLUDE_ETL_TABLES, PROTECTED_TABLES } = require('../constants/etl-protection')

const MAX_CONCURRENT_DATABASES = Math.min(os.cpus().length, 3)
const DB_PATTERNS = ['ffc-doc-%-test', 'ffc-pay-%-test']

async function getEtlTables (dbConnection) {
  try {
    const result = await dbConnection.pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name ILIKE '${ETL_TABLE_PREFIX}%'
    `)
    return result.rows.map(row => row.table_name)
  } catch (error) {
    console.error(`Error identifying ETL tables: ${error.message}`)
    return []
  }
}

async function dumpAllTestTables (dryRun = false) {
  console.log(`Running with concurrency: Up to ${MAX_CONCURRENT_DATABASES} databases in parallel`)
  if (dryRun) {
    console.log('*** DRY RUN MODE ENABLED: No actual dumps will be performed. ***')
  }

  const dumpDir = path.resolve(__dirname, '../../test-dumps')
  if (!dryRun) fs.mkdirSync(dumpDir, { recursive: true })

  try {
    console.log('--- Database Discovery ---')
    const databases = await listDatabases(DB_PATTERNS)
    console.log(`Found ${databases.length} matching databases:`)
    databases.forEach(db => console.log(`  - ${db}`))

    for (let i = 0; i < databases.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databases.slice(i, i + MAX_CONCURRENT_DATABASES)
      // Await all dumps in the batch before continuing
      await Promise.all(batch.map(db => processDatabase(db, dumpDir, dryRun)))
    }

    console.log('\nAll test databases have been processed.')
  } catch (error) {
    console.error('Error in dumpAllTestTables:', error)
    throw error
  }
}

async function processDatabase (database, dumpDir, dryRun = false) {
  console.log(`\nProcessing database: ${database}`)
  const dbDumpDir = path.join(dumpDir, database)
  if (!dryRun) fs.mkdirSync(dbDumpDir, { recursive: true })

  const fullDumpPath = path.join(dbDumpDir, `${database}_data.sql`)
  if (dryRun) {
    console.log(`[DRY RUN] Would perform data-only dump of ${database} to ${fullDumpPath}`)
    return Promise.resolve()
  }

  const dbConnection = await createConnection(database)
  const config = dbConnection.config
  const env = { ...process.env, PGPASSWORD: dbConnection.token }

  // Build pg_dump args
  const args = [
    '-h', config.host,
    '-p', config.port,
    '-U', config.username,
    '-d', config.database,
    '--data-only',
    '--no-owner',
    '--no-privileges',
    '--encoding=UTF8',
    '--file', fullDumpPath
  ]

  // ETL table exclusions
  const isEtlDatabase = EXCLUDE_ETL_TABLES && ETL_DATABASES.some(db => database.toLowerCase() === db.toLowerCase())
  if (isEtlDatabase) {
    const etlTables = await getEtlTables(dbConnection)
    etlTables.forEach(table => {
      args.push('--exclude-table', `public."${table}"`)
      args.push('--exclude-table-data', `public."${table}"`)
    })
    // Optionally exclude ETL sequences
    args.push('--exclude-table-data', 'public."etl*_seq*"')
    args.push('--exclude-table', 'public."etl*_seq*"')
    args.push('--exclude-table-data', 'public."ETL*_seq*"')
    args.push('--exclude-table', 'public."ETL*_seq*"')
    args.push('--exclude-table-data', 'public."etlStage*_seq*"')
    args.push('--exclude-table', 'public."etlStage*_seq*"')
  }

  // Liquibase/protected table exclusions
  PROTECTED_TABLES.forEach(table => {
    args.push('--exclude-table', `public."${table}"`)
    args.push('--exclude-table-data', `public."${table}"`)
  })

  const PG_DUMP_PATH = process.env.PG_DUMP_PATH || 'pg_dump'
  return new Promise((resolve, reject) => {
    const pgDump = spawn(PG_DUMP_PATH, args, { env })
    pgDump.on('close', code => {
      if (code === 0) {
        console.log(`✅ Dumped ${database} to ${fullDumpPath}`)
        dbConnection.pool.end()
        resolve()
      } else {
        console.error(`❌ pg_dump for ${database} exited with code ${code}`)
        dbConnection.pool.end()
        reject(new Error(`pg_dump exited with code ${code}`))
      }
    })
    pgDump.on('error', error => {
      console.error(`❌ pg_dump process error for ${database}: ${error.message}`)
      dbConnection.pool.end()
      reject(error)
    })
  })
}

module.exports = { dumpAllTestTables }

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true'
  console.log('Starting database dump operation...')
  dumpAllTestTables(dryRun)
    .then(() => {
      console.log('Database dump completed successfully')
    })
    .catch(error => {
      console.error('Error during database dump:', error)
      process.exit(1)
    })
}
