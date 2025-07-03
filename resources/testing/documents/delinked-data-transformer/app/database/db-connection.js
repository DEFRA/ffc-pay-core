const { Pool } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')

async function createConnection (database = 'postgres', options = {}) {
  console.log(`---- CONNECTION ATTEMPT STARTED [${new Date().toISOString()}] ----`)
  console.log(`Attempting to connect to database: ${database}`)

  if (!process.env.POSTGRES_DEV_HOST) {
    console.log('ERROR: Missing POSTGRES_DEV_HOST environment variable')
    throw new Error('POSTGRES_DEV_HOST environment variable is required')
  }

  console.log('Starting Azure token acquisition...')
  const tokenStartTime = Date.now()
  let token
  try {
    token = await getEnhancedAzureToken()
    console.log(`Token acquired successfully in ${Date.now() - tokenStartTime}ms`)
  } catch (error) {
    console.log(`Token acquisition failed after ${Date.now() - tokenStartTime}ms: ${error.message}`)
    throw error
  }

  const username = process.env.POSTGRES_DEV_ADMIN || process.env.POSTGRES_USER
  console.log(`Using database username: ${username}`)

  const config = {
    user: username,
    password: token,
    host: process.env.POSTGRES_DEV_HOST,
    port: process.env.POSTGRES_PORT || 5432,
    database,
    ssl: true,
    max: options.max || 10,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: 'database_dump'
  }

  console.log(`Connection configuration: host=${config.host}, port=${config.port}, database=${config.database}, username=${config.user}`)
  console.log(`Connection timeouts: idle=${config.idleTimeoutMillis}ms, connection=${config.connectionTimeoutMillis}ms`)
  console.log(`SSL enabled: ${config.ssl}, Max pool size: ${config.max}`)
  const pool = new Pool(config)

  pool.on('error', err => {
    console.error(`Unexpected error on client for ${database}`, err)
  })

  try {
    console.log(`Attempting to connect to pool [${new Date().toISOString()}]...`)
    console.log(`Performing DNS lookup for ${process.env.POSTGRES_DEV_HOST}...`)

    const connectionStartTime = Date.now()
    console.log(`Connection attempt started at ${connectionStartTime}`)

    const client = await pool.connect()
    console.log(`Connected to PostgreSQL database "${database}" using Azure AD authentication in ${Date.now() - connectionStartTime}ms`)
    client.release()

    return {
      query: async (text, params) => await pool.query(text, params),
      pool,
      database,
      config: {
        host: process.env.POSTGRES_DEV_HOST,
        port: process.env.POSTGRES_PORT || 5432,
        database,
        username
      },
      token
    }
  } catch (err) {
    console.error(`Error connecting to the database "${database}" [${new Date().toISOString()}]:`, err.message)
    console.error(`Error code: ${err.code}, Error name: ${err.name}`)
    console.error(`Connection attempt duration: ${Date.now() - tokenStartTime}ms`)
    console.error(`Connection parameters: host=${config.host}, port=${config.port}, database=${config.database}, username=${config.user}`)

    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      console.error('Connection timeout detected. This may be due to firewall restrictions or network issues.')
      console.error('Please check Azure PostgreSQL firewall rules to ensure your IP address is allowed.')
    }

    throw err
  }
}

async function getEnhancedAzureToken () {
  try {
    console.log('Attempting enhanced Azure authentication (Strategy 1)...')
    console.log(`Using tenant ID: ${process.env.DEV_TENANT_ID || 'Not specified'}`)

    const credential = new DefaultAzureCredential({
      tenantId: process.env.DEV_TENANT_ID,
      managedIdentityClientId: process.env.AZURE_CLIENT_ID,
      excludeEnvironmentCredential: false,
      excludeInteractiveBrowserCredential: false,
      disableInstanceDiscovery: false
    })

    console.log('DefaultAzureCredential instance created, requesting token...')

    const startTime = Date.now()
    const token = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default')
    console.log(`Token acquired in ${Date.now() - startTime}ms`)
    console.log('Successfully obtained enhanced Azure authentication token')
    return token.token
  } catch (error) {
    console.error('Error getting enhanced Azure token:', error.message)
    console.error('Token error details:', JSON.stringify(error, null, 2))

    try {
      console.log('Falling back to basic Azure authentication (Strategy 2)...')
      const credential = new DefaultAzureCredential({
        tenantId: process.env.DEV_TENANT_ID
      })

      console.log('Requesting token with basic scope...')
      const startTime = Date.now()
      const token = await credential.getToken('https://ossrdbms-aad.database.windows.net')
      console.log(`Basic token acquired in ${Date.now() - startTime}ms`)
      console.log('Successfully obtained basic Azure authentication token')
      return token.token
    } catch (fallbackError) {
      console.error('Error getting Azure token (fallback):', fallbackError.message)
      console.error('Fallback error details:', JSON.stringify(fallbackError, null, 2))
      throw new Error('Failed to authenticate with Azure: ' + fallbackError.message)
    }
  }
}

async function listDatabases (patterns = null) {
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

async function getDatabaseStats (connection) {
  try {
    const sizeResult = await connection.query(`
      SELECT pg_database_size($1) AS size
    `, [connection.database])

    const tableCountResult = await connection.query(`
      SELECT count(*) AS table_count 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `)

    const largeTablesResult = await connection.query(`
      SELECT 
        table_name, 
        pg_relation_size(quote_ident(table_schema) || '.' || quote_ident(table_name))/1024/1024 as size_mb
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY size_mb DESC
      LIMIT 5
    `)

    return {
      totalSizeMB: sizeResult.rows[0].size / 1024 / 1024,
      tableCount: parseInt(tableCountResult.rows[0].table_count),
      largeTables: largeTablesResult.rows
    }
  } catch (error) {
    console.error(`Error getting database stats: ${error.message}`)
    return { totalSizeMB: 0, tableCount: 0, largeTables: [] }
  }
}

async function getDevAndTestDatabases () {
  const allDatabases = await listDatabases()
  const devDatabases = allDatabases.filter(db => db.endsWith('-dev'))
  const testDatabases = allDatabases.filter(db => db.endsWith('-test'))

  return { devDatabases, testDatabases }
}

module.exports = {
  createConnection,
  listDatabases,
  getDevAndTestDatabases,
  getEnhancedAzureToken,
  getDatabaseStats
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
