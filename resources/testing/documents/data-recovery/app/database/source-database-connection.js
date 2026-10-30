const { getSourceDatabaseName } = require('../config/database-profiles')
const { createPostgresConnection } = require('./postgres-connection')

function getEnvironmentValue (environment, key) {
  const value = environment[key]
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
}

function validateSourceConfig (options = {}) {
  const environment = options.environment || process.env
  const missing = ['RECOVERY_SOURCE_DB_HOST', 'RECOVERY_SOURCE_DB_USER', 'RECOVERY_SOURCE_DB_PASSWORD']
    .filter(key => !getEnvironmentValue(environment, key))

  const hasDatabase = options.database || options.serviceName ||
    getEnvironmentValue(environment, 'RECOVERY_SOURCE_DATABASE')
  if (!hasDatabase) {
    missing.push('RECOVERY_SOURCE_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_SOURCE_ENV')
  }

  if (missing.length > 0) {
    throw new Error(`Missing source database configuration: ${missing.join(', ')}`)
  }
}

function buildSourceConfig (options = {}) {
  const environment = options.environment || process.env
  validateSourceConfig(options)

  const sslMode = getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_SSL_MODE') || 'require'
  const useSsl = getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_SSL') !== 'false'
  const database = options.database || (options.serviceName
    ? getSourceDatabaseName(options.serviceName, environment)
    : getEnvironmentValue(environment, 'RECOVERY_SOURCE_DATABASE'))

  const config = {
    host: getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_HOST'),
    port: Number(getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_PORT') || 5432),
    database,
    user: getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_USER'),
    password: getEnvironmentValue(environment, 'RECOVERY_SOURCE_DB_PASSWORD'),
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

async function createSourceConnection (options = {}) {
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
