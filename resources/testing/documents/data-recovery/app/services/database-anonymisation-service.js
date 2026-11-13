const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')
const configuration = require('../config/database-anonymisation')
const { PROFILE_VERSION } = require('../faker/organisation-profile')
const { createPostgresConnection } = require('../database/postgres-connection')
const { quoteIdentifier, getTargetConfirmation } = require('./database-archive-service')

const DEFAULT_BATCH_SIZE = 500
const TARGET_ENVIRONMENTS = new Set(['local', 'dev', 'test', 'pre', 'recovery'])

function assertAnonymisationTarget (environment, target) {
  const targetEnvironment = environment.RECOVERY_TARGET_ENV || (environment.RECOVERY_TARGET_MODE === 'local' ? 'local' : '')
  if (!TARGET_ENVIRONMENTS.has(targetEnvironment) || /(?:^|[-_])(?:prd|prod|production)(?:$|[-_])/i.test(target.database)) {
    throw new Error('Anonymisation requires an explicit non-production target environment and database')
  }
}

function getAnonymisationMappings (serviceName, config = configuration) {
  const mappings = config[serviceName] || []
  if (!Array.isArray(mappings)) throw new Error(`Anonymisation mappings for ${serviceName} must be an array`)
  const tables = new Set()

  for (const mapping of mappings) {
    if (!mapping.schema || !mapping.table || typeof mapping.transform !== 'function' || !mapping.fieldMap || Object.keys(mapping.fieldMap).length === 0) {
      throw new Error(`Anonymisation mapping for ${serviceName} requires schema, table, a non-empty fieldMap and transform`)
    }
    const identifiers = Object.entries(mapping.identifiers || {})
    if (identifiers.length === 0 || identifiers.some(([name, column]) => !['frn', 'sbi'].includes(name) || typeof column !== 'string' || !column)) {
      throw new Error(`Anonymisation mapping for ${serviceName} requires FRN and/or SBI identifier columns`)
    }
    const table = `${mapping.schema}.${mapping.table}`
    if (tables.has(table)) throw new Error(`Duplicate anonymisation mapping for ${serviceName}: ${table}`)
    tables.add(table)
    if (Object.values(mapping.identifiers).some(column => Object.hasOwn(mapping.fieldMap, column))) {
      throw new Error(`Anonymisation must not change identifier columns in ${table}`)
    }
  }
  return mappings
}

function describeAnonymisation (serviceName, config = configuration) {
  const mappings = getAnonymisationMappings(serviceName, config)
  const tables = mappings.map(mapping => ({
    schema: mapping.schema,
    table: mapping.table,
    identifiers: mapping.identifiers,
    fieldMap: mapping.fieldMap,
    transform: String(mapping.transform)
  }))
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ profileVersion: PROFILE_VERSION, tables })).digest('hex')
  return {
    profileVersion: PROFILE_VERSION,
    fingerprint,
    tables: tables.map(({ transform, ...table }) => table)
  }
}

function getAnonymisationConfirmation (target, description) {
  return `${getTargetConfirmation(target)}#anonymise=${description.fingerprint.slice(0, 16)}`
}

function qualifiedTable (mapping) {
  return `${quoteIdentifier(mapping.schema)}.${quoteIdentifier(mapping.table)}`
}

async function inspectTable (client, mapping) {
  const parameters = [mapping.schema, mapping.table]
  const { rows: columns } = await client.query(`
    SELECT attribute.attname AS name, type.typname AS type, relation.relkind AS relation_kind,
      relation.relrowsecurity AS row_security,
      EXISTS (SELECT 1 FROM pg_inherits inheritance WHERE inheritance.inhparent = relation.oid
        OR inheritance.inhrelid = relation.oid) AS inherited_table,
      EXISTS (SELECT 1 FROM pg_index index WHERE index.indrelid = relation.oid
        AND index.indisprimary AND attribute.attnum = ANY(index.indkey)) AS primary_key,
      EXISTS (SELECT 1 FROM pg_constraint constraint_info WHERE constraint_info.contype = 'f' AND (
        (constraint_info.conrelid = relation.oid AND attribute.attnum = ANY(constraint_info.conkey)) OR
        (constraint_info.confrelid = relation.oid AND attribute.attnum = ANY(constraint_info.confkey))
      )) AS relationship_key
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_type type ON type.oid = attribute.atttypid
    WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `, parameters)
  const table = qualifiedTable(mapping)
  if (columns.length === 0) throw new Error(`Anonymisation table does not exist: ${table}`)
  if (columns[0].relation_kind !== 'r' || columns[0].inherited_table || columns[0].row_security) {
    throw new Error(`Anonymisation requires a regular, non-inherited table without row-level security: ${table}`)
  }
  const byName = new Map(columns.map(column => [column.name, column]))
  const primaryKeys = columns.filter(column => column.primary_key).map(column => column.name)
  if (primaryKeys.length === 0) throw new Error(`Anonymisation requires a primary key on ${table}`)

  for (const column of [...Object.keys(mapping.fieldMap), ...Object.values(mapping.identifiers)]) {
    if (!byName.has(column)) throw new Error(`Anonymisation column does not exist: ${table}.${column}`)
  }
  for (const name of Object.keys(mapping.fieldMap)) {
    const column = byName.get(name)
    if (column.primary_key || column.relationship_key) throw new Error(`Anonymisation must not change a key column: ${table}.${name}`)
    if (!['text', 'varchar', 'bpchar', 'citext'].includes(column.type)) {
      throw new Error(`Anonymisation requires a text column: ${table}.${name}`)
    }
  }

  const { rows: hooks } = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = $2
        AND NOT trigger.tgisinternal AND trigger.tgenabled <> 'D'
    ) OR EXISTS (
      SELECT 1 FROM pg_rewrite rule
      JOIN pg_class relation ON relation.oid = rule.ev_class
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = $2 AND rule.ev_type = '2' AND rule.ev_enabled <> 'D'
    ) AS has_write_hooks
  `, parameters)
  if (hooks[0].has_write_hooks) {
    throw new Error(`Anonymisation refuses enabled user triggers or UPDATE rules on ${table}; review their side effects first`)
  }

  const seedExpressions = Object.values(mapping.identifiers).map(column => `NULLIF(BTRIM(${quoteIdentifier(column)}::text), '')`)
  const { rows: seeds } = await client.query(`
    SELECT COUNT(*)::text AS total_rows,
      COUNT(*) FILTER (WHERE COALESCE(${seedExpressions.join(', ')}, NULL) IS NULL)::text AS missing_identifiers
    FROM ${table}
  `)
  if (seeds[0].missing_identifiers !== '0') throw new Error(`Anonymisation found rows without FRN/SBI in ${table}`)
  return { mapping, primaryKeys, totalRows: Number(seeds[0].total_rows) }
}

async function readProtectedDataFingerprint (client, mapping) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::text AS row_count,
      COALESCE(SUM(('x' || SUBSTR(MD5((TO_JSONB(recovery_row) - $1::text[])::text), 1, 16))::bit(64)::bigint::numeric), 0)::text AS protected_hash_1,
      COALESCE(SUM(('x' || SUBSTR(MD5((TO_JSONB(recovery_row) - $1::text[])::text), 17, 16))::bit(64)::bigint::numeric), 0)::text AS protected_hash_2
    FROM ${qualifiedTable(mapping)} AS recovery_row
  `, [Object.keys(mapping.fieldMap)])
  return rows[0]
}

function buildMaskedRows (rows, mapping, primaryKeys) {
  const maskedRows = []
  const allowed = new Set(Object.keys(mapping.fieldMap))
  for (const row of rows) {
    const original = structuredClone(row)
    const identifiers = Object.fromEntries(Object.entries(mapping.identifiers).map(([name, column]) => [name, row[column]]))
    const transformed = mapping.transform(structuredClone(row), identifiers)
    if (!transformed || typeof transformed !== 'object') throw new Error('Anonymisation mapper must return a row object')
    for (const column of new Set([...Object.keys(original), ...Object.keys(transformed)])) {
      if (!allowed.has(column) && !isDeepStrictEqual(original[column], transformed[column])) {
        throw new Error(`Anonymisation mapper changed an unlisted column: ${column}`)
      }
      const value = original[column]
      if (allowed.has(column) && (value === null || value === undefined || (typeof value === 'string' && !value.trim())) && !isDeepStrictEqual(value, transformed[column])) {
        throw new Error(`Anonymisation mapper changed a null or empty column: ${column}`)
      }
    }
    if (Object.keys(mapping.fieldMap).every(column => isDeepStrictEqual(original[column], transformed[column]))) continue
    maskedRows.push(Object.fromEntries([...primaryKeys, ...allowed].map(column => [column, transformed[column]])))
  }
  return maskedRows
}

async function anonymiseTable (client, inspected, batchSize) {
  const { mapping, primaryKeys, totalRows } = inspected
  const table = qualifiedTable(mapping)
  const before = await readProtectedDataFingerprint(client, mapping)
  await client.query(`DECLARE recovery_anonymisation_rows NO SCROLL CURSOR FOR SELECT * FROM ${table} ORDER BY ${primaryKeys.map(quoteIdentifier).join(', ')}`)
  let processedRows = 0
  let updatedRows = 0
  while (true) {
    const { rows } = await client.query(`FETCH FORWARD ${batchSize} FROM recovery_anonymisation_rows`)
    if (rows.length === 0) break
    processedRows += rows.length
    const maskedRows = buildMaskedRows(rows, mapping, primaryKeys)
    if (maskedRows.length === 0) continue
    const assignments = Object.keys(mapping.fieldMap).map(column => `${quoteIdentifier(column)} = recovery_masked.${quoteIdentifier(column)}`)
    const conditions = primaryKeys.map(column => `recovery_target.${quoteIdentifier(column)} = recovery_masked.${quoteIdentifier(column)}`)
    const result = await client.query(`
      UPDATE ${table} AS recovery_target SET ${assignments.join(', ')}
      FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) AS recovery_masked
      WHERE ${conditions.join(' AND ')}
    `, [JSON.stringify(maskedRows)])
    if (result.rowCount !== maskedRows.length) throw new Error(`Anonymisation update count mismatch on ${table}`)
    updatedRows += result.rowCount
  }
  await client.query('CLOSE recovery_anonymisation_rows')
  const after = await readProtectedDataFingerprint(client, mapping)
  if (processedRows !== totalRows || !isDeepStrictEqual(before, after)) {
    throw new Error(`Anonymisation changed row counts or unlisted data on ${table}`)
  }
  return { schema: mapping.schema, table: mapping.table, processedRows, updatedRows }
}

async function anonymiseDatabase (options, dependencies = {}) {
  const environment = options.environment || process.env
  assertAnonymisationTarget(environment, options.target)
  const config = options.config || configuration
  const mappings = getAnonymisationMappings(options.serviceName, config)
  if (mappings.length === 0) throw new Error(`No anonymisation mappings configured for ${options.serviceName}`)
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error('Anonymisation batch size must be an integer between 1 and 10000')
  const connect = dependencies.createPostgresConnection || createPostgresConnection
  const connection = await connect(options.target, { connectionName: 'anonymisation target', max: 1 })
  let client
  let transactionOpen = false
  try {
    client = await connection.pool.connect()
    await client.query(options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL REPEATABLE READ')
    transactionOpen = true
    if (!options.dryRun) {
      await client.query("SET LOCAL lock_timeout = '5s'")
      const { rows } = await client.query("SELECT COUNT(*)::text AS other_connections FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'")
      if (rows[0].other_connections !== '0') throw new Error('Anonymisation requires an offline target with no other client connections')
      for (const mapping of mappings) await client.query(`LOCK TABLE ${qualifiedTable(mapping)} IN SHARE ROW EXCLUSIVE MODE`)
    }
    const inspected = []
    for (const mapping of mappings) inspected.push(await inspectTable(client, mapping))
    const tables = []
    for (const table of inspected) {
      tables.push(options.dryRun
        ? { schema: table.mapping.schema, table: table.mapping.table, totalRows: table.totalRows }
        : await anonymiseTable(client, table, batchSize))
    }
    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT')
    transactionOpen = false
    return { dryRun: Boolean(options.dryRun), ...describeAnonymisation(options.serviceName, config), tables }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    throw error
  } finally {
    if (client) client.release()
    await connection.close()
  }
}

module.exports = {
  assertAnonymisationTarget,
  getAnonymisationMappings,
  describeAnonymisation,
  getAnonymisationConfirmation,
  buildMaskedRows,
  anonymiseDatabase
}
