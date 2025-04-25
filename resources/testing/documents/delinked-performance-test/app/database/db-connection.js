const { Pool } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')

async function createConnection(database) {
  if (!database) {
    throw new Error('Database name is required but was undefined')
  }

  // Debug environment variables
  console.log('Environment variables:')
  console.log(`POSTGRES_DEV_HOST: ${process.env.POSTGRES_DEV_HOST}`)
  console.log(`POSTGRES_USER: ${process.env.POSTGRES_USER}`)
  console.log(`POSTGRES_DEV_ADMIN: ${process.env.POSTGRES_DEV_ADMIN}`)
  console.log(`POSTGRES_PORT: ${process.env.POSTGRES_PORT}`)
  console.log(`DEV_TENANT_ID: ${process.env.DEV_TENANT_ID}`)
  console.log(`Database name: ${database}`)

  if (!process.env.POSTGRES_DEV_HOST) {
    throw new Error('POSTGRES_DEV_HOST environment variable is required')
  }

  const credential = new DefaultAzureCredential({
    tenantId: process.env.DEV_TENANT_ID // Same tenant for all connections in dev and test
  })

  const resource = 'https://ossrdbms-aad.database.windows.net'
  const token = await credential.getToken(resource)
  const azureUserEnv = process.env.POSTGRES_DEV_ADMIN || process.env.POSTGRES_USER;
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
    idleTimeoutMillis: 30000
  }

  console.log(`Attempting to connect to ${process.env.POSTGRES_DEV_HOST} as ${username}`)

  const pool = new Pool(config)

  pool.on('error', (err) => {
    console.error(`Unexpected error on client for ${database}`, err)
  })

  try {
    const client = await pool.connect()
    console.log(`Connected to PostgreSQL database "${database}" using Azure AD authentication`)
    client.release()
    return {
      query: (text, params) => pool.query(text, params),
      pool
    }
  } catch (err) {
    console.error(`Error connecting to the database "${database}":`, err.stack)
    throw err
  }
}

module.exports = { createConnection }