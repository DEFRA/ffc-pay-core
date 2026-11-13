const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const test = require('node:test')
const { createPostgresConnection } = require('../app/database/postgres-connection')
const archiveTool = require('../app/tools/database-archive')
const { anonymiseDatabaseTarget } = require('../app/tools/database-anonymise')
const documentMapper = require('../app/faker/map-document-org-faker')

const image = process.env.RECOVERY_TEST_POSTGRES_IMAGE

const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}

test('anonymisation against an isolated PostgreSQL server', { skip: !image, timeout: 120000 }, async context => {
  const container = docker([
    'run', '--detach', '--rm', '--pull=never', '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER=recovery_test', '--env', 'POSTGRES_PASSWORD=recovery_test_only', image
  ])
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-anonymisation-test-'))
  let admin
  try {
    const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]))
    const port = Number(ports['5432/tcp'][0].HostPort)
    const connectionConfig = { host: '127.0.0.1', port, user: 'recovery_test', password: 'recovery_test_only' }
    admin = await createPostgresConnection({ ...connectionConfig, database: 'postgres' }, { max: 1 })
    const sourceDatabase = 'ffc-doc-statement-data-test'
    const constructorSource = 'ffc-doc-statement-constructor-test'
    const targetDatabase = 'ffc_doc_statement_data'
    const constructorTarget = 'ffc_doc_statement_constructor'

    const query = async (database, sql) => {
      const connection = await createPostgresConnection({ ...connectionConfig, database }, { max: 1 })
      try {
        return await connection.query(sql)
      } finally {
        await connection.close()
      }
    }

    for (const database of [sourceDatabase, constructorSource]) {
      await admin.query(`CREATE DATABASE "${database}"`)
      await query(database, `
        CREATE TABLE organisations (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          frn bigint NOT NULL, sbi bigint NOT NULL,
          name text, "addressLine1" text, "addressLine2" text, "addressLine3" text,
          city text, county text, postcode text, "emailAddress" text,
          "phoneNumber" text, updated timestamp, published boolean, amount numeric(12, 4), metadata jsonb
        );
        INSERT INTO organisations (frn, sbi, name, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", "phoneNumber", updated, published, amount, metadata)
        VALUES
          (100000001, 200000001, 'Original first', 'Original address', 'Original district', 'Original locality', 'Original city', 'Original county', 'AA1 1AA', 'original@example.invalid', '01234 567890', '2026-01-01 01:02:03.123456', true, 123.4567, '{"untouched":true}'),
          (100000002, 200000002, 'Original second', 'Second address', '', NULL, 'Second city', 'Second county', 'BB2 2BB', NULL, NULL, '2026-01-02 01:02:03.654321', false, 987.6543, '{"untouched":false}');
        INSERT INTO organisations (frn, sbi, name, "addressLine1", "emailAddress", updated, amount)
        SELECT 100000000 + customer, 200000000 + customer, 'Original organisation', 'Original address',
          'original@example.invalid', '2026-01-01 01:02:03.123456', 123.4567
        FROM generate_series(3, 502) AS customer;
        CREATE TABLE unrelated_data (id integer PRIMARY KEY, value text);
        INSERT INTO unrelated_data VALUES (1, 'Keep exactly');
      `)
    }

    const readRows = async (database) => {
      const { rows } = await query(database, 'SELECT to_jsonb(organisation) AS value FROM organisations organisation ORDER BY id')
      return rows.map(row => row.value)
    }

    const original = await readRows(sourceDatabase)
    const environment = {
      RECOVERY_SERVICE_NAME: 'ffc-doc-statement-data',
      RECOVERY_SOURCE_DATABASE: sourceDatabase,
      RECOVERY_SOURCE_DB_HOST: connectionConfig.host,
      RECOVERY_SOURCE_DB_PORT: String(port),
      RECOVERY_SOURCE_DB_USER: connectionConfig.user,
      RECOVERY_SOURCE_DB_PASSWORD: connectionConfig.password,
      RECOVERY_SOURCE_DB_AUTH: 'password',
      RECOVERY_SOURCE_DB_SSL: 'false',
      RECOVERY_TARGET_MODE: 'local',
      RECOVERY_TARGET_ENV: 'local',
      RECOVERY_TARGET_DATABASE: targetDatabase,
      LOCAL_DB_HOST: connectionConfig.host,
      LOCAL_DB_PORT: String(port),
      LOCAL_DB_USER: connectionConfig.user,
      LOCAL_DB_PASSWORD: connectionConfig.password
    }
    const archive = path.join(directory, 'source.dump')
    let masked

    await context.test('archive restore masks only allowlisted fields and keeps source data unchanged', async () => {
      await archiveTool.createDatabaseArchive({ environment, output: archive })
      const dryRun = await archiveTool.restoreDatabaseArchive({ environment, archive, dryRun: true, anonymise: true })
      const result = await archiveTool.restoreDatabaseArchive({ environment, archive, wipe: true, confirmTarget: dryRun.target, anonymise: true })
      assert.equal(result.anonymisation.tables[0].updatedRows, 502)
      masked = await readRows(targetDatabase)
      assert.deepEqual(masked, original.map(organisation => documentMapper.anonymizeOrganisation(organisation)))
      assert.deepEqual(await readRows(sourceDatabase), original)
      assert.deepEqual((await query(targetDatabase, 'SELECT * FROM unrelated_data')).rows, [{ id: 1, value: 'Keep exactly' }])
    })

    await context.test('standalone masking is repeatable and makes no redundant updates', async () => {
      const options = {
        databaseName: 'ffc-doc-statement-data',
        environment,
        refreshConfig: { SOURCE_ENV: 'test', TARGET_ENV: 'local' }
      }
      const dryRun = await anonymiseDatabaseTarget({ ...options, dryRun: true })
      const result = await anonymiseDatabaseTarget({ ...options, confirmTarget: dryRun.target })
      assert.equal(result.tables[0].updatedRows, 0)
      assert.deepEqual(await readRows(targetDatabase), masked)
    })

    await context.test('streaming generates matching customer details in the other document database', async () => {
      const streamEnvironment = {
        ...environment,
        RECOVERY_SERVICE_NAME: 'ffc-doc-statement-constructor',
        RECOVERY_SOURCE_DATABASE: constructorSource,
        RECOVERY_TARGET_DATABASE: constructorTarget
      }
      const dryRun = await archiveTool.prepareDatabaseStreamRestore({ environment: streamEnvironment, dryRun: true, anonymise: true })
      const prepared = await archiveTool.prepareDatabaseStreamRestore({ environment: streamEnvironment, wipe: true, confirmTarget: dryRun.target, anonymise: true })
      try {
        await archiveTool.commitPreparedDatabaseRestore(prepared)
      } finally {
        await archiveTool.cleanupPreparedDatabaseRestore(prepared)
      }
      assert.deepEqual(await readRows(constructorTarget), masked)
      assert.deepEqual(await readRows(constructorSource), original)
    })

    await context.test('an unsafe update trigger prevents cutover and leaves the existing target intact', async () => {
      await query(sourceDatabase, `
        CREATE FUNCTION touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.updated = clock_timestamp(); RETURN NEW; END;
        $$;
        CREATE TRIGGER touch_updated BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION touch_updated();
      `)
      const unsafeArchive = path.join(directory, 'unsafe.dump')
      await archiveTool.createDatabaseArchive({ environment, output: unsafeArchive })
      const dryRun = await archiveTool.restoreDatabaseArchive({ environment, archive: unsafeArchive, dryRun: true, anonymise: true })
      await assert.rejects(archiveTool.restoreDatabaseArchive({
        environment,
        archive: unsafeArchive,
        wipe: true,
        confirmTarget: dryRun.target,
        anonymise: true
      }), /triggers or UPDATE rules/)
      assert.deepEqual(await readRows(targetDatabase), masked)
      const leftovers = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE '%_restore_%'")
      assert.equal(leftovers.rows.length, 0)
    })
  } finally {
    if (admin) await admin.close()
    docker(['rm', '--force', container])
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
