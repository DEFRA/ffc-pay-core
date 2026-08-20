const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Client } = require('pg')

// Keep the DB host near the top so it is easy to switch between localhost and
// a Docker host alias. Most local setups, including Docker Desktop mapped ports,
// expose the database on localhost. Use LOCAL_DB_HOST=host.docker.internal when
// you need the Docker Desktop WSL host alias instead.
//
// Only LOCAL_DB_* variables are used here. Service-level POSTGRES_* env vars are
// intentionally ignored because they are tied to other microservice databases
// and would break connection to this dedicated local recovery container.
const LOCAL_DB_HOST = process.env.LOCAL_DB_HOST || 'localhost'
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 5467)
const LOCAL_DB_USER = process.env.LOCAL_DB_USER || 'postgres'
const LOCAL_DB_PASSWORD = process.env.LOCAL_DB_PASSWORD || 'ppp'
const LOCAL_DB_NAME = process.env.LOCAL_DB_NAME || 'ffc_pay_local_recovery'
const DATA_RECOVERY_DIR = path.resolve(__dirname, '..')
const COMPOSE_FILE = path.join(DATA_RECOVERY_DIR, 'docker-compose.yaml')
const SCHEMA_DIR = path.resolve(__dirname, 'schemas')
const PAYMENT_REQUEST_IDS_FILE = path.resolve(__dirname, 'pr-id.csv')

function parsePaymentRequestIds (filePath) {
  if (!fs.existsSync(filePath)) {
    return []
  }

  const rawText = fs.readFileSync(filePath, 'utf8')
  const matches = rawText.match(/\d+/g) || []
  return [...new Set(matches.map(Number))]
}

async function runAdminQuery (adminConfig, queryText, params = []) {
  const client = new Client(adminConfig)
  await client.connect()
  try {
    return await client.query(queryText, params)
  } finally {
    await client.end()
  }
}

async function ensureDatabaseExists (config) {
  const adminConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: 'postgres'
  }

  const existsResult = await runAdminQuery(
    adminConfig,
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [config.database]
  )

  if (existsResult.rows.length > 0) {
    console.log(`Database already exists: ${config.database}`)
    return
  }

  console.log(`Creating database: ${config.database}`)
  await runAdminQuery(
    adminConfig,
    `CREATE DATABASE "${config.database.replace(/"/g, '""')}" OWNER "${config.user.replace(/"/g, '""')}"`
  )
}

function splitSqlStatements (sqlText) {
  return sqlText
    .replace(/--.*$/gm, '')
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0)
}

async function applySchemaFiles (config, schemaDir) {
  const schemaFiles = fs.readdirSync(schemaDir)
    .filter(file => file.endsWith('.sql'))
    .sort()

  if (schemaFiles.length === 0) {
    throw new Error(`No schema files were found in ${schemaDir}`)
  }

  const client = new Client(config)
  await client.connect()

  try {
    for (const fileName of schemaFiles) {
      const filePath = path.join(schemaDir, fileName)
      const sqlText = fs.readFileSync(filePath, 'utf8')
      const statements = splitSqlStatements(sqlText)

      for (const statement of statements) {
        await client.query(statement)
      }

      console.log(`Applied schema file: ${fileName}`)
    }
  } finally {
    await client.end()
  }
}

async function importPaymentRequestIds (config, paymentRequestIds) {
  if (paymentRequestIds.length === 0) {
    console.log('No payment request IDs to import.')
    return
  }

  const client = new Client(config)
  await client.connect()

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
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.end()
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

async function waitForPostgres (config, maxAttempts = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new Client({ ...config, database: 'postgres' })
    try {
      await client.connect()
      await client.end()
      console.log('Postgres is accepting connections.')
      return
    } catch (error) {
      await client.end().catch(() => {})
      if (attempt === maxAttempts) {
        throw new Error(`Postgres did not become available on ${config.host}:${config.port} after ${maxAttempts} attempts: ${error.message}`)
      }
      console.log(`Waiting for Postgres to accept connections... (${attempt}/${maxAttempts})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

async function createLocalRecoveryDb () {
  const config = {
    host: LOCAL_DB_HOST,
    port: LOCAL_DB_PORT,
    user: LOCAL_DB_USER,
    password: LOCAL_DB_PASSWORD,
    database: LOCAL_DB_NAME
  }

  const paymentRequestIds = parsePaymentRequestIds(PAYMENT_REQUEST_IDS_FILE)
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
  await waitForPostgres(config)
  await ensureDatabaseExists(config)
  await applySchemaFiles({
    ...config,
    database: LOCAL_DB_NAME
  }, SCHEMA_DIR)
  await importPaymentRequestIds({
    ...config,
    database: LOCAL_DB_NAME
  }, paymentRequestIds)

  console.log(`Local database is ready: ${LOCAL_DB_NAME}`)
  return config
}

module.exports = {
  LOCAL_DB_HOST,
  LOCAL_DB_PORT,
  LOCAL_DB_USER,
  LOCAL_DB_PASSWORD,
  LOCAL_DB_NAME,
  parsePaymentRequestIds,
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
