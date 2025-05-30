const { DefaultAzureCredential } = require('@azure/identity')
const { Client } = require('pg')
const dns = require('dns')
const net = require('net')
const { promisify } = require('util')
const { exec } = require('child_process')

const execPromise = promisify(exec)
const dnsLookup = promisify(dns.lookup)

// Configuration - update these values
const config = {
  host: process.env.POSTGRES_DEV_HOST || 'devffcdbsps1001.postgres.database.azure.com',
  port: process.env.POSTGRES_PORT || 5432,
  database: 'postgres',
  user: process.env.POSTGRES_DEV_ADMIN || process.env.POSTGRES_USER || 'AG-Azure-FFC-DEVFFCDBSSQL1001-AADAdmins',
  connectionTimeoutMillis: 15000
}

// Set the maximum timeout for the entire test
const MAX_TEST_TIMEOUT = 30000
let timeoutHandle

async function runDiagnostics () {
  console.log(`==== Azure PostgreSQL Connection Diagnostics (${new Date().toISOString()}) ====\n`)

  // Set overall test timeout
  timeoutHandle = setTimeout(() => {
    console.error('\n⚠️ OVERALL TEST TIMEOUT - Process took too long')
    process.exit(1)
  }, MAX_TEST_TIMEOUT)

  try {
    // Step 1: Check environment variables
    await checkEnvironmentVariables()

    // Step 2: Basic connectivity tests
    await runNetworkTests()

    // Step 3: Azure authentication test
    const token = await testAzureAuthentication()

    // Step 4: Database connection test
    await testDatabaseConnection(token)

    console.log('\n✅ All tests completed successfully!')
  } catch (error) {
    console.error(`\n❌ Diagnostic failed at step: ${error.step || 'unknown'}`)
    console.error(`Error details: ${error.message}`)
  } finally {
    clearTimeout(timeoutHandle)
  }
}

async function checkEnvironmentVariables () {
  console.log('Step 1: Checking environment variables...')

  const requiredVars = ['POSTGRES_DEV_HOST']
  const missingVars = requiredVars.filter(varName => !process.env[varName])

  if (missingVars.length > 0) {
    const error = new Error(`Missing required environment variables: ${missingVars.join(', ')}`)
    error.step = 'environment_variables'
    throw error
  }

  console.log('✅ Environment variables check passed')
  console.log(`Host: ${config.host}`)
  console.log(`User: ${config.user}`)
}

async function runNetworkTests () {
  console.log('\nStep 2: Running network tests...')

  // 2.1: DNS lookup
  console.log(`Testing DNS resolution for ${config.host}...`)
  try {
    const startTime = Date.now()
    const dnsResult = await dnsLookup(config.host)
    console.log(`✅ DNS lookup successful: ${config.host} -> ${dnsResult.address} (${Date.now() - startTime}ms)`)

    // Save the IP for later tests
    config.ip = dnsResult.address
  } catch (error) {
    error.step = 'dns_lookup'
    error.message = `Failed to resolve hostname ${config.host}: ${error.message}`
    throw error
  }

  // 2.2: Basic TCP connection test
  console.log(`Testing TCP connection to ${config.host}:${config.port}...`)
  try {
    await testTcpConnection(config.host, config.port)
    console.log('✅ TCP connection test successful')
  } catch (error) {
    error.step = 'tcp_connection'
    error.message = `Cannot establish TCP connection to ${config.host}:${config.port} - ${error.message}`
    throw error
  }

  // 2.3: Traceroute for additional network path info
  console.log('Running traceroute for network path info (may take a moment)...')
  try {
    const { stdout } = await execPromise(`traceroute -m 15 -n ${config.host}`)
    console.log('Traceroute results:')
    console.log(stdout)
  } catch (error) {
    console.log(`Note: Traceroute could not complete, but this is not a critical failure: ${error.message}`)
  }
}

function testTcpConnection (host, port) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const socket = new net.Socket()
    const connectionTimeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Connection timed out after ${Date.now() - startTime}ms`))
    }, 5000)

    socket.connect(port, host, () => {
      clearTimeout(connectionTimeout)
      console.log(`TCP connected in ${Date.now() - startTime}ms`)
      socket.end()
      resolve()
    })

    socket.on('error', (error) => {
      clearTimeout(connectionTimeout)
      reject(error)
    })
  })
}

async function testAzureAuthentication () {
  console.log('\nStep 3: Testing Azure authentication...')

  try {
    console.log('Creating DefaultAzureCredential...')
    const credential = new DefaultAzureCredential()

    console.log('Requesting Azure token for PostgreSQL...')
    const startTime = Date.now()
    const token = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default')
    console.log(`✅ Azure token acquired successfully (${Date.now() - startTime}ms)`)

    return token.token
  } catch (error) {
    error.step = 'azure_authentication'
    error.message = `Azure authentication failed: ${error.message}`
    throw error
  }
}

async function testDatabaseConnection (token) {
  console.log('\nStep 4: Testing PostgreSQL connection...')

  // Create PostgreSQL client with the token
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: token,
    ssl: true,
    connectionTimeoutMillis: config.connectionTimeoutMillis
  })

  try {
    console.log('Attempting database connection...')
    const startTime = Date.now()
    await client.connect()
    console.log(`✅ Database connection established successfully (${Date.now() - startTime}ms)`)

    // Test a simple query
    console.log('Testing with simple query...')
    const queryStartTime = Date.now()
    const result = await client.query('SELECT version()')
    console.log(`✅ Query executed successfully (${Date.now() - queryStartTime}ms)`)
    console.log(`PostgreSQL version: ${result.rows[0].version}`)

    await client.end()
  } catch (error) {
    error.step = 'database_connection'
    error.message = `Database connection failed: ${error.message}`
    throw error
  }
}

runDiagnostics().catch(error => {
  console.error('Unhandled error in diagnostics:', error)
  process.exit(1)
})
