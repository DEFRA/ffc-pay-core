const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { DefaultAzureCredential } = require('@azure/identity')
const ENVIRONMENT_DEFINITIONS = require('../constants/environment-definitions')
const config = require('../config')

function parseShellExports (content) {
  const values = {}
  if (!content) return values

  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    let parsedValue = rawValue.trim()

    if ((parsedValue.startsWith('"') && parsedValue.endsWith('"')) ||
        (parsedValue.startsWith("'") && parsedValue.endsWith("'"))) {
      parsedValue = parsedValue.slice(1, -1)
    }

    values[key] = parsedValue
  }

  return values
}

function loadEnvironmentFiles () {
  const candidateFiles = [
    path.join(process.env.HOME || '', '.bashrc'),
    path.join(process.env.HOME || '', '.bash_profile'),
    path.join(process.env.HOME || '', '.profile'),
    path.join(process.env.HOME || '', '.zshrc')
  ].filter(Boolean)

  const fileSet = new Set()
  const loaded = {}

  for (const candidate of candidateFiles) {
    if (!candidate || fileSet.has(candidate)) continue
    fileSet.add(candidate)

    try {
      if (!fs.existsSync(candidate)) continue
      const content = fs.readFileSync(candidate, 'utf8')
      Object.assign(loaded, parseShellExports(content))
    } catch (err) {
      // Ignore unreadable env files and continue.
    }
  }

  return loaded
}

function getShellEnvironmentOverrides () {
  return loadEnvironmentFiles()
}

function normaliseEnvironmentName (value) {
  const standard = (value || '').toString().trim().toLowerCase().replace(/[_-]/g, '')
  if (!standard) return 'dev'
  if (standard === 'prd') return 'prd'
  if (standard === 'pre') return 'pre'
  if (standard === 'test') return 'test'
  if (standard === 'dev') return 'dev'
  if (standard === 'recovery' || standard === 'recoverydb') return 'recovery'
  return standard
}

function getConfiguredEnvironmentDefinitions () {
  return {
    ...ENVIRONMENT_DEFINITIONS,
    ...(config?.database?.environments || {})
  }
}

function getEnvironmentSuffix (environment) {
  const env = normaliseEnvironmentName(environment)
  return getConfiguredEnvironmentDefinitions()[env]?.suffix || `-${env}`
}

function getAllEnvironmentNames () {
  return Object.keys(getConfiguredEnvironmentDefinitions())
}

function resolveEnvironmentDefinition (environment) {
  const env = normaliseEnvironmentName(environment)
  return getConfiguredEnvironmentDefinitions()[env] || ENVIRONMENT_DEFINITIONS.dev
}

function getEnvironmentDefaults () {
  const sourceEnvironment = normaliseEnvironmentName(process.env.DB_SOURCE_ENV || config.sourceEnvironment || 'test')
  const targetEnvironment = normaliseEnvironmentName(process.env.DB_TARGET_ENV || config.targetEnvironment || 'dev')

  return {
    source: {
      environment: sourceEnvironment,
      suffix: getEnvironmentSuffix(sourceEnvironment)
    },
    target: {
      environment: targetEnvironment,
      suffix: getEnvironmentSuffix(targetEnvironment)
    }
  }
}

function resolveTenantId (definition, shellOverrides = {}) {
  const candidateNames = [
    `${definition.tenantEnvVar.replace(/_TENANT$/, '_TENANT_ID')}`,
    'AZURE_TENANT_ID',
    'DEV_TENANT_ID',
    'TEST_TENANT_ID',
    'PRE_TENANT_ID',
    'PRD_TENANT_ID',
    'TENANT_ID',
    definition.tenantEnvVar
  ]

  for (const candidateName of candidateNames) {
    const value = process.env[candidateName] || shellOverrides[candidateName]
    if (value && value.toString().trim()) {
      if (/^[0-9a-fA-F-]{36}$/.test(value.trim())) {
        return value.trim()
      }
      if (!/^([A-Za-z0-9-]+)$/.test(value.trim()) || value.trim().toLowerCase().includes('tenant')) {
        continue
      }
      return value.trim()
    }
  }

  return undefined
}

function resolveDatabaseEnvironmentConfig (options = {}) {
  const explicitEnvironment = options.environment || options.sourceEnvironment || options.targetEnvironment || process.env.DB_SOURCE_ENV || process.env.DB_TARGET_ENV || config.sourceEnvironment || config.targetEnvironment || 'dev'
  const environment = normaliseEnvironmentName(explicitEnvironment)
  const definition = resolveEnvironmentDefinition(environment)
  const shellOverrides = getShellEnvironmentOverrides()

  const host = options.host || process.env[definition.hostEnvVar] || shellOverrides[definition.hostEnvVar] || process.env.POSTGRES_HOST || ''
  const username = options.username ||
    process.env[definition.adminEnvVar] || shellOverrides[definition.adminEnvVar] ||
    process.env.RECOVERY_DB_ADMIN || shellOverrides.RECOVERY_DB_ADMIN ||
    process.env.POSTGRES_USER || 'postgres'
  const password = definition.useAzureAd === false
    ? (options.password || process.env[definition.passwordEnvVar] || shellOverrides[definition.passwordEnvVar] || '')
    : undefined
  const tenantId = definition.useAzureAd === false
    ? undefined
    : (options.tenantId || resolveTenantId(definition, shellOverrides))

  return {
    environment,
    suffix: getEnvironmentSuffix(environment),
    host,
    username,
    password,
    tenantId,
    useAzureAd: definition.useAzureAd !== false,
    port: options.port || process.env.POSTGRES_PORT || config.database.port || 5432,
    ssl: options.ssl !== undefined ? options.ssl : true,
    applicationName: options.applicationName || 'database_dump',
    hostEnvVar: definition.hostEnvVar,
    adminEnvVar: definition.adminEnvVar,
    tenantEnvVar: definition.tenantEnvVar,
    passwordEnvVar: definition.passwordEnvVar
  }
}

function buildDatabasePatterns (environments = []) {
  const envs = (environments.length > 0 ? environments : getAllEnvironmentNames())
    .map(normaliseEnvironmentName)
    .filter(Boolean)

  const uniqueEnvs = [...new Set(envs)]
  return uniqueEnvs.map(env => {
    const suffix = getEnvironmentSuffix(env)
    return `ffc-doc-%${suffix}`
  }).concat(uniqueEnvs.map(env => {
    const suffix = getEnvironmentSuffix(env)
    return `ffc-pay-%${suffix}`
  }))
}

async function createConnection (database = 'postgres', options = {}) {
  const environmentConfig = resolveDatabaseEnvironmentConfig(options)

  console.log(`---- CONNECTION ATTEMPT STARTED [${new Date().toISOString()}] ----`)
  console.log(`Attempting to connect to database: ${database} on ${environmentConfig.environment} environment`)

  if (!environmentConfig.host) {
    const requiredHosts = getAllEnvironmentNames()
      .map(env => ENVIRONMENT_DEFINITIONS[env].hostEnvVar)
      .join(', ')
    console.log(`ERROR: Missing PostgreSQL host environment variable. Expected one of: ${requiredHosts}`)
    throw new Error(`No PostgreSQL host environment variable found for ${environmentConfig.environment}. Expected one of: ${requiredHosts}`)
  }

  const username = options.username || environmentConfig.username
  console.log(`Using database username: ${username}`)

  let password
  if (environmentConfig.useAzureAd) {
    password = await getEnhancedAzureToken({ ...options, environment: environmentConfig.environment })
  } else {
    if (!environmentConfig.password) {
      throw new Error(`Password authentication required for ${environmentConfig.environment} but ${environmentConfig.passwordEnvVar} is not set.`)
    }
    password = environmentConfig.password
    console.log(`Using password authentication for ${environmentConfig.environment}`)
  }

  const config = {
    user: username,
    password,
    host: environmentConfig.host,
    port: environmentConfig.port,
    database,
    ssl: environmentConfig.ssl,
    max: options.max || 10,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: environmentConfig.applicationName
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
    console.log(`Performing DNS lookup for ${environmentConfig.host}...`)

    const connectionStartTime = Date.now()
    console.log(`Connection attempt started at ${connectionStartTime}`)

    const client = await pool.connect()
    const authMethod = environmentConfig.useAzureAd ? 'Azure AD authentication' : 'password authentication'
    console.log(`Connected to PostgreSQL database "${database}" using ${authMethod} in ${Date.now() - connectionStartTime}ms`)
    client.release()

    return {
      query: async (text, params) => await pool.query(text, params),
      pool,
      database,
      config: {
        host: environmentConfig.host,
        port: environmentConfig.port,
        database,
        username
      },
      token: password,
      environment: environmentConfig.environment
    }
  } catch (err) {
    if (err.message?.includes('Azure AD authentication failed')) {
      throw err
    }

    console.error(`Error connecting to the database "${database}" [${new Date().toISOString()}]:`, err.message)
    console.error(`Error code: ${err.code}, Error name: ${err.name}`)
    console.error(`Connection parameters: host=${config.host}, port=${config.port}, database=${config.database}, username=${config.user}`)

    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      console.error('Connection timeout detected. This may be due to firewall restrictions or network issues.')
      console.error('Please check Azure PostgreSQL firewall rules to ensure your IP address is allowed.')
    }

    throw err
  }
}

function summariseCredentialErrors (error) {
  const errors = error?.errors || [error]
  return errors.map(e => {
    const name = e?.name || 'Error'
    const message = e?.message || String(e)
    if (message.includes('EnvironmentCredential')) {
      return `${name}: EnvironmentCredential unavailable. Expected env vars such as AZURE_CLIENT_ID/AZURE_CLIENT_SECRET, AZURE_TENANT_ID, or AZURE_USERNAME/AZURE_PASSWORD.`
    }
    if (message.includes('ManagedIdentityCredential')) {
      return `${name}: Managed identity unavailable. No IMDS endpoint reachable; this is expected outside Azure. Set AZURE_CLIENT_ID/AZURE_CLIENT_SECRET or use \\"az login\\".`
    }
    if (message.includes('AzureCliCredential') || message.includes('az login')) {
      return `${name}: Azure CLI credential unavailable. Run \\"az login\\" and select the correct subscription/tenant.`
    }
    if (message.includes('PowerShell')) {
      return `${name}: Azure PowerShell credential unavailable.`
    }
    return `${name}: ${message.split('\n')[0]}`
  }).join('\n')
}

function formatAzureAuthFailure (environmentConfig, error) {
  const hostEnvVar = environmentConfig?.hostEnvVar || 'POSTGRES_HOST'
  const adminEnvVar = environmentConfig?.adminEnvVar || 'POSTGRES_USER'
  const tenantEnvVar = environmentConfig?.tenantEnvVar || 'AZURE_TENANT_ID'

  return [
    '',
    'Azure AD authentication failed',
    `Environment: ${environmentConfig?.environment || 'unknown'}`,
    '',
    'Required environment variables:',
    `  Host:    ${hostEnvVar} (current: ${process.env[hostEnvVar] ? 'set' : 'NOT SET'})`,
    `  Admin:   ${adminEnvVar} (current: ${process.env[adminEnvVar] ? 'set' : 'NOT SET'})`,
    `  Tenant:  ${tenantEnvVar} or ${tenantEnvVar}_ID (current: ${process.env[tenantEnvVar] || process.env[`${tenantEnvVar}_ID`] ? 'set' : 'NOT SET'})`,
    '',
    'To authenticate you need one of the following:',
    '  1. Service principal: set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, and AZURE_TENANT_ID',
    '  2. Azure CLI: run "az login" and select the correct subscription',
    '  3. Managed identity: only available inside Azure (VM, Container App, etc.)',
    '',
    'Credential failure details:',
    summariseCredentialErrors(error)
  ].join('\n')
}

async function getEnhancedAzureToken (options = {}) {
  const environmentConfig = resolveDatabaseEnvironmentConfig(options)

  try {
    console.log(`Authenticating to Azure AD for environment: ${environmentConfig.environment}`)

    const credential = new DefaultAzureCredential({
      tenantId: environmentConfig.tenantId,
      managedIdentityClientId: process.env.AZURE_CLIENT_ID,
      excludeEnvironmentCredential: false,
      excludeInteractiveBrowserCredential: true,
      disableInstanceDiscovery: false
    })

    const startTime = Date.now()
    const token = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default')
    console.log(`Azure AD token acquired in ${Date.now() - startTime}ms`)
    return token.token
  } catch (error) {
    throw new Error(formatAzureAuthFailure(environmentConfig, error))
  }
}

async function listDatabases (patterns = null, options = {}) {
  const environmentConfig = resolveDatabaseEnvironmentConfig({
    ...options,
    environment: options.environment || options.sourceEnvironment || getEnvironmentDefaults().source.environment
  })
  const connection = await createConnection('postgres', { ...options, environment: environmentConfig.environment })

  if (!patterns) {
    const sourceEnvironment = environmentConfig.environment
    const targetEnvironment = options.targetEnvironment || getEnvironmentDefaults().target.environment
    patterns = buildDatabasePatterns([sourceEnvironment, targetEnvironment])
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
  const defaults = getEnvironmentDefaults()
  const allDatabases = await listDatabases(null, {
    sourceEnvironment: defaults.source.environment,
    targetEnvironment: defaults.target.environment
  })
  const devDatabases = allDatabases.filter(db => db.endsWith('-dev'))
  const testDatabases = allDatabases.filter(db => db.endsWith('-test'))

  return { devDatabases, testDatabases }
}

async function testConnection (environment, database = 'postgres', options = {}) {
  const resolvedEnvironment = normaliseEnvironmentName(environment)
  const connection = await createConnection(database, { ...options, environment: resolvedEnvironment })

  try {
    const result = await connection.query('SELECT 1 AS ok, current_database() AS current_database, current_user AS current_user')
    return {
      environment: resolvedEnvironment,
      database,
      ok: true,
      result: result.rows[0],
      host: connection.config.host,
      port: connection.config.port
    }
  } finally {
    if (connection?.pool) {
      await connection.pool.end()
    }
  }
}

const getDatabaseEnvironmentDefaults = getEnvironmentDefaults

module.exports = {
  ENVIRONMENT_DEFINITIONS,
  normaliseEnvironmentName,
  resolveDatabaseEnvironmentConfig,
  getEnvironmentSuffix,
  getEnvironmentDefaults,
  getDatabaseEnvironmentDefaults,
  buildDatabasePatterns,
  createConnection,
  listDatabases,
  getDevAndTestDatabases,
  testConnection,
  getEnhancedAzureToken,
  getDatabaseStats,
  loadEnvironmentFiles
}

// Run standalone if executed directly
if (require.main === module) {
  (async () => {
    try {
      console.log('Testing database connection...')
      const defaults = getEnvironmentDefaults()
      console.log('Configured source environment:', defaults.source.environment)
      console.log('Configured target environment:', defaults.target.environment)

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
