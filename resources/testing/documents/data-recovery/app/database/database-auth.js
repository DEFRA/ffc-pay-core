const { DefaultAzureCredential } = require('@azure/identity')
const databaseRefresh = require('../config/database-refresh')

const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default'

const getEnvironmentValue = (environment, key) => {
  const value = environment[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const getDatabaseAuthMode = (environment, side, serviceName, config = databaseRefresh) => {
  const key = side === 'source' ? 'RECOVERY_SOURCE_DB_AUTH' : 'RECOVERY_TARGET_DB_AUTH'
  const defaultMode = side === 'source' ? config.DEFAULT_SOURCE_AUTH : config.DEFAULT_HOSTED_TARGET_AUTH
  const override = config.DATABASE_AUTH_OVERRIDES?.[serviceName || environment.RECOVERY_SERVICE_NAME]?.[side]
  const mode = (override?.mode || getEnvironmentValue(environment, key) || defaultMode || 'entra').toLowerCase()

  if (!['password', 'entra'].includes(mode)) {
    throw new Error(`${key} must be either "password" or "entra"`)
  }

  return mode
}

const getDatabaseTenantId = (environment, side, serviceName, config = databaseRefresh) => {
  const key = side === 'source' ? 'RECOVERY_SOURCE_DB_TENANT_ID' : 'RECOVERY_TARGET_DB_TENANT_ID'
  const override = config.DATABASE_AUTH_OVERRIDES?.[serviceName || environment.RECOVERY_SERVICE_NAME]?.[side]
  return override?.tenantId || getEnvironmentValue(environment, key) ||
    getEnvironmentValue(environment, 'RECOVERY_DB_TENANT_ID') ||
    getEnvironmentValue(environment, 'AZURE_TENANT_ID')
}

const createDatabasePasswordProvider = (environment, side, password, options = {}) => {
  const serviceName = options.serviceName || getEnvironmentValue(environment, 'RECOVERY_SERVICE_NAME')
  const config = options.config || databaseRefresh
  const mode = options.mode || getDatabaseAuthMode(environment, side, serviceName, config)
  if (mode === 'password') {
    return password
  }

  const tenantId = options.tenantId || getDatabaseTenantId(environment, side, serviceName, config)
  if (!tenantId) {
    const key = side === 'source' ? 'RECOVERY_SOURCE_DB_TENANT_ID' : 'RECOVERY_TARGET_DB_TENANT_ID'
    const authKey = side === 'source' ? 'RECOVERY_SOURCE_DB_AUTH' : 'RECOVERY_TARGET_DB_AUTH'
    throw new Error(`Set ${key}, RECOVERY_DB_TENANT_ID, or AZURE_TENANT_ID when ${authKey}=entra`)
  }

  const credentialOptions = {
    tenantId,
    excludeInteractiveBrowserCredential: true
  }
  const managedIdentityClientId = getEnvironmentValue(environment, 'AZURE_CLIENT_ID')
  if (managedIdentityClientId) credentialOptions.managedIdentityClientId = managedIdentityClientId

  const credentialFactory = options.credentialFactory || (credentialOptions => new DefaultAzureCredential(credentialOptions))
  const credential = credentialFactory(credentialOptions)
  return async () => {
    let token
    try {
      token = await credential.getToken(POSTGRES_SCOPE)
    } catch (error) {
      throw new Error(`Could not acquire Entra token for ${side} PostgreSQL connection in tenant "${tenantId}": ${error.message}`)
    }

    if (!token?.token) {
      throw new Error(`Azure Identity returned no Entra token for ${side} PostgreSQL connection in tenant "${tenantId}"`)
    }

    return token.token
  }
}

module.exports = {
  POSTGRES_SCOPE,
  getDatabaseAuthMode,
  getDatabaseTenantId,
  createDatabasePasswordProvider
}
