const assert = require('node:assert/strict')
const test = require('node:test')
const databaseRefresh = require('../app/config/database-refresh')
const { getServiceDatabaseName, getSourceDatabaseName, getTargetMode, resolveDatabasePair, resolveTargetProfile } = require('../app/config/database-profiles')
const { buildSourceConfig } = require('../app/database/source-database-connection')

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
      targetDatabase: 'ffc-pay-processing-local'
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
      RECOVERY_SOURCE_ENV: 'test'
    }
  })

  assert.equal(config.database, 'payments-test')
  assert.equal(config.ssl, true)
})

test('local target without a service name uses the configured local default', () => {
  const profile = resolveTargetProfile(null, {
    RECOVERY_TARGET_ENV: 'local',
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
  assert.equal(profile.config.database, 'ffc-pay-processing-local')
  assert.equal(getServiceDatabaseName('ffc-pay-processing', 'test', 'TARGET_ENV'), 'ffc-pay-processing-test')
})

test('hosted target can use an explicit database without source configuration', () => {
  const profile = resolveTargetProfile(null, {
    RECOVERY_TARGET_DATABASE: 'payments_test',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  })

  assert.equal(profile.config.database, 'payments_test')
  assert.equal(profile.config.host, 'target.example')
})

test('hosted target requires an explicit database or service and environment', () => {
  assert.throws(() => resolveTargetProfile(null, {
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  }), /RECOVERY_TARGET_DATABASE or RECOVERY_SERVICE_NAME with RECOVERY_TARGET_ENV/)

  const profile = resolveTargetProfile('payments', {
    RECOVERY_TARGET_ENV: 'test',
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
