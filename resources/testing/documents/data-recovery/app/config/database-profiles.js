const DEFAULT_TARGET_MODE = 'hosted'
const DEFAULT_LOCAL_DATABASE = 'ffc_pay_local_recovery'

function getValue (environment, key) {
  const value = environment[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function validateEnvironment (value, variableName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`${variableName} must contain only letters, numbers, hyphens, and underscores`)
  }
  return value
}

function getServiceDatabaseName (serviceName, environment, variableName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(serviceName)) {
    throw new Error(`Invalid service name "${serviceName}"`)
  }
  return `${serviceName}-${validateEnvironment(environment, variableName)}`
}

function resolveDatabasePair (baseName, sourceEnvironment, targetEnvironment) {
  return {
    baseName,
    sourceDatabase: getServiceDatabaseName(baseName, sourceEnvironment, 'SOURCE_ENV'),
    targetDatabase: getServiceDatabaseName(baseName, targetEnvironment, 'TARGET_ENV')
  }
}

function getSourceDatabaseName (serviceName, environment = process.env) {
  const explicitDatabase = getValue(environment, 'RECOVERY_SOURCE_DATABASE')
  if (explicitDatabase) {
    return explicitDatabase
  }

  const sourceEnvironment = getValue(environment, 'RECOVERY_SOURCE_ENV')
  if (!serviceName || !sourceEnvironment) {
    throw new Error('Set RECOVERY_SOURCE_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_SOURCE_ENV')
  }

  return getServiceDatabaseName(serviceName, sourceEnvironment, 'RECOVERY_SOURCE_ENV')
}

function getTargetMode (environment = process.env) {
  const configuredMode = getValue(environment, 'RECOVERY_TARGET_MODE')
  const targetEnvironment = getValue(environment, 'RECOVERY_TARGET_ENV')
  const mode = configuredMode || (targetEnvironment === 'local' ? 'local' : DEFAULT_TARGET_MODE)
  if (!['local', 'hosted'].includes(mode)) {
    throw new Error(`Invalid RECOVERY_TARGET_MODE "${mode}". Must be one of: local, hosted`)
  }
  return mode
}

function resolveTargetProfile (serviceName, environment = process.env) {
  const mode = getTargetMode(environment)

  if (mode === 'local') {
    const targetEnvironment = getValue(environment, 'RECOVERY_TARGET_ENV')
    const database = getValue(environment, 'RECOVERY_TARGET_DATABASE') ||
      (serviceName && targetEnvironment
        ? getServiceDatabaseName(serviceName, targetEnvironment, 'RECOVERY_TARGET_ENV')
        : getValue(environment, 'LOCAL_DB_NAME') || DEFAULT_LOCAL_DATABASE)
    const config = {
      host: getValue(environment, 'LOCAL_DB_HOST') || 'localhost',
      port: Number(getValue(environment, 'LOCAL_DB_PORT') || 5467),
      user: getValue(environment, 'LOCAL_DB_USER') || 'postgres',
      password: getValue(environment, 'LOCAL_DB_PASSWORD') || 'ppp',
      database
    }
    return { mode, config }
  }

  const targetEnvironment = getValue(environment, 'RECOVERY_TARGET_ENV')
  const database = getValue(environment, 'RECOVERY_TARGET_DATABASE') ||
    (serviceName && targetEnvironment
      ? getServiceDatabaseName(serviceName, targetEnvironment, 'RECOVERY_TARGET_ENV')
      : undefined)
  if (!database) {
    throw new Error('Set RECOVERY_TARGET_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_TARGET_ENV')
  }
  const config = {
    host: getValue(environment, 'RECOVERY_TARGET_DB_HOST'),
    port: Number(getValue(environment, 'RECOVERY_TARGET_DB_PORT') || 5432),
    user: getValue(environment, 'RECOVERY_TARGET_DB_USER'),
    password: getValue(environment, 'RECOVERY_TARGET_DB_PASSWORD'),
    database
  }
  const missing = Object.entries(config)
    .filter(([key, value]) => !value && key !== 'port')
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`Missing hosted target database configuration: ${missing.join(', ')}`)
  }

  const sslMode = getValue(environment, 'RECOVERY_TARGET_DB_SSL_MODE') || 'require'
  const useSsl = getValue(environment, 'RECOVERY_TARGET_DB_SSL') !== 'false'
  if (useSsl) {
    config.ssl = sslMode === 'require'
      ? true
      : { rejectUnauthorized: sslMode !== 'no-verify' }
  }

  return { mode, config }
}

module.exports = {
  getServiceDatabaseName,
  getSourceDatabaseName,
  getTargetMode,
  resolveDatabasePair,
  resolveTargetProfile
}
