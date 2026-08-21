const { Pool } = require('pg')

const DEFAULT_CONFIG = {
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: Number(process.env.LOCAL_DB_PORT || 5467),
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD || 'ppp',
  database: process.env.LOCAL_DB_NAME || 'ffc_pay_local_recovery'
}

function validateConfig (config = DEFAULT_CONFIG) {
  const required = ['host', 'port', 'user', 'password', 'database']
  const missing = required.filter(key => !config[key])
  if (missing.length > 0) {
    throw new Error(`Missing local database config keys: ${missing.join(', ')}`)
  }
}

function maskConfig (config) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user
  }
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function connectWithRetry (pool, maxAttempts = 5) {
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pool.connect()
      return client
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) {
        break
      }
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000)
      console.log(`Local DB connection attempt ${attempt}/${maxAttempts} failed (${error.code || error.message}). Retrying in ${backoffMs}ms...`)
      await delay(backoffMs)
    }
  }

  throw new Error(`Failed to connect to local database after ${maxAttempts} attempts: ${lastError.message}`)
}

async function createLocalConnection (options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...options,
    ssl: false,
    max: options.max || 5,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: options.applicationName || 'ffc_pay_local_recovery'
  }

  validateConfig(config)

  console.log(`Connecting to local recovery database: ${JSON.stringify(maskConfig(config))}`)

  const pool = new Pool(config)

  pool.on('error', err => {
    console.error(`Unexpected error on local database client for ${config.database}:`, err.message)
  })

  const client = await connectWithRetry(pool, options.maxAttempts || 5)
  try {
    const { rows } = await client.query('SELECT version() AS version')
    console.log(`Connected to local recovery database "${config.database}" (${rows[0].version.split(' ')[0]} ${rows[0].version.split(' ')[1]})`)
  } finally {
    client.release()
  }

  return {
    query: async (text, params) => await pool.query(text, params),
    pool,
    database: config.database,
    config: maskConfig(config),
    close: async () => {
      await pool.end()
    }
  }
}

module.exports = {
  createLocalConnection,
  DEFAULT_CONFIG
}

if (require.main === module) {
  (async () => {
    try {
      const connection = await createLocalConnection()
      const { rows } = await connection.query('SELECT current_database() AS database, current_user AS user')
      console.log('Local recovery database connection test successful:', rows[0])
      await connection.close()
      process.exit(0)
    } catch (error) {
      console.error('Local recovery database connection test failed:', error.message)
      process.exit(1)
    }
  })()
}
