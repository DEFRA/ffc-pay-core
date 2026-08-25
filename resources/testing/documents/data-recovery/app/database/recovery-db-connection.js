const { Pool } = require('pg')

const REQUIRED_ENV_VARS = [
  'RECOVERY_DB_HOST',
  'RECOVERY_DB_NAME',
  'RECOVERY_DB_USER',
  'RECOVERY_DB_PASSWORD'
]

function validateConfig () {
  const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing recovery database environment variables: ${missing.join(', ')}`)
  }
}

function buildConfig (options = {}) {
  validateConfig()

  const sslMode = process.env.RECOVERY_DB_SSL_MODE || 'require'
  const useSsl = process.env.RECOVERY_DB_SSL !== 'false'

  const config = {
    host: process.env.RECOVERY_DB_HOST,
    port: Number(process.env.RECOVERY_DB_PORT || 5432),
    database: options.database || process.env.RECOVERY_DB_NAME,
    user: process.env.RECOVERY_DB_USER,
    password: process.env.RECOVERY_DB_PASSWORD,
    max: options.max || 5,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: options.applicationName || 'ffc_pay_recovery'
  }

  if (useSsl) {
    config.ssl = sslMode === 'require'
      ? true
      : { rejectUnauthorized: sslMode !== 'no-verify' }
  }

  return config
}

function maskConfig (config) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: config.ssl
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
      console.error(`Connection attempt ${attempt}/${maxAttempts} failed:`)
      console.error(`  code: ${error.code || 'N/A'}`)
      console.error(`  message: ${error.message}`)

      if (attempt === maxAttempts) {
        break
      }

      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000)
      console.log(`Retrying in ${backoffMs}ms...`)
      await delay(backoffMs)
    }
  }

  throw new Error(`Failed to connect to recovery database after ${maxAttempts} attempts: ${lastError.message}`)
}

async function createRecoveryConnection (options = {}) {
  const config = buildConfig(options)

  console.log(`Connecting to recovery database: ${JSON.stringify(maskConfig(config))}`)

  const pool = new Pool(config)

  pool.on('error', err => {
    console.error(`Unexpected error on recovery database client for ${config.database}:`, err.message)
  })

  const client = await connectWithRetry(pool, options.maxAttempts || 5)
  try {
    const { rows } = await client.query('SELECT version() AS version')
    console.log(`Connected to recovery database "${config.database}" (${rows[0].version.split(' ')[0]} ${rows[0].version.split(' ')[1]})`)
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
  createRecoveryConnection,
  validateRecoveryConfig: validateConfig
}

if (require.main === module) {
  (async () => {
    try {
      const connection = await createRecoveryConnection()
      const { rows } = await connection.query('SELECT current_database() AS database, current_user AS user')
      console.log('Recovery database connection test successful:', rows[0])
      await connection.close()
      process.exit(0)
    } catch (error) {
      console.error('Recovery database connection test failed:', error.message)
      process.exit(1)
    }
  })()
}
