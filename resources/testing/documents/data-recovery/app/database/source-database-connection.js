const { getSourceDatabaseName } = require('../config/database-profiles')
const { createPostgresConnection } = require('./postgres-connection')
const { createDatabasePasswordProvider, getDatabaseAuthMode, getDatabaseTenantId } = require('./database-auth')

const getEnvironmentValue = (environment, key) => {
  const value = environment[key]
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
}

const validateSourceConfig = (options = {}) => {
  const environment = options.environment || process.env
  const serviceName = options.serviceName || getEnvironmentValue(environment, 'RECOVERY_SERVICE_NAME')
  const authMode = getDatabaseAuthMode(environment, 'source', serviceName)
  const missing = ['RECOVERY_SOURCE_DB_HOST', 'RECOVERY_SOURCE_DB_USER']
    .filter(key => !getEnvironmentValue(environment, key))

  if (authMode === 'password' && !getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_PASSWORD')) {
    missing.push('RECOVERY_SOURCE_DB_PASSWORD')
  }
  if (authMode === 'entra' && !getDatabaseTenantId(environment, 'source', serviceName)) {
    missing.push('RECOVERY_SOURCE_DB_TENANT_ID, RECOVERY_DB_TENANT_ID, or AZURE_TENANT_ID')
  }

  const hasDatabase = options.database || options.serviceName ||
    getEnvironmentValue(environment, 'RECOVERY_SOURCE_DATABASE')
  if (!hasDatabase) {
    missing.push('RECOVERY_SOURCE_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_SOURCE_ENV')
  }

  if (missing.length > 0) {
    throw new Error(`Missing source database configuration: ${missing.join(', ')}`)
  }
}

const buildSourceConfig = (options = {}) => {
  const environment = options.environment || process.env
  validateSourceConfig(options)
  const serviceName = options.serviceName || getEnvironmentValue(environment, 'RECOVERY_SERVICE_NAME')

  const sslMode = getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_SSL_MODE') || 'require'
  const useSsl = getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_SSL') !== 'false'
  const database = options.database || (options.serviceName
    ? getSourceDatabaseName(options.serviceName, environment)
    : getEnvironmentValue(environment, 'RECOVERY_SOURCE_DATABASE'))
  const password = createDatabasePasswordProvider(
    environment,
    'source',
    getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_PASSWORD'),
    { serviceName }
  )

  const config = {
    host: getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_HOST'),
    port: Number(getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_PORT') || 5432),
    database,
    user: getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_USER'),
    password,
    max: options.max || 5,
    keepAlive: true,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 60000,
    application_name: options.applicationName || 'database_archive_source'
  }

  if (useSsl) {
    config.ssl = sslMode === 'require'
      ? true
      : { rejectUnauthorized: sslMode !== 'no-verify' }
  }

  return config
}

const createSourceConnection = async (options = {}) => {
  const config = buildSourceConfig(options)
  return createPostgresConnection(config, {
    applicationName: options.applicationName || 'database_archive_source',
    connectionName: 'source database',
    maxAttempts: options.maxAttempts,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    max: options.max
  })
}

module.exports = {
  createSourceConnection,
  validateSourceConfig,
  buildSourceConfig
}
