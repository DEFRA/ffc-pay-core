const { Pool } = require('pg')

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

async function connectWithRetry (pool, options = {}) {
  const maxAttempts = options.maxAttempts || 5
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await pool.connect()
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

  throw new Error(`Failed to connect to ${options.connectionName || 'PostgreSQL'} after ${maxAttempts} attempts: ${lastError.message}`)
}

async function createPostgresConnection (databaseConfig, options = {}) {
  const config = {
    ...databaseConfig,
    max: options.max || databaseConfig.max || 5,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: options.applicationName || databaseConfig.application_name || 'ffc_pay_recovery'
  }
  const connectionName = options.connectionName || 'PostgreSQL database'

  console.log(`Connecting to ${connectionName}: ${JSON.stringify(maskConfig(config))}`)

  const pool = new Pool(config)
  pool.on('error', err => {
    console.error(`Unexpected error on ${connectionName} client for ${config.database}:`, err.message)
  })

  const client = await connectWithRetry(pool, { maxAttempts: options.maxAttempts, connectionName })
  try {
    const { rows } = await client.query('SELECT version() AS version')
    console.log(`Connected to ${connectionName} "${config.database}" (${rows[0].version.split(' ')[0]} ${rows[0].version.split(' ')[1]})`)
  } finally {
    client.release()
  }

  return {
    query: async (text, params) => await pool.query(text, params),
    pool,
    database: config.database,
    config: maskConfig(config),
    close: async () => await pool.end()
  }
}

module.exports = {
  createPostgresConnection
}
