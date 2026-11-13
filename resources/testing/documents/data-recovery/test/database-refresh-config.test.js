const assert = require('node:assert/strict')
const test = require('node:test')
const databaseRefresh = require('../app/config/database-refresh')
const { getServiceDatabaseName, getSourceDatabaseName, getTargetMode, resolveDatabasePair, resolveTargetProfile } = require('../app/config/database-profiles')
const { buildSourceConfig } = require('../app/database/source-database-connection')
const { POSTGRES_SCOPE, createDatabasePasswordProvider, getDatabaseAuthMode } = require('../app/database/database-auth')

test('refresh environments use shell overrides with prd/local defaults', () => {
  assert.deepEqual(databaseRefresh.resolveRefreshEnvironments({}), {
    SOURCE_ENV: 'prd',
    TARGET_ENV: 'local'
  })
  assert.deepEqual(databaseRefresh.resolveRefreshEnvironments({
    DATABASE_REFRESH_SOURCE_ENV: 'pre',
    DATABASE_REFRESH_TARGET_ENV: 'dev'
  }), {
    SOURCE_ENV: 'pre',
    TARGET_ENV: 'dev'
  })
  assert.deepEqual(databaseRefresh.resolveRefreshEnvironments({
    DATABASE_REFRESH_SOURCE_ENV: '  ',
    DATABASE_REFRESH_TARGET_ENV: '  '
  }), {
    SOURCE_ENV: 'prd',
    TARGET_ENV: 'local'
  })
})

test('refresh config keeps base names separate from environment suffixes', () => {
  assert.equal(databaseRefresh.SOURCE_ENV, 'prd')
  assert.equal(databaseRefresh.TARGET_ENV, 'local')
  assert.ok(databaseRefresh.DATABASE_NAMES.length > 0)
  assert.equal(new Set(databaseRefresh.DATABASE_NAMES).size, databaseRefresh.DATABASE_NAMES.length)
  assert.ok(databaseRefresh.DATABASE_NAMES.every(name => !name.endsWith(`-${databaseRefresh.SOURCE_ENV}`) && !name.endsWith(`-${databaseRefresh.TARGET_ENV}`)))

  assert.deepEqual(
    resolveDatabasePair('ffc-pay-processing', databaseRefresh.SOURCE_ENV, databaseRefresh.TARGET_ENV),
    {
      baseName: 'ffc-pay-processing',
      sourceDatabase: 'ffc-pay-processing-prd',
      targetDatabase: 'ffc_pay_processing'
    }
  )
})

test('source database can be selected explicitly without a service name', () => {
  assert.equal(getSourceDatabaseName(null, { RECOVERY_SOURCE_DATABASE: 'payments_source' }), 'payments_source')
})

test('service database requires an explicit source environment', () => {
  assert.equal(getSourceDatabaseName('payments', { RECOVERY_SOURCE_ENV: 'staging' }), 'payments-staging')
  assert.throws(() => getSourceDatabaseName('payments', {}), /RECOVERY_SOURCE_ENV/)
  assert.throws(() => getSourceDatabaseName('payments', { RECOVERY_SOURCE_ENV: 'prd;DROP' }), /RECOVERY_SOURCE_ENV/)
})

test('source connection accepts the generic source configuration', () => {
  const config = buildSourceConfig({
    serviceName: 'payments',
    environment: {
      RECOVERY_SOURCE_DB_HOST: 'source.example',
      RECOVERY_SOURCE_DB_USER: 'reader',
      RECOVERY_SOURCE_DB_PASSWORD: 'secret',
      RECOVERY_SOURCE_DB_AUTH: 'password',
      RECOVERY_SOURCE_ENV: 'test'
    }
  })

  assert.equal(config.database, 'payments-test')
  assert.equal(config.ssl, true)
})

test('source connection supports tenant-specific Entra authentication without a password', () => {
  const config = buildSourceConfig({
    serviceName: 'payments',
    environment: {
      RECOVERY_SOURCE_DB_AUTH: 'entra',
      RECOVERY_SOURCE_DB_TENANT_ID: 'source-tenant',
      RECOVERY_SOURCE_DB_HOST: 'source.example',
      RECOVERY_SOURCE_DB_USER: 'reader',
      RECOVERY_SOURCE_ENV: 'prd'
    }
  })

  assert.equal(config.database, 'payments-prd')
  assert.equal(typeof config.password, 'function')
  assert.throws(() => buildSourceConfig({
    serviceName: 'payments',
    environment: {
      RECOVERY_SOURCE_DB_AUTH: 'entra',
      RECOVERY_SOURCE_DB_HOST: 'source.example',
      RECOVERY_SOURCE_DB_USER: 'reader',
      RECOVERY_SOURCE_ENV: 'prd'
    }
  }), /RECOVERY_SOURCE_DB_TENANT_ID/)
})

test('configured per-service password auth overrides the default Entra mode', () => {
  const config = {
    ...databaseRefresh,
    DATABASE_AUTH_OVERRIDES: {
      legacy: { source: { mode: 'password' } }
    }
  }
  const environment = {
    RECOVERY_SOURCE_DB_HOST: 'source.example',
    RECOVERY_SOURCE_DB_USER: 'reader',
    RECOVERY_SOURCE_DB_PASSWORD: 'secret',
    RECOVERY_SOURCE_DB_AUTH: 'entra',
    RECOVERY_SOURCE_ENV: 'prd'
  }

  assert.equal(getDatabaseAuthMode(environment, 'source', 'legacy', config), 'password')
  assert.equal(getDatabaseAuthMode(environment, 'source', 'other', config), 'entra')
})

test('Entra password provider requests a PostgreSQL token using the configured tenant', async () => {
  let credentialOptions
  const scopes = []
  const passwordProvider = createDatabasePasswordProvider(
    {
      RECOVERY_SOURCE_DB_AUTH: 'entra',
      RECOVERY_SOURCE_DB_TENANT_ID: 'source-tenant'
    },
    'source',
    undefined,
    {
      credentialFactory: options => {
        credentialOptions = options
        return {
          getToken: async scope => {
            scopes.push(scope)
            return { token: `access-token-${scopes.length}` }
          }
        }
      }
    }
  )

  assert.equal(await passwordProvider(), 'access-token-1')
  assert.equal(await passwordProvider(), 'access-token-2')
  assert.equal(credentialOptions.tenantId, 'source-tenant')
  assert.deepEqual(scopes, [POSTGRES_SCOPE, POSTGRES_SCOPE])
})

test('local target without a service name uses the configured local default', () => {
  const profile = resolveTargetProfile(null, {
    RECOVERY_TARGET_ENV: 'local',
    RECOVERY_TARGET_DB_AUTH: 'entra',
    LOCAL_DB_HOST: 'localhost'
  })

  assert.equal(profile.mode, 'local')
  assert.equal(profile.config.database, 'ffc_pay_local_recovery')
  assert.equal(profile.config.host, 'localhost')
})

test('local target uses base database name with the configured environment', () => {
  const profile = resolveTargetProfile('ffc-pay-processing', {
    RECOVERY_TARGET_ENV: 'local',
    LOCAL_DB_HOST: 'localhost'
  })

  assert.equal(profile.mode, 'local')
  assert.equal(profile.config.database, 'ffc_pay_processing')
  assert.equal(profile.config.port, 5467)
  assert.equal(getServiceDatabaseName('ffc-pay-processing', 'test', 'TARGET_ENV'), 'ffc-pay-processing-test')
})

test('hosted target can use an explicit database without source configuration', () => {
  const profile = resolveTargetProfile(null, {
    RECOVERY_TARGET_DB_AUTH: 'password',
    RECOVERY_TARGET_DATABASE: 'payments_test',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  })

  assert.equal(profile.config.database, 'payments_test')
  assert.equal(profile.config.host, 'target.example')
})

test('hosted target supports Entra authentication with its own tenant', () => {
  const profile = resolveTargetProfile('payments', {
    RECOVERY_TARGET_ENV: 'test',
    RECOVERY_TARGET_DB_AUTH: 'entra',
    RECOVERY_TARGET_DB_TENANT_ID: 'target-tenant',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer'
  })

  assert.equal(profile.config.database, 'payments-test')
  assert.equal(typeof profile.config.password, 'function')
  assert.throws(() => resolveTargetProfile('payments', {
    RECOVERY_TARGET_ENV: 'test',
    RECOVERY_TARGET_DB_AUTH: 'entra',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer'
  }), /RECOVERY_TARGET_DB_TENANT_ID/)
})

test('hosted target requires an explicit database or service and environment', () => {
  assert.throws(() => resolveTargetProfile(null, {
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  }), /RECOVERY_TARGET_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_TARGET_ENV/)

  const profile = resolveTargetProfile('payments', {
    RECOVERY_TARGET_ENV: 'test',
    RECOVERY_TARGET_DB_AUTH: 'password',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  })
  assert.equal(profile.config.database, 'payments-test')
})

test('hosted target mode is the only mode besides local', () => {
  assert.equal(getTargetMode({}), 'hosted')
  assert.throws(() => getTargetMode({ RECOVERY_TARGET_MODE: 'direct' }), /Invalid RECOVERY_TARGET_MODE/)
})
