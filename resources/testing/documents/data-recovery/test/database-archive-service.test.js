const assert = require('node:assert/strict')
const test = require('node:test')
const {
  getPgSslMode,
  buildConnectionArgs,
  buildToolEnvironment,
  parsePgMajorVersion,
  parseServerMajorVersion,
  quoteIdentifier,
  quoteLiteral,
  buildCreateDatabaseSql,
  createTemporaryDatabaseName,
  getTargetConfirmation,
  assertRestoreConfirmation,
  assertRestoreCompatibility,
  isSameDatabase,
  readDatabaseMetadata,
  getDatabaseInventory,
  getExactDataCounts,
  getDatabaseExtensions,
  compareDatabaseLocales,
  compareDatabaseExtensions,
  hashSchemaDumpFile,
  findFirstSchemaDumpDifference
} = require('../app/services/database-archive-service')
const fs = require('fs')
const os = require('os')
const path = require('path')

test('libpq SSL mode matches source and target connection settings', () => {
  assert.equal(getPgSslMode({ ssl: true }, {}, 'source'), 'require')
  assert.equal(getPgSslMode({ ssl: { rejectUnauthorized: false } }, { RECOVERY_SOURCE_DB_SSL_MODE: 'no-verify' }, 'source'), 'require')
  assert.equal(getPgSslMode({ ssl: false }, {}, 'target'), 'disable')
  assert.equal(getPgSslMode({ ssl: true }, { RECOVERY_TARGET_DB_SSL_MODE: 'verify-full' }, 'target'), 'verify-full')
  assert.throws(() => getPgSslMode({ ssl: true }, { RECOVERY_SOURCE_DB_SSL_MODE: 'invalid' }, 'source'), /Unsupported PostgreSQL SSL mode/)
})

test('connection arguments keep credentials out of the process arguments', () => {
  const config = { host: 'db.example', port: 5432, user: 'backup-user', password: 'secret', database: 'payments' }
  const args = buildConnectionArgs(config)
  const environment = buildToolEnvironment(config, 'require', {})

  assert.deepEqual(args, ['--host', 'db.example', '--port', '5432', '--username', 'backup-user', '--dbname', 'payments', '--no-password'])
  assert.equal(args.includes('secret'), false)
  assert.equal(environment.PGPASSWORD, 'secret')
  assert.equal(environment.PGSSLMODE, 'require')
})

test('PostgreSQL server and client versions are parsed', () => {
  assert.equal(parsePgMajorVersion('pg_dump (PostgreSQL) 16.15'), 16)
  assert.equal(parsePgMajorVersion('pg_dump (PostgreSQL) 9.6.24'), 9.6)
  assert.equal(parseServerMajorVersion(160015), 16)
  assert.equal(parseServerMajorVersion(90624), 9.6)
  assert.throws(() => parseServerMajorVersion(0), /Invalid PostgreSQL server version/)
})

test('database identifiers and locale values are quoted', () => {
  assert.equal(quoteIdentifier('test"db'), '"test""db"')
  assert.equal(quoteLiteral("en_US'utf8"), "'en_US''utf8'")
})

test('new database SQL retains libc or ICU locale settings', () => {
  const libcSql = buildCreateDatabaseSql('target', {
    encoding: 'UTF8',
    localeProvider: 'libc',
    collation: 'en_US.UTF-8',
    ctype: 'en_US.UTF-8'
  }, 16)
  const icuSql = buildCreateDatabaseSql('target', {
    encoding: 'UTF8',
    localeProvider: 'icu',
    icuLocale: 'en-US'
  }, 16)

  assert.match(libcSql, /LC_COLLATE = 'en_US\.UTF-8'/)
  assert.match(icuSql, /LOCALE_PROVIDER = icu ICU_LOCALE = 'en-US'/)
  assert.match(buildCreateDatabaseSql('target', { encoding: 'UTF8', collation: 'C', ctype: 'C' }, 16, 'target-owner'), /OWNER "target-owner"/)
  assert.throws(() => buildCreateDatabaseSql('target', { encoding: 'UTF8', localeProvider: 'icu' }, 16), /source ICU locale/)
  assert.throws(() => buildCreateDatabaseSql('target', { collation: 'C', ctype: 'C' }, 16), /encoding is missing/)
  assert.throws(() => buildCreateDatabaseSql('target', { encoding: 'UTF8' }, 16), /libc locale is incomplete/)
  assert.throws(() => buildCreateDatabaseSql('target', { encoding: 'UTF8', localeProvider: 'builtin' }, 16), /Unsupported source locale provider/)
})

test('temporary database names fit PostgreSQL identifier limits', () => {
  const name = createTemporaryDatabaseName('a'.repeat(80), 'restore', '0123456789abcdef')
  assert.equal(name.length, 63)
  assert.match(name, /_restore_0123456789abcdef$/)
})

test('restore requires an exact target endpoint confirmation and explicit wipe flag', () => {
  const target = { host: 'localhost', port: 5467, database: 'test_target' }
  const confirmation = getTargetConfirmation(target)

  assert.equal(confirmation, 'localhost:5467/test_target')
  assert.equal(assertRestoreConfirmation(target, { wipe: true, confirmTarget: confirmation }), confirmation)
  assert.throws(() => assertRestoreConfirmation(target, { confirmTarget: confirmation }), /requires --wipe/)
  assert.throws(() => assertRestoreConfirmation(target, { wipe: true, confirmTarget: 'localhost:5467/production' }), /configured target/)
})

test('restore requires compatible dump, restore, and database major versions', () => {
  assert.doesNotThrow(() => assertRestoreCompatibility({ sourceMajor: 16, pgDumpMajor: 16, pgRestoreMajor: 16, targetMajor: 16 }))
  assert.throws(() => assertRestoreCompatibility({ sourceMajor: 16, pgDumpMajor: 15, pgRestoreMajor: 16, targetMajor: 16 }), /older than source/)
  assert.throws(() => assertRestoreCompatibility({ sourceMajor: 16, pgDumpMajor: 16, pgRestoreMajor: 15, targetMajor: 16, archiveDumpMajor: 16 }), /older than the archive client/)
  assert.throws(() => assertRestoreCompatibility({ sourceMajor: 16, pgDumpMajor: 17, pgRestoreMajor: 17, targetMajor: 16, archiveDumpMajor: 16 }), /does not match the archive client/)
  assert.throws(() => assertRestoreCompatibility({ sourceMajor: 16, pgDumpMajor: 16, pgRestoreMajor: 16, targetMajor: 15 }), /same major version/)
})

test('same database is rejected even when server addresses use aliases', () => {
  assert.equal(isSameDatabase(
    { database: 'payments', serverAddress: '10.0.0.5', serverPort: 5432 },
    { serverAddress: '10.0.0.5', serverPort: 5432 },
    { host: 'source.internal', port: 5432 },
    { host: 'target.internal', port: 5432, database: 'payments' }
  ), true)
  assert.equal(isSameDatabase(
    { database: 'payments', serverAddress: '10.0.0.5', serverPort: 5432 },
    { serverAddress: '10.0.0.5', serverPort: 5432 },
    { host: 'source.internal', port: 5432 },
    { host: 'target.internal', port: 5432, database: 'payments_test' }
  ), false)
})

test('database inventory, exact counts and extensions are read through the supplied connection', async () => {
  const queries = []
  const connection = {
    query: async query => {
      queries.push(query)
      if (query.includes('FROM pg_class')) {
        return {
          rows: [
            { schema_name: 'public', relation_name: 'parent', relation_kind: 'p' },
            { schema_name: 'public', relation_name: 'leaf', relation_kind: 'r' },
            { schema_name: 'audit', relation_name: 'events', relation_kind: 'm' }
          ]
        }
      }
      if (query.includes('pg_largeobject_metadata')) return { rows: [{ count: '2' }] }
      if (query.includes('FROM pg_extension')) return { rows: [{ name: 'pgcrypto', version: '1.3' }] }
      return { rows: [{ count: '5' }] }
    }
  }

  const inventory = await getDatabaseInventory(connection)
  const counts = await getExactDataCounts(connection, inventory)
  const extensions = await getDatabaseExtensions(connection)

  assert.deepEqual(inventory.map(item => item.kind), ['p', 'r', 'm'])
  assert.deepEqual(counts, [
    { schema: 'public', name: 'leaf', count: '5' },
    { schema: 'audit', name: 'events', count: '5' },
    { schema: '', name: '$large_objects', count: '2' }
  ])
  assert.deepEqual(extensions, [{ name: 'pgcrypto', version: '1.3' }])
  assert.match(queries[1], /FROM ONLY "public"\."leaf"/)
  assert.equal(queries.some(query => query.includes('"parent"')), false)
})

test('database metadata reads locale, version and server identity', async () => {
  const connection = {
    query: async query => {
      if (query.includes('server_version_num')) {
        return {
          rows: [{
            database: 'source_db',
            server_address: '10.0.0.1',
            server_port: 5432,
            server_version: 'PostgreSQL 16.15',
            server_version_num: 160015,
            encoding: 'UTF8',
            collation: 'en_US.UTF-8',
            ctype: 'en_US.UTF-8'
          }]
        }
      }
      if (query.includes('datcollversion')) return { rows: [{ collation_version: '2.36', actual_collation_version: '2.36' }] }
      return { rows: [{ locale_provider: 'c', icu_locale: null }] }
    }
  }

  const metadata = await readDatabaseMetadata(connection)
  assert.equal(metadata.database, 'source_db')
  assert.equal(metadata.serverMajor, 16)
  assert.equal(metadata.localeProvider, 'libc')
  assert.equal(metadata.actualCollationVersion, '2.36')
})

test('locale validation allows library-version differences but rejects different locale settings', () => {
  const source = {
    encoding: 'UTF8',
    collation: 'en_US.utf8',
    ctype: 'en_US.utf8',
    localeProvider: 'libc',
    icuLocale: null,
    actualCollationVersion: '2.36'
  }
  const target = { ...source, actualCollationVersion: '2.41' }
  const comparison = compareDatabaseLocales(source, target)

  assert.equal(comparison.compatible, true)
  assert.deepEqual(comparison.differences, [])
  assert.equal(comparison.collationVersionDiffers, true)
  assert.equal(compareDatabaseLocales(source, { ...target, ctype: 'C' }).compatible, false)
})

test('extension version comparison identifies mismatched, missing, and unexpected extensions', () => {
  const comparison = compareDatabaseExtensions(
    [
      { name: 'pg_trgm', version: '1.6' },
      { name: 'uuid-ossp', version: '1.1' }
    ],
    [
      { name: 'pg_trgm', version: '1.5' },
      { name: 'citext', version: '1.6' }
    ]
  )

  assert.equal(comparison.compatible, false)
  assert.deepEqual(comparison.differences, [
    'citext: source=missing, staging=1.6',
    'uuid-ossp: source=1.1, staging=missing'
  ])
  assert.deepEqual(comparison.versionDifferences, ['pg_trgm: source=1.6, staging=1.5'])

  const versionOnly = compareDatabaseExtensions(
    [{ name: 'pg_buffercache', version: '1.3' }],
    [{ name: 'pg_buffercache', version: '1.4' }]
  )
  assert.equal(versionOnly.compatible, true)
  assert.deepEqual(versionOnly.versionDifferences, ['pg_buffercache: source=1.3, staging=1.4'])
})

test('database metadata skips collation-version columns on PostgreSQL 11 and 12', async () => {
  for (const serverVersionNum of [110021, 120021]) {
    const queries = []
    const connection = {
      query: async query => {
        queries.push(query)
        if (queries.length > 1) throw new Error('Unexpected query for unsupported collation-version columns')
        return {
          rows: [{
            database: 'legacy_source',
            server_address: '10.0.0.2',
            server_port: 5432,
            server_version: 'PostgreSQL legacy',
            server_version_num: serverVersionNum,
            encoding: 'UTF8',
            collation: 'en_US.UTF-8',
            ctype: 'en_US.UTF-8'
          }]
        }
      }
    }

    const metadata = await readDatabaseMetadata(connection)
    assert.equal(metadata.serverMajor, serverVersionNum === 110021 ? 11 : 12)
    assert.equal(metadata.collationVersion, null)
    assert.equal(queries.length, 1)
  }
})

test('schema fingerprints ignore PostgreSQL per-dump restrict keys', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-hash-test-'))
  const sourcePath = path.join(directory, 'source.sql')
  const restoredPath = path.join(directory, 'restored.sql')

  try {
    fs.writeFileSync(sourcePath, '\\restrict source-token\nCREATE TABLE public.test (id integer);\n\\unrestrict source-token\n')
    fs.writeFileSync(restoredPath, '\\restrict another-token\r\nCREATE TABLE public.test (id integer);\r\n\\unrestrict another-token\r\n')
    assert.equal(await hashSchemaDumpFile(sourcePath), await hashSchemaDumpFile(restoredPath))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('schema fingerprints ignore source server and pg_dump build metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-version-hash-test-'))
  const sourcePath = path.join(directory, 'source.sql')
  const targetPath = path.join(directory, 'target.sql')
  const differentSchemaPath = path.join(directory, 'different-schema.sql')

  try {
    fs.writeFileSync(sourcePath, [
      '-- PostgreSQL database dump',
      '-- Dumped from database version 16.9 (Ubuntu)',
      '-- Dumped by pg_dump version 16.15 (Ubuntu)',
      '-- TOC entry 220 (class 1259 OID 16486)',
      '-- Dependencies: 7',
      '',
      '',
      'CREATE TABLE public.test (id integer);',
      ''
    ].join('\n'))
    fs.writeFileSync(targetPath, [
      '-- PostgreSQL database dump',
      '-- Dumped from database version 16.15 (Debian)',
      '-- Dumped by pg_dump version 16.15 (Ubuntu)',
      '-- TOC entry 820 (class 1259 OID 17010)',
      '-- Dependencies: 9',
      'COMMENT ON SCHEMA "public" IS \'standard public schema\';',
      'CREATE TABLE public.test (id integer);',
      '',
      ''
    ].join('\n'))

    assert.equal(await hashSchemaDumpFile(sourcePath), await hashSchemaDumpFile(targetPath))
    fs.writeFileSync(differentSchemaPath, 'CREATE TABLE public.test (id bigint);\n')
    assert.notEqual(await hashSchemaDumpFile(sourcePath), await hashSchemaDumpFile(differentSchemaPath))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('schema fingerprints ignore the default heap access-method setting but preserve non-default methods', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-access-method-test-'))
  const sourcePath = path.join(directory, 'source.sql')
  const targetPath = path.join(directory, 'target.sql')
  const nonDefaultPath = path.join(directory, 'non-default.sql')

  try {
    fs.writeFileSync(sourcePath, 'CREATE TABLE public.test (id integer);\n')
    fs.writeFileSync(targetPath, 'SET default_table_access_method = "heap";\nCREATE TABLE public.test (id integer);\n')
    fs.writeFileSync(nonDefaultPath, 'SET default_table_access_method = "zheap";\nCREATE TABLE public.test (id integer);\n')

    assert.equal(await hashSchemaDumpFile(sourcePath), await hashSchemaDumpFile(targetPath))
    assert.notEqual(await hashSchemaDumpFile(sourcePath), await hashSchemaDumpFile(nonDefaultPath))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('schema mismatch diagnostics show the first executable DDL difference', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-diff-test-'))
  const sourcePath = path.join(directory, 'source.sql')
  const targetPath = path.join(directory, 'target.sql')

  try {
    fs.writeFileSync(sourcePath, '-- TOC entry 220 (source OID)\nCREATE TABLE public.test (id integer);\n')
    fs.writeFileSync(targetPath, '-- TOC entry 820 (target OID)\nCREATE TABLE public.test (id bigint);\n')

    assert.deepEqual(findFirstSchemaDumpDifference(sourcePath, targetPath), {
      line: 1,
      source: 'CREATE TABLE public.test (id integer);',
      target: 'CREATE TABLE public.test (id bigint);'
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
