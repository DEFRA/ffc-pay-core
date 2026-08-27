const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveDatabaseEnvironmentConfig,
  getEnvironmentSuffix,
  getDatabaseEnvironmentDefaults,
  loadEnvironmentFiles
} = require('../app/database/db-connection')
const { buildPgDumpArgs, isLiquibasePermissionFailure, replaceEnvironmentSuffix } = require('../app/database/stream-prd-to-pre')
const { resolveTransferTableList } = require('../app/database/transfer-validation')
const { scenarioRegistry } = require('../app/scenarios')

test('resolveDatabaseEnvironmentConfig uses runtime-selected source and target env values', () => {
  process.env.DB_SOURCE_ENV = 'prd'
  process.env.DB_TARGET_ENV = 'pre'
  process.env.POSTGRES_PRD_HOST = 'prd-db.example.com'
  process.env.POSTGRES_PRE_HOST = 'pre-db.example.com'
  process.env.POSTGRES_PRD_ADMIN = 'prd-admin'
  process.env.POSTGRES_PRE_ADMIN = 'pre-admin'
  process.env.POSTGRES_PORT = '5432'

  const source = resolveDatabaseEnvironmentConfig({ environment: 'prd' })
  const target = resolveDatabaseEnvironmentConfig({ environment: 'pre' })

  assert.equal(source.host, 'prd-db.example.com')
  assert.equal(target.host, 'pre-db.example.com')
  assert.equal(source.username, 'prd-admin')
  assert.equal(target.username, 'pre-admin')
})

test('getDatabaseEnvironmentDefaults supports default source and target environment selection', () => {
  process.env.DB_SOURCE_ENV = 'test'
  process.env.DB_TARGET_ENV = 'dev'

  const defaults = getDatabaseEnvironmentDefaults()

  assert.equal(defaults.source.environment, 'test')
  assert.equal(defaults.target.environment, 'dev')
  assert.equal(getEnvironmentSuffix('dev'), '-dev')
  assert.equal(getEnvironmentSuffix('pre'), '-pre')
  assert.equal(getEnvironmentSuffix('prd'), '-prd')
})

test('resolveDatabaseEnvironmentConfig loads Postgres values from bashrc when they are not in process.env', () => {
  const originalHome = process.env.HOME
  const originalPrdHost = process.env.POSTGRES_PRD_HOST
  const originalPrdAdmin = process.env.POSTGRES_PRD_ADMIN
  const originalPreHost = process.env.POSTGRES_PRE_HOST
  const originalPreAdmin = process.env.POSTGRES_PRE_ADMIN

  delete process.env.POSTGRES_PRD_HOST
  delete process.env.POSTGRES_PRD_ADMIN
  delete process.env.POSTGRES_PRE_HOST
  delete process.env.POSTGRES_PRE_ADMIN

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'delinked-transformer-'))
  process.env.HOME = tempHome
  fs.writeFileSync(path.join(tempHome, '.bashrc'), [
    "export POSTGRES_PRD_HOST='bashrc-prd.example.com'",
    "export POSTGRES_PRD_ADMIN='bashrc-prd-admin'",
    "export POSTGRES_PRE_HOST='bashrc-pre.example.com'",
    "export POSTGRES_PRE_ADMIN='bashrc-pre-admin'"
  ].join('\n'))

  const loaded = loadEnvironmentFiles()

  assert.equal(loaded.POSTGRES_PRD_HOST, 'bashrc-prd.example.com')
  assert.equal(loaded.POSTGRES_PRD_ADMIN, 'bashrc-prd-admin')

  const source = resolveDatabaseEnvironmentConfig({ environment: 'prd' })
  const target = resolveDatabaseEnvironmentConfig({ environment: 'pre' })

  assert.equal(source.host, 'bashrc-prd.example.com')
  assert.equal(source.username, 'bashrc-prd-admin')
  assert.equal(target.host, 'bashrc-pre.example.com')
  assert.equal(target.username, 'bashrc-pre-admin')

  if (originalPrdHost === undefined) delete process.env.POSTGRES_PRD_HOST
  else process.env.POSTGRES_PRD_HOST = originalPrdHost

  if (originalPrdAdmin === undefined) delete process.env.POSTGRES_PRD_ADMIN
  else process.env.POSTGRES_PRD_ADMIN = originalPrdAdmin

  if (originalPreHost === undefined) delete process.env.POSTGRES_PRE_HOST
  else process.env.POSTGRES_PRE_HOST = originalPreHost

  if (originalPreAdmin === undefined) delete process.env.POSTGRES_PRE_ADMIN
  else process.env.POSTGRES_PRE_ADMIN = originalPreAdmin

  process.env.HOME = originalHome
})

test('resolveDatabaseEnvironmentConfig prefers tenant GUIDs over legacy tenant names', () => {
  const originalPreTenant = process.env.PRE_TENANT
  const originalPreTenantId = process.env.PRE_TENANT_ID
  const originalPrdTenant = process.env.PRD_TENANT
  const originalPrdTenantId = process.env.PRD_TENANT_ID

  process.env.PRE_TENANT = 'DefraCloudPreProd'
  process.env.PRE_TENANT_ID = '11111111-2222-3333-4444-555555666666'
  process.env.PRD_TENANT = 'DefraCloud'
  process.env.PRD_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  const preConfig = resolveDatabaseEnvironmentConfig({ environment: 'pre' })
  const prdConfig = resolveDatabaseEnvironmentConfig({ environment: 'prd' })

  assert.equal(preConfig.tenantId, '11111111-2222-3333-4444-555555666666')
  assert.equal(prdConfig.tenantId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

  if (originalPreTenant === undefined) delete process.env.PRE_TENANT
  else process.env.PRE_TENANT = originalPreTenant

  if (originalPreTenantId === undefined) delete process.env.PRE_TENANT_ID
  else process.env.PRE_TENANT_ID = originalPreTenantId

  if (originalPrdTenant === undefined) delete process.env.PRD_TENANT
  else process.env.PRD_TENANT = originalPrdTenant

  if (originalPrdTenantId === undefined) delete process.env.PRD_TENANT_ID
  else process.env.PRD_TENANT_ID = originalPrdTenantId
})

test('resolveDatabaseEnvironmentConfig supports recovery password authentication config', () => {
  const originalRecoveryUser = process.env.RECOVERY_DB_USER
  const originalRecoveryAdmin = process.env.RECOVERY_DB_ADMIN
  const originalRecoveryPassword = process.env.RECOVERY_DB_PASSWORD

  try {
    delete process.env.RECOVERY_DB_USER
    delete process.env.RECOVERY_DB_PASSWORD
    process.env.DB_SOURCE_ENV = 'recovery'
    process.env.RECOVERY_DB_HOST = 'recovery-db.example.com'
    process.env.RECOVERY_DB_ADMIN = 'recovery-admin'
    process.env.RECOVERY_DB_TENANT_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

    const recoveryConfig = resolveDatabaseEnvironmentConfig({ environment: 'recovery' })

    assert.equal(recoveryConfig.environment, 'recovery')
    assert.equal(recoveryConfig.host, 'recovery-db.example.com')
    assert.equal(recoveryConfig.username, 'recovery-admin')
    assert.equal(recoveryConfig.useAzureAd, false)
    assert.equal(recoveryConfig.tenantId, undefined)
    assert.equal(recoveryConfig.password, '')
    assert.equal(recoveryConfig.suffix, '-prd')
  } finally {
    if (originalRecoveryUser === undefined) delete process.env.RECOVERY_DB_USER
    else process.env.RECOVERY_DB_USER = originalRecoveryUser

    if (originalRecoveryAdmin === undefined) delete process.env.RECOVERY_DB_ADMIN
    else process.env.RECOVERY_DB_ADMIN = originalRecoveryAdmin

    if (originalRecoveryPassword === undefined) delete process.env.RECOVERY_DB_PASSWORD
    else process.env.RECOVERY_DB_PASSWORD = originalRecoveryPassword
  }
})

test('replaceEnvironmentSuffix resolves PRD alerting database names to the PRE target correctly', () => {
  assert.equal(replaceEnvironmentSuffix('ffc-pay-alerting-prd', 'prd', 'pre'), 'ffc-pay-alerting-pre')
  assert.equal(replaceEnvironmentSuffix('ffc-pay-alerting', 'prd', 'pre'), 'ffc-pay-alerting')
})

test('replaceEnvironmentSuffix resolves request-editor PRD database names to the PRE target correctly', () => {
  assert.equal(replaceEnvironmentSuffix('ffc-pay-request-editor-prd', 'prd', 'pre'), 'ffc-pay-request-editor-pre')
  assert.equal(replaceEnvironmentSuffix('ffc-pay-request-editor', 'prd', 'pre'), 'ffc-pay-request-editor')
})

test('isLiquibasePermissionFailure detects the PRD reader lock error in pg_dump output', () => {
  const message = 'pg_dump: error: query failed: ERROR:  permission denied for table databasechangeloglock\nQuery was: LOCK TABLE public.databasechangeloglock, public.databasechangelog, public.schemes, public.contacts IN ACCESS SHARE MODE'
  assert.equal(isLiquibasePermissionFailure(message), true)
})

test('buildPgDumpArgs excludes Liquibase metadata tables that are not safe to lock', () => {
  const args = buildPgDumpArgs({ host: 'example.com', port: 5432, username: 'azure-user' }, 'ffc-pay-alerting-prd')

  assert.ok(args.includes('--exclude-table'))
  assert.ok(args.includes('public."databasechangelog"'))
  assert.ok(args.includes('public."databasechangeloglock"'))
})

test('buildPgDumpArgs can include Liquibase metadata tables for a blank PRE validation copy', () => {
  const args = buildPgDumpArgs({ host: 'example.com', port: 5432, username: 'azure-user' }, 'ffc-pay-alerting-prd', { includeLiquibaseTables: true })

  assert.equal(args.includes('public."databasechangelog"'), false)
  assert.equal(args.includes('public."databasechangeloglock"'), false)
})

test('resolveTransferTableList excludes reader-only tables like contacts and schemes from validation', () => {
  const result = resolveTransferTableList({}, ['contacts', 'schemes', 'orders'])
  assert.deepEqual(result.map(table => table.name), ['orders'])
})

test('scenario registry only exposes the supported test-to-dev and prd-to-pre flows', () => {
  assert.deepEqual(Object.keys(scenarioRegistry).sort(), ['prd-to-pre', 'test-to-dev'])
})
