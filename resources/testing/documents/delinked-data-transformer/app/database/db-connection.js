const { Pool } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')

async function createConnection(database = 'postgres') {
  // Debug environment variables
  // console.log('Environment variables:')
  // console.log(`POSTGRES_DEV_HOST: ${process.env.POSTGRES_DEV_HOST}`)
  // console.log(`POSTGRES_USER: ${process.env.POSTGRES_USER}`)
  // console.log(`POSTGRES_DEV_ADMIN: ${process.env.POSTGRES_DEV_ADMIN}`)
  // console.log(`POSTGRES_PORT: ${process.env.POSTGRES_PORT}`)
  // console.log(`DEV_TENANT_ID: ${process.env.DEV_TENANT_ID}`)

  if (!process.env.POSTGRES_DEV_HOST) {
    throw new Error('POSTGRES_DEV_HOST environment variable is required')
  }

  const credential = new DefaultAzureCredential({
    tenantId: process.env.DEV_TENANT_ID
  })

  const token = await credential.getToken(
    'https://ossrdbms-aad.database.windows.net'
  )

  const azureUserEnv = process.env.POSTGRES_DEV_ADMIN || process.env.POSTGRES_USER
  const username = azureUserEnv.includes('@')
    ? azureUserEnv
    : `${azureUserEnv}@${process.env.POSTGRES_DEV_HOST.split('.')[0]}`

  const config = {
    user: username,
    password: token.token,
    host: process.env.POSTGRES_DEV_HOST,
    port: process.env.POSTGRES_PORT || 5432,
    database,
    ssl: true,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  }

  console.log(`Attempting to connect to ${process.env.POSTGRES_DEV_HOST}/${database} as ${username}`)

  const pool = new Pool(config)

  pool.on('error', err => {
    console.error(`Unexpected error on client for ${database}`, err)
  })

  try {
    const client = await pool.connect()
    console.log(`Connected to PostgreSQL database "${database}" using Azure AD authentication`)
    client.release()

    return {
      query: async (text, params) => await pool.query(text, params),
      pool,
      database
    }
  } catch (err) {
    console.error(`Error connecting to the database "${database}":`, err.stack)
    throw err
  }
}

/**
 * List all databases matching FFC patterns in a single query
 * @returns {Promise<Object>} Object with dev and test database arrays
 */
async function listDatabases(patterns = null) {
  const connection = await createConnection('postgres')

  if (!patterns) {
    // Default FFC patterns
    patterns = ['ffc-doc-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-dev', 'ffc-pay-%-test']
  }

  try {
    const placeholders = patterns.map((_, i) => `datname LIKE $${i + 1}`).join(' OR ')
    const query = `SELECT datname FROM pg_database WHERE ${placeholders} ORDER BY datname`

    const { rows } = await connection.query(query, patterns)
    const databases = rows.map(row => row.datname)

    return databases
  } catch (err) {
    console.error(`Error listing databases: ${err.message}`)
    return []
  } finally {
    await connection?.pool?.end()
  }
}

async function getDevAndTestDatabases() {
  const allDatabases = await listDatabases()
  const devDatabases = allDatabases.filter(db => db.endsWith('-dev'))
  const testDatabases = allDatabases.filter(db => db.endsWith('-test'))

  return { devDatabases, testDatabases }
}

module.exports = {
  createConnection,
  listDatabases,
  getDevAndTestDatabases
}

// Run standalone if executed directly
if (require.main === module) {
  (async () => {
    try {
      console.log('Testing database connection...')

      const { devDatabases, testDatabases } = await getDevAndTestDatabases()

      console.log('Found dev databases:', devDatabases.length)
      console.log(devDatabases)

      console.log('Found test databases:', testDatabases.length)
      console.log(testDatabases)

    } catch (error) {
      console.error('Error testing database connection:', error)
    }
  })()
}