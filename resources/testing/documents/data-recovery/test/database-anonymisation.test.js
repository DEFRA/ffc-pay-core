const assert = require('node:assert/strict')
const test = require('node:test')
const documentMapper = require('../app/faker/map-document-org-faker')
const {
  assertAnonymisationTarget,
  getAnonymisationMappings,
  describeAnonymisation,
  getAnonymisationConfirmation,
  buildMaskedRows,
  anonymiseDatabase
} = require('../app/services/database-anonymisation-service')
const { parseArgs, anonymiseDatabaseTarget } = require('../app/tools/database-anonymise')

const serviceName = 'ffc-doc-statement-data'
const mapping = getAnonymisationMappings(serviceName)[0]
const target = { host: 'localhost', port: 5467, database: 'ffc_doc_statement_data' }
const environment = { RECOVERY_TARGET_ENV: 'local' }

const databaseFixture = (options = {}) => {
  const queries = []
  const updates = []
  const rows = options.rows || [
    { id: 1, frn: '100000001', sbi: '200000001', name: 'Original first', addressLine1: null, updated: '2026-01-01' },
    { id: 2, frn: '100000002', sbi: '200000002', name: 'Original second', addressLine1: '', updated: '2026-01-02' }
  ]
  let fetched = false
  let fingerprints = 0
  let released = false
  let closed = false
  const client = {
    query: async (sql, params) => {
      queries.push(sql)
      if (sql.includes('pg_stat_activity')) return { rows: [{ other_connections: options.otherConnections || '0' }] }
      if (sql.includes('FROM pg_attribute')) {
        const names = ['id', 'frn', 'sbi', ...Object.keys(documentMapper.FIELD_MAP)]
        return {
          rows: names.filter(name => name !== options.missingColumn).map(name => ({
            name,
            type: name === 'id' ? 'int4' : 'text',
            relation_kind: options.partitioned ? 'p' : 'r',
            inherited_table: Boolean(options.inherited),
            row_security: Boolean(options.rowSecurity),
            primary_key: name === 'id' && !options.noPrimaryKey,
            relationship_key: name === options.relationshipKey
          }))
        }
      }
      if (sql.includes('FROM pg_trigger')) return { rows: [{ has_write_hooks: Boolean(options.writeHooks) }] }
      if (sql.includes('missing_identifiers')) return { rows: [{ total_rows: String(rows.length), missing_identifiers: options.missingIdentifiers || '0' }] }
      if (sql.includes('protected_hash_1')) {
        fingerprints++
        return { rows: [{ row_count: String(rows.length), protected_hash_1: options.changedProtectedData && fingerprints > 1 ? 'changed' : 'same', protected_hash_2: 'same' }] }
      }
      if (sql.startsWith('FETCH')) {
        if (fetched) return { rows: [] }
        fetched = true
        return { rows }
      }
      if (sql.includes('UPDATE ') && sql.includes('jsonb_populate_recordset')) {
        updates.push(JSON.parse(params[0]))
        if (options.updateError) throw new Error('Update failed')
        return { rowCount: options.updateCount ?? updates.at(-1).length }
      }
      return { rows: [] }
    },
    release: () => { released = true }
  }
  return {
    queries,
    updates,
    dependencies: { createPostgresConnection: async () => ({ pool: { connect: async () => client }, close: async () => { closed = true } }) },
    assertClosed: () => { assert.equal(released, true); assert.equal(closed, true) }
  }
}

test('only document mappings are active and their fingerprints identify mapping changes', () => {
  assert.equal(getAnonymisationMappings(serviceName).length, 1)
  assert.equal(getAnonymisationMappings('ffc-doc-statement-constructor').length, 1)
  assert.deepEqual(getAnonymisationMappings('ffc-pay-processing'), [])
  assert.deepEqual(getAnonymisationMappings('fcp-pds-data-retention'), [])
  const initial = describeAnonymisation(serviceName)
  assert.equal(initial.fingerprint, describeAnonymisation(serviceName).fingerprint)
  const changed = { [serviceName]: [{ ...mapping, fieldMap: { name: 'name' } }] }
  assert.notEqual(initial.fingerprint, describeAnonymisation(serviceName, changed).fingerprint)
  assert.throws(() => getAnonymisationMappings(serviceName, { [serviceName]: [{ ...mapping, fieldMap: { frn: 'name' } }] }), /must not change identifier/)
  assert.throws(() => getAnonymisationMappings(serviceName, { [serviceName]: [{ ...mapping, fieldMap: {} }] }), /non-empty fieldMap/)
})

test('anonymisation refuses production and unspecified hosted target environments', () => {
  assert.doesNotThrow(() => assertAnonymisationTarget(environment, target))
  assert.throws(() => assertAnonymisationTarget({ RECOVERY_TARGET_ENV: 'prd' }, target), /non-production/)
  assert.throws(() => assertAnonymisationTarget({}, target), /non-production/)
  assert.throws(() => assertAnonymisationTarget(environment, { ...target, database: 'ffc-doc-statement-data-prd_restore_123' }), /non-production/)
})

test('database masking uses one transaction, bounded fetches and only explicit update columns', async () => {
  const fixture = databaseFixture()
  const result = await anonymiseDatabase({ serviceName, target, environment, batchSize: 2 }, fixture.dependencies)
  assert.equal(result.tables[0].processedRows, 2)
  assert.equal(result.tables[0].updatedRows, 2)
  assert.ok(fixture.queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'))
  assert.ok(fixture.queries.includes('FETCH FORWARD 2 FROM recovery_anonymisation_rows'))
  assert.ok(fixture.queries.includes('COMMIT'))
  const update = fixture.queries.find(sql => sql.includes('jsonb_populate_recordset'))
  assert.match(update, /SET "name" = recovery_masked\."name"/)
  assert.doesNotMatch(update, /"frn" =|"sbi" =|"updated" =/)
  assert.equal(fixture.updates[0][0].id, 1)
  assert.equal(fixture.updates[0][0].addressLine1, null)
  assert.equal(Object.hasOwn(fixture.updates[0][0], 'updated'), false)
  fixture.assertClosed()
})

test('dry-run inspects schema and seeds without locking, updating or committing', async () => {
  const fixture = databaseFixture()
  const result = await anonymiseDatabase({ serviceName, target, environment, dryRun: true }, fixture.dependencies)
  assert.equal(result.dryRun, true)
  assert.equal(result.tables[0].totalRows, 2)
  assert.ok(fixture.queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(fixture.queries.includes('ROLLBACK'))
  assert.equal(fixture.queries.some(sql => /^(LOCK TABLE|DECLARE|FETCH|COMMIT)/.test(sql)), false)
  assert.equal(fixture.updates.length, 0)
  fixture.assertClosed()
})

test('masking refuses unsafe tables before any updates and rolls back', async () => {
  const scenarios = [
    [{ writeHooks: true }, /triggers or UPDATE rules/],
    [{ missingColumn: 'name' }, /column does not exist/],
    [{ noPrimaryKey: true }, /requires a primary key/],
    [{ relationshipKey: 'name' }, /must not change a key column/],
    [{ partitioned: true }, /regular, non-inherited table/],
    [{ inherited: true }, /regular, non-inherited table/],
    [{ rowSecurity: true }, /without row-level security/],
    [{ missingIdentifiers: '1' }, /without FRN\/SBI/],
    [{ otherConnections: '1' }, /offline target/]
  ]
  for (const [options, expected] of scenarios) {
    const fixture = databaseFixture(options)
    await assert.rejects(anonymiseDatabase({ serviceName, target, environment }, fixture.dependencies), expected)
    assert.ok(fixture.queries.includes('ROLLBACK'))
    assert.equal(fixture.updates.length, 0)
    fixture.assertClosed()
  }
})

test('updates and preservation failures roll back the entire masking transaction', async () => {
  for (const options of [{ updateError: true }, { updateCount: 0 }, { changedProtectedData: true }]) {
    const fixture = databaseFixture(options)
    await assert.rejects(anonymiseDatabase({ serviceName, target, environment }, fixture.dependencies), /Update failed|update count mismatch|unlisted data/)
    assert.ok(fixture.queries.includes('ROLLBACK'))
    assert.equal(fixture.queries.includes('COMMIT'), false)
    fixture.assertClosed()
  }
})

test('mapper contracts reject accidental changes to unlisted or missing data', () => {
  const row = { id: 1, frn: '100000001', name: 'Original', updated: 'Original' }
  assert.throws(() => buildMaskedRows([row], { ...mapping, transform: original => ({ ...original, updated: 'Changed' }) }, ['id']), /unlisted column: updated/)
  assert.throws(() => buildMaskedRows([{ ...row, name: null }], { ...mapping, transform: original => ({ ...original, name: 'Invented' }) }, ['id']), /null or empty column/)
  assert.throws(() => buildMaskedRows([row], { ...mapping, transform: () => null }, ['id']), /return a row object/)
})

test('seed column aliases produce the same profile without changing source identifiers', () => {
  const row = { id: 1, customerFrn: '100000001', name: 'Original' }
  const aliased = { ...mapping, identifiers: { frn: 'customerFrn' }, fieldMap: { name: 'name' } }
  const result = buildMaskedRows([row], aliased, ['id'])[0]
  assert.equal(result.name, documentMapper.anonymizeOrganisation({ frn: '100000001', name: 'Original' }).name)
  assert.deepEqual(Object.keys(result), ['id', 'name'])
})

test('standalone runner requires a database and explicit live confirmation', () => {
  assert.equal(parseArgs(['--database', serviceName, '--dry-run']).dryRun, true)
  assert.throws(() => parseArgs(['--dry-run']), /requires --database/)
  assert.throws(() => parseArgs(['--database', serviceName]), /requires --confirm-target/)
  assert.throws(() => parseArgs(['--database', serviceName, '--dry-run', '--confirm-target', 'token']), /Do not pass/)
  assert.throws(() => parseArgs(['--database', '--dry-run']), /requires a value/)
})

test('standalone runner uses target-only configuration and a mapping-bound token', async () => {
  const calls = []
  const options = { databaseName: serviceName, environment: {}, refreshConfig: { SOURCE_ENV: 'prd', TARGET_ENV: 'local' } }
  const dependencies = { anonymiseDatabase: async request => { calls.push(request); return { dryRun: Boolean(request.dryRun), tables: [] } } }
  const dryRun = await anonymiseDatabaseTarget({ ...options, dryRun: true }, dependencies)
  assert.equal(dryRun.target, getAnonymisationConfirmation(target, describeAnonymisation(serviceName)))
  assert.equal(calls[0].target.database, 'ffc_doc_statement_data')
  assert.equal(calls[0].dryRun, true)
  await assert.rejects(anonymiseDatabaseTarget({ ...options, confirmTarget: 'wrong' }, dependencies), /must exactly match/)
  assert.equal(calls.length, 1)
  await anonymiseDatabaseTarget({ ...options, confirmTarget: dryRun.target }, dependencies)
  assert.equal(calls.length, 2)
  await assert.rejects(anonymiseDatabaseTarget({ ...options, databaseName: 'ffc-pay-processing', dryRun: true }, dependencies), /No anonymisation mappings/)
})
