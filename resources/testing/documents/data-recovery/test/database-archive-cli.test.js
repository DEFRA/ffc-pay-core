const assert = require('node:assert/strict')
const test = require('node:test')
const {
  parseArgs,
  buildDumpArgs,
  getSourceProfile,
  getTargetProfile,
  validateAvailableExtensions
} = require('../app/tools/database-archive')

test('backup accepts an output path without requiring target configuration', () => {
  const args = parseArgs(['backup', '--output', 'dumps/source.dump'])
  const profile = getSourceProfile({
    RECOVERY_SOURCE_DATABASE: 'arbitrary.source',
    RECOVERY_SOURCE_DB_HOST: 'source.example',
    RECOVERY_SOURCE_DB_USER: 'reader',
    RECOVERY_SOURCE_DB_PASSWORD: 'secret',
    RECOVERY_SOURCE_DB_SSL: 'false'
  })

  assert.equal(args.action, 'backup')
  assert.equal(args.output, 'dumps/source.dump')
  assert.equal(profile.source.database, 'arbitrary.source')
  assert.equal(profile.source.host, 'source.example')
})

test('restore requires an archive and validates incompatible options', () => {
  assert.throws(() => parseArgs(['restore']), /requires --archive/)
  assert.throws(() => parseArgs(['restore', '--archive', 'source.dump', '--output', 'other.dump']), /Use --archive/)
  assert.throws(() => parseArgs(['backup', '--wipe']), /only valid with restore/)
  assert.throws(() => parseArgs(['restore', '--archive', 'source.dump', '--mystery']), /Unknown option/)
})

test('target configuration works for local restore without source credentials', () => {
  const target = getTargetProfile({ RECOVERY_TARGET_MODE: 'local' }, {
    database: 'source_db',
    serviceName: null
  })

  assert.equal(target.host, 'localhost')
  assert.equal(target.port, 5467)
  assert.equal(target.database, 'ffc_pay_local_recovery')
})

test('hosted restore requires an explicit target database or service name', () => {
  assert.throws(() => getTargetProfile({}, { database: 'source_db', serviceName: null }), /Set RECOVERY_TARGET_DATABASE/)
})

test('hosted restore can resolve an explicit target without source credentials', () => {
  const target = getTargetProfile({
    RECOVERY_TARGET_DATABASE: 'payments-test',
    RECOVERY_TARGET_DB_HOST: 'target.example',
    RECOVERY_TARGET_DB_USER: 'writer',
    RECOVERY_TARGET_DB_PASSWORD: 'secret'
  }, { database: 'payments-source', serviceName: null })

  assert.equal(target.host, 'target.example')
  assert.equal(target.database, 'payments-test')
})

test('extension preflight requires extension names and only requires exact versions in strict mode', async () => {
  const queries = []
  const connection = {
    query: async (query, params) => {
      queries.push(query)
      if (query.includes('pg_available_extensions')) return { rows: [{ name: 'pg_buffercache' }] }
      if (query.includes('pg_available_extension_versions')) return { rows: [{ name: 'pg_buffercache', version: '1.4' }] }
      throw new Error('Unexpected extension query')
    }
  }
  const sourceExtensions = [{ name: 'pg_buffercache', version: '1.3' }]

  await validateAvailableExtensions(connection, sourceExtensions)
  assert.match(queries[0], /pg_available_extensions/)
  await assert.rejects(validateAvailableExtensions(connection, sourceExtensions, { requireExactVersions: true }), /pg_buffercache 1.3/)
})

test('dump command arguments pass a snapshot only when supplied and never include passwords', () => {
  const config = { host: 'source.example', port: 5432, user: 'reader', password: 'secret', database: 'source_db' }
  const argsWithoutSnapshot = buildDumpArgs(config, null, 'archive.dump')
  const argsWithSnapshot = buildDumpArgs(config, '00000003-0000001B-1', 'schema.sql', true)

  assert.equal(argsWithoutSnapshot.includes('--snapshot'), false)
  assert.equal(argsWithoutSnapshot.includes('secret'), false)
  assert.equal(argsWithoutSnapshot.includes('--verbose'), true)
  assert.equal(argsWithSnapshot.includes('--verbose'), false)
  assert.deepEqual(argsWithSnapshot.slice(argsWithSnapshot.indexOf('--snapshot'), argsWithSnapshot.indexOf('--snapshot') + 2), ['--snapshot', '00000003-0000001B-1'])
  assert.ok(argsWithSnapshot.includes('--schema-only'))
})
