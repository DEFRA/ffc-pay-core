const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { createLocalConnection } = require('./database/local-db-connection')
const { parseCsvIds } = require('./util/parse-csv-ids')

const DATA_RECOVERY_DIR = path.resolve(__dirname, '..')
const COMPOSE_FILE = path.join(DATA_RECOVERY_DIR, 'docker-compose.yaml')
const SCHEMA_DIR = path.resolve(__dirname, 'schemas')
const PAYMENT_REQUEST_IDS_FILE = path.resolve(__dirname, 'pr-id.csv')

function splitSqlStatements (sqlText) {
  return sqlText
    .replace(/--.*$/gm, '')
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0)
}

async function ensureDatabaseExists (localDbName) {
  const adminConnection = await createLocalConnection({ database: 'postgres', applicationName: 'ffc_pay_local_recovery_admin' })

  try {
    const existsResult = await adminConnection.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [localDbName]
    )

    if (existsResult.rows.length > 0) {
      console.log(`Database already exists: ${localDbName}`)
      return
    }

    console.log(`Creating database: ${localDbName}`)
    await adminConnection.query(
      `CREATE DATABASE "${localDbName.replace(/"/g, '""')}"`
    )
  } finally {
    await adminConnection.close()
  }
}

async function applySchemaFiles (connection, schemaDir) {
  const schemaFiles = fs.readdirSync(schemaDir)
    .filter(file => file.endsWith('.sql'))
    .sort()

  if (schemaFiles.length === 0) {
    throw new Error(`No schema files were found in ${schemaDir}`)
  }

  for (const fileName of schemaFiles) {
    const filePath = path.join(schemaDir, fileName)
    const sqlText = fs.readFileSync(filePath, 'utf8')
    const statements = splitSqlStatements(sqlText)

    for (const statement of statements) {
      await connection.query(statement)
    }

    console.log(`Applied schema file: ${fileName}`)
  }
}

async function importPaymentRequestIds (connection, paymentRequestIds) {
  if (paymentRequestIds.length === 0) {
    console.log('No payment request IDs to import.')
    return
  }

  const existingResult = await connection.query('SELECT COUNT(*)::int AS count FROM public."paymentRequestIds"')
  const existingCount = existingResult.rows[0].count

  if (existingCount >= paymentRequestIds.length) {
    console.log(`paymentRequestIds table already contains ${existingCount} rows; skipping CSV import.`)
    return
  }

  const client = await connection.pool.connect()

  try {
    await client.query('BEGIN')

    const BATCH_SIZE = 5000
    let insertedCount = 0

    for (let i = 0; i < paymentRequestIds.length; i += BATCH_SIZE) {
      const batch = paymentRequestIds.slice(i, i + BATCH_SIZE)
      const values = batch.map((id, index) => `($${index + 1})`).join(', ')
      const result = await client.query(
        `INSERT INTO public."paymentRequestIds" ("paymentRequestId") VALUES ${values} ON CONFLICT ("paymentRequestId") DO NOTHING`,
        batch
      )
      insertedCount += result.rowCount
    }

    await client.query('COMMIT')

    const countResult = await client.query('SELECT COUNT(*) FROM public."paymentRequestIds"')
    console.log(`Imported ${insertedCount} new payment request IDs into public."paymentRequestIds" (table total: ${countResult.rows[0].count})`)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function ensureDockerRecoveryStack () {
  if (process.argv.includes('--dry-run') || process.argv.includes('--skip-docker-up')) {
    return
  }

  if (!fs.existsSync(COMPOSE_FILE)) {
    return
  }

  console.log(`Starting recovery database via Docker Compose: ${COMPOSE_FILE}`)

  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --wait`, {
      cwd: DATA_RECOVERY_DIR,
      stdio: 'inherit'
    })
  } catch (error) {
    throw new Error(`Failed to start the recovery database container with Docker Compose: ${error.message}`)
  }

  console.log('Docker recovery database container is running.')
}

async function waitForPostgres (maxAttempts = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const connection = await createLocalConnection({ database: 'postgres', applicationName: 'ffc_pay_local_recovery_wait' })
      await connection.close()
      console.log('Postgres is accepting connections.')
      return
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Postgres did not become available after ${maxAttempts} attempts: ${error.message}`)
      }
      console.log(`Waiting for Postgres to accept connections... (${attempt}/${maxAttempts})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

function getLocalDbConfig () {
  return {
    host: process.env.LOCAL_DB_HOST || 'localhost',
    port: Number(process.env.LOCAL_DB_PORT || 5467),
    user: process.env.LOCAL_DB_USER || 'postgres',
    password: process.env.LOCAL_DB_PASSWORD || 'ppp',
    database: process.env.LOCAL_DB_NAME || 'ffc_pay_local_recovery'
  }
}

async function createLocalRecoveryDb () {
  const config = getLocalDbConfig()
  const paymentRequestIds = parseCsvIds(PAYMENT_REQUEST_IDS_FILE)

  console.log(`Host: ${config.host}`)
  console.log(`Port: ${config.port}`)
  console.log(`Database: ${config.database}`)
  console.log(`Loaded ${paymentRequestIds.length} payment request IDs from ${PAYMENT_REQUEST_IDS_FILE}`)

  if (process.argv.includes('--dry-run')) {
    console.log('Dry run only: would ensure the database exists and apply the schema files without dropping existing data.')
    console.log('To target a different local DB host/port, set LOCAL_DB_HOST and LOCAL_DB_PORT before running.')
    console.log('For Docker Desktop on WSL, use LOCAL_DB_HOST=host.docker.internal.')
    return config
  }

  ensureDockerRecoveryStack()
  await waitForPostgres()
  await ensureDatabaseExists(config.database)

  const connection = await createLocalConnection({ applicationName: 'ffc_pay_local_recovery_setup' })
  try {
    await applySchemaFiles(connection, SCHEMA_DIR)
    await importPaymentRequestIds(connection, paymentRequestIds)
    console.log(`Local database is ready: ${config.database}`)
  } finally {
    await connection.close()
  }

  return config
}

module.exports = {
  parseCsvIds,
  ensureDatabaseExists,
  applySchemaFiles,
  importPaymentRequestIds,
  createLocalRecoveryDb
}

if (require.main === module) {
  createLocalRecoveryDb()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Failed to build the local recovery database:', error)
      process.exit(1)
    })
}
