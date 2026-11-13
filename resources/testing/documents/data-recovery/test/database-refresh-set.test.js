const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const databaseRefresh = require('../app/config/database-refresh')
const {
  SET_FORMAT,
  SET_VERSION,
  parseArgs,
  getConfiguredDatabaseNames,
  buildDatabaseEnvironment,
  createDatabaseBackupSet,
  readDatabaseBackupSet,
  getRestorePlan,
  getStreamRestorePlan,
  getTargetSetConfirmation,
  dryRunDatabaseRestoreSet,
  restoreDatabaseBackupSet,
  streamDatabaseRefreshSet
} = require('../app/tools/database-refresh-set')

function createTestSet (directory, baseNames = ['ffc-pay-processing', 'ffc-pay-submission']) {
  const databases = baseNames.map(baseName => {
    const sourceDatabase = `${baseName}-prd`
    const archive = `${sourceDatabase}.dump`
    const archivePath = path.join(directory, archive)
    fs.writeFileSync(archivePath, 'test archive')
    fs.writeFileSync(`${archivePath}.json`, JSON.stringify({
      format: 'ffc-pay-database-archive',
      version: 1,
      archive,
      source: {
        database: sourceDatabase,
        serviceName: baseName,
        serverMajor: 16
      },
      client: { pgDumpMajor: 16 },
      verification: { schemaSha256: 'test-schema-hash' }
    }))
    return { baseName, sourceDatabase, targetDatabaseAtCreation: `${baseName}-local`, archive }
  })

  const manifest = {
    format: SET_FORMAT,
    version: SET_VERSION,
    name: 'test-set',
    sourceEnvironment: 'prd',
    targetEnvironmentAtCreation: 'local',
    databases
  }
  const manifestPath = path.join(directory, 'database-refresh-set.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  return { manifest, manifestPath }
}

function testConfig (targetEnvironment = 'local', databaseNames = ['ffc-pay-processing', 'ffc-pay-submission']) {
  return { SOURCE_ENV: 'prd', TARGET_ENV: targetEnvironment, DATABASE_NAMES: databaseNames }
}

test('set CLI accepts database subsets and requires safe restore options', () => {
  assert.deepEqual(parseArgs(['backup', '--database', 'ffc-pay-processing']), {
    action: 'backup',
    help: false,
    dryRun: false,
    wipe: false,
    anonymise: false,
    outputDir: null,
    manifest: null,
    confirmTargetSet: null,
    databaseNames: ['ffc-pay-processing']
  })
  assert.throws(() => parseArgs(['restore', '--manifest', 'set.json']), /requires --wipe/)
  assert.throws(() => parseArgs(['restore', '--manifest', 'set.json', '--wipe']), /confirm-target-set/)
  assert.throws(() => parseArgs(['restore', '--manifest', 'set.json', '--dry-run', '--wipe']), /Do not pass/)
  assert.equal(parseArgs(['stream', '--dry-run']).action, 'stream')
  assert.throws(() => parseArgs(['stream']), /requires --wipe/)
  assert.throws(() => parseArgs(['stream', '--wipe']), /confirm-target-set/)
})

test('configured database selection rejects unknown and duplicate names', () => {
  const config = testConfig()
  assert.deepEqual(getConfiguredDatabaseNames([], config), config.DATABASE_NAMES)
  assert.deepEqual(getConfiguredDatabaseNames(['ffc-pay-submission'], config), ['ffc-pay-submission'])
  assert.throws(() => getConfiguredDatabaseNames(['unknown'], config), /not listed/)
  assert.throws(() => getConfiguredDatabaseNames(['ffc-pay-processing', 'ffc-pay-processing'], config), /duplicate/)
})

test('per-database environments set source/target suffixes and clear single-database overrides', () => {
  const inherited = {
    RECOVERY_SOURCE_DATABASE: 'stale_source',
    RECOVERY_TARGET_DATABASE: 'stale_target',
    RECOVERY_TARGET_MODE: 'hosted'
  }
  const source = buildDatabaseEnvironment('ffc-pay-processing', 'source', inherited, testConfig())
  const target = buildDatabaseEnvironment('ffc-pay-processing', 'target', inherited, testConfig())

  assert.equal(source.RECOVERY_SOURCE_ENV, 'prd')
  assert.equal(source.RECOVERY_SERVICE_NAME, 'ffc-pay-processing')
  assert.equal(source.RECOVERY_SOURCE_DB_AUTH, 'entra')
  assert.equal(source.RECOVERY_SOURCE_DATABASE, undefined)
  assert.equal(target.RECOVERY_TARGET_ENV, 'local')
  assert.equal(target.RECOVERY_TARGET_MODE, 'local')
  assert.equal(target.RECOVERY_TARGET_DB_AUTH, 'password')
  assert.equal(target.RECOVERY_TARGET_DATABASE, 'ffc_pay_processing')
  assert.equal(target.LOCAL_DB_PORT, '5467')
})

test('per-database environments apply configured auth mode and tenant overrides', () => {
  const config = {
    ...testConfig('test'),
    DEFAULT_SOURCE_AUTH: 'entra',
    DEFAULT_HOSTED_TARGET_AUTH: 'entra',
    DATABASE_AUTH_OVERRIDES: {
      'ffc-pay-processing': {
        source: { mode: 'password' },
        target: { mode: 'entra', tenantId: 'service-tenant' }
      }
    }
  }
  const environment = {
    RECOVERY_SOURCE_DB_AUTH: 'entra',
    RECOVERY_SOURCE_DB_PASSWORD: 'source-password',
    RECOVERY_TARGET_DB_AUTH: 'password',
    RECOVERY_TARGET_DB_TENANT_ID: 'global-target-tenant'
  }
  const source = buildDatabaseEnvironment('ffc-pay-processing', 'source', environment, config)
  const target = buildDatabaseEnvironment('ffc-pay-processing', 'target', environment, config)

  assert.equal(source.RECOVERY_SOURCE_DB_AUTH, 'password')
  assert.equal(target.RECOVERY_TARGET_DB_AUTH, 'entra')
  assert.equal(target.RECOVERY_TARGET_DB_TENANT_ID, 'service-tenant')
})

test('backup set writes private archives and a manifest for every selected database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-set-test-'))
  const config = testConfig('test')
  const calls = []

  try {
    const result = await createDatabaseBackupSet({
      config,
      environment: { RECOVERY_SOURCE_DB_HOST: 'source.example' },
      outputDir: directory,
      databaseNames: ['ffc-pay-processing']
    }, {
      createDatabaseArchive: async options => {
        calls.push(options.environment.RECOVERY_SOURCE_ENV)
        fs.writeFileSync(options.output, 'test archive')
        fs.writeFileSync(`${options.output}.json`, JSON.stringify({ test: true }))
      }
    })

    assert.deepEqual(calls, ['prd'])
    const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'))
    assert.equal(manifest.databases.length, 1)
    assert.equal(manifest.databases[0].baseName, 'ffc-pay-processing')
    assert.equal(manifest.databases[0].sourceDatabase, 'ffc-pay-processing-prd')
    assert.equal(fs.statSync(result.manifest).mode & 0o777, 0o600)
    assert.equal(fs.existsSync(path.join(path.dirname(result.manifest), manifest.databases[0].archive)), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('set manifest validates archive files and source database identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-manifest-test-'))
  try {
    const { manifestPath } = createTestSet(directory, ['ffc-pay-processing'])
    const backupSet = readDatabaseBackupSet(manifestPath, testConfig())
    assert.equal(backupSet.databases[0].archivePath, path.join(directory, 'ffc-pay-processing-prd.dump'))

    const invalidManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    invalidManifest.databases[0].sourceDatabase = 'wrong-database'
    fs.writeFileSync(manifestPath, JSON.stringify(invalidManifest))
    assert.throws(() => readDatabaseBackupSet(manifestPath, testConfig()), /source name does not match/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('local restore plan uses one target database per base name and stable set confirmation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-plan-test-'))
  try {
    const { manifestPath } = createTestSet(directory)
    const backupSet = readDatabaseBackupSet(manifestPath, testConfig())
    const plan = getRestorePlan(backupSet, {
      config: testConfig(),
      environment: { LOCAL_DB_HOST: 'localhost', LOCAL_DB_PORT: '5467' }
    })

    assert.deepEqual(plan.map(entry => entry.target.database), [
      'ffc_pay_processing',
      'ffc_pay_submission'
    ])
    assert.equal(getTargetSetConfirmation(plan), getTargetSetConfirmation(plan))
    assert.notEqual(
      getTargetSetConfirmation(plan),
      getTargetSetConfirmation(plan.map((entry, index) => index === 0 ? { ...entry, archiveSha256: 'changed' } : entry))
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stream plan resolves local target names and per-service ports with a default port', () => {
  const config = {
    ...testConfig(),
    LOCAL_DATABASE_TARGETS: {
      'ffc-pay-processing': { databaseName: 'ffc_pay_processing', port: 5443 }
    }
  }
  const plan = getStreamRestorePlan(['ffc-pay-processing'], {
    config,
    environment: { LOCAL_DB_HOST: '127.0.0.1' }
  })

  assert.equal(plan[0].sourceDatabase, 'ffc-pay-processing-prd')
  assert.equal(plan[0].targetDatabase, 'ffc_pay_processing')
  assert.equal(plan[0].target.database, 'ffc_pay_processing')
  assert.equal(plan[0].target.port, 5443)
  assert.equal(plan[0].environment.RECOVERY_SOURCE_ENV, 'prd')
  assert.equal(plan[0].environment.RECOVERY_TARGET_ENV, 'local')

  const defaultPlan = getStreamRestorePlan(['ffc-pay-submission'], {
    config: testConfig(),
    environment: {}
  })
  assert.equal(defaultPlan[0].target.database, 'ffc_pay_submission')
  assert.equal(defaultPlan[0].target.port, 5467)
})

test('repository refresh config selects source databases and maps each localhost target', () => {
  const plan = getStreamRestorePlan([], { config: databaseRefresh, environment: {} })

  assert.deepEqual(
    plan.map(entry => entry.sourceDatabase),
    databaseRefresh.DATABASE_NAMES.map(baseName => `${baseName}-${databaseRefresh.SOURCE_ENV}`)
  )
  assert.deepEqual(
    plan.map(entry => ({ host: entry.target.host, port: entry.target.port, database: entry.target.database })),
    databaseRefresh.DATABASE_NAMES.map(baseName => ({
      host: 'localhost',
      port: databaseRefresh.LOCAL_DATABASE_TARGETS[baseName].port,
      database: databaseRefresh.LOCAL_DATABASE_TARGETS[baseName].databaseName
    }))
  )
})

test('set dry run checks every database before returning the set confirmation', async () => {
  const plan = [
    { baseName: 'db-a', archivePath: '/archive/a.dump', environment: {}, confirmation: 'host:5432/db-a' },
    { baseName: 'db-b', archivePath: '/archive/b.dump', environment: {}, confirmation: 'host:5432/db-b' }
  ]
  const checked = []
  const result = await dryRunDatabaseRestoreSet(plan, {}, {
    restoreDatabaseArchive: async options => {
      checked.push(options.archive)
      return { dryRun: true }
    }
  })

  assert.deepEqual(checked, ['/archive/a.dump', '/archive/b.dump'])
  assert.equal(result.confirmation, getTargetSetConfirmation(plan))
})

test('live set restore prepares the entire set before cutting over any database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-live-test-'))
  const events = []
  try {
    const { manifestPath } = createTestSet(directory)
    const config = testConfig()
    const backupSet = readDatabaseBackupSet(manifestPath, config)
    const plan = getRestorePlan(backupSet, { config, environment: {} })
    const confirmation = getTargetSetConfirmation(plan)
    const result = await restoreDatabaseBackupSet({
      manifest: manifestPath,
      wipe: true,
      confirmTargetSet: confirmation,
      config,
      environment: {}
    }, {
      readDatabaseBackupSet: () => backupSet,
      prepareDatabaseArchiveRestore: async options => {
        events.push(`prepare:${options.archive}`)
        return { stagingDatabase: `stage-${events.length}`, target: { database: 'target' }, confirmation: 'target', stageCreated: true }
      },
      commitPreparedDatabaseRestore: async prepared => {
        events.push(`commit:${prepared.stagingDatabase}`)
        return { previousDatabase: `previous-${prepared.stagingDatabase}` }
      },
      cleanupPreparedDatabaseRestore: async prepared => events.push(`cleanup:${prepared.stagingDatabase}`)
    })

    assert.deepEqual(events.slice(0, 4), [
      'prepare:' + backupSet.databases[0].archivePath,
      'prepare:' + backupSet.databases[1].archivePath,
      'commit:stage-1',
      'commit:stage-2'
    ])
    assert.equal(result.databases.length, 2)
    assert.equal(events.filter(event => event.startsWith('cleanup:')).length, 2)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a later cutover failure rolls back already committed databases', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-rollback-test-'))
  const events = []
  try {
    const { manifestPath } = createTestSet(directory)
    const config = testConfig()
    const backupSet = readDatabaseBackupSet(manifestPath, config)
    const plan = getRestorePlan(backupSet, { config, environment: {} })

    await assert.rejects(restoreDatabaseBackupSet({
      manifest: manifestPath,
      wipe: true,
      confirmTargetSet: getTargetSetConfirmation(plan),
      config,
      environment: {}
    }, {
      readDatabaseBackupSet: () => backupSet,
      prepareDatabaseArchiveRestore: async options => {
        events.push(`prepare:${options.archive}`)
        return { baseName: path.basename(options.archive), stagingDatabase: `stage-${events.filter(event => event.startsWith('prepare:')).length}`, target: { database: 'target' }, confirmation: 'target', stageCreated: true }
      },
      commitPreparedDatabaseRestore: async prepared => {
        events.push(`commit:${prepared.stagingDatabase}`)
        if (prepared.stagingDatabase === 'stage-2') throw new Error('injected cutover failure')
        return { previousDatabase: 'previous-stage-1' }
      },
      rollbackPreparedDatabaseRestore: async prepared => events.push(`rollback:${prepared.stagingDatabase}`),
      cleanupPreparedDatabaseRestore: async prepared => events.push(`cleanup:${prepared.stagingDatabase}`)
    }), /rolled back/)

    assert.deepEqual(events.filter(event => event.startsWith('rollback:')), ['rollback:stage-1'])
    assert.equal(events.filter(event => event.startsWith('cleanup:')).length, 2)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stream set stages every database before committing targets', async () => {
  const events = []
  const config = testConfig()
  const plan = getStreamRestorePlan([], { config, environment: {} })
  const confirmation = getTargetSetConfirmation(plan, 'stream')
  const result = await streamDatabaseRefreshSet({
    wipe: true,
    confirmTargetSet: confirmation,
    config,
    environment: {}
  }, {
    checkDatabaseTargetAvailability: async options => {
      events.push(`check:${options.environment.RECOVERY_SERVICE_NAME}`)
    },
    prepareDatabaseStreamRestore: async options => {
      events.push(`prepare:${options.environment.RECOVERY_SERVICE_NAME}`)
      return {
        baseName: options.environment.RECOVERY_SERVICE_NAME,
        stagingDatabase: `stage-${events.filter(event => event.startsWith('prepare:')).length}`,
        target: { database: `${options.environment.RECOVERY_SERVICE_NAME}-local` },
        confirmation: `${options.environment.RECOVERY_SERVICE_NAME}-target`,
        stageCreated: true
      }
    },
    commitPreparedDatabaseRestore: async prepared => {
      events.push(`commit:${prepared.stagingDatabase}`)
      return { previousDatabase: `previous-${prepared.stagingDatabase}` }
    },
    cleanupPreparedDatabaseRestore: async prepared => events.push(`cleanup:${prepared.stagingDatabase}`)
  })

  assert.deepEqual(events.slice(0, 6), [
    'check:ffc-pay-processing',
    'check:ffc-pay-submission',
    'prepare:ffc-pay-processing',
    'prepare:ffc-pay-submission',
    'commit:stage-1',
    'commit:stage-2'
  ])
  assert.equal(result.databases.length, 2)
  assert.equal(events.filter(event => event.startsWith('cleanup:')).length, 2)
})

test('stream set does not start transfers when a target is unavailable', async () => {
  const events = []
  const config = testConfig()
  const plan = getStreamRestorePlan([], { config, environment: {} })

  await assert.rejects(streamDatabaseRefreshSet({
    wipe: true,
    confirmTargetSet: getTargetSetConfirmation(plan, 'stream'),
    config,
    environment: {}
  }, {
    checkDatabaseTargetAvailability: async options => {
      const baseName = options.environment.RECOVERY_SERVICE_NAME
      events.push(`check:${baseName}`)
      if (baseName === 'ffc-pay-submission') throw new Error('target unavailable')
    },
    prepareDatabaseStreamRestore: async options => {
      events.push(`prepare:${options.environment.RECOVERY_SERVICE_NAME}`)
    }
  }), /target unavailable/)

  assert.deepEqual(events, [
    'check:ffc-pay-processing',
    'check:ffc-pay-submission'
  ])
})

test('set anonymisation is opt-in and changes confirmation only for configured databases', () => {
  assert.throws(() => parseArgs(['backup', '--anonymise']), /Backup accepts only/)
  assert.equal(parseArgs(['stream', '--dry-run', '--anonymise']).anonymise, true)
  assert.equal(parseArgs(['restore', '--manifest', 'set.json', '--dry-run', '--anonymise']).anonymise, true)
  const config = testConfig('local', ['ffc-doc-statement-data', 'ffc-pay-processing'])
  const normal = getStreamRestorePlan([], { config, environment: {} })
  const masked = getStreamRestorePlan([], { config, environment: {}, anonymise: true })
  assert.notEqual(getTargetSetConfirmation(normal, 'stream'), getTargetSetConfirmation(masked, 'stream'))
  assert.match(masked[0].confirmation, /#anonymise=/)
  assert.equal(masked[1].confirmation, normal[1].confirmation)
  assert.equal(masked[1].anonymisation.tables.length, 0)
  assert.throws(() => getStreamRestorePlan([], { config: testConfig(), environment: {}, anonymise: true }), /No selected databases/)
})

test('masked stream dry run passes masking only to configured database preparation', async () => {
  const config = testConfig('local', ['ffc-doc-statement-data', 'ffc-pay-processing'])
  const prepared = []
  await streamDatabaseRefreshSet({ config, environment: {}, dryRun: true, anonymise: true }, {
    prepareDatabaseStreamRestore: async options => { prepared.push(options); return { dryRun: true } }
  })
  assert.deepEqual(prepared.map(options => options.anonymise), [true, false])
  assert.ok(prepared.every(options => options.dryRun))
})

test('a normal refresh token cannot authorise an anonymised stream', async () => {
  const config = testConfig('local', ['ffc-doc-statement-data'])
  const plan = getStreamRestorePlan([], { config, environment: {} })
  await assert.rejects(streamDatabaseRefreshSet({
    config,
    environment: {},
    anonymise: true,
    wipe: true,
    confirmTargetSet: getTargetSetConfirmation(plan, 'stream')
  }), /must exactly match/)
})

test('masking failure during set preparation prevents all cutovers and cleans prepared databases', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-refresh-anonymise-test-'))
  const events = []
  try {
    const names = ['ffc-doc-statement-data', 'ffc-doc-statement-constructor']
    const config = testConfig('local', names)
    const { manifestPath } = createTestSet(directory, names)
    const backupSet = readDatabaseBackupSet(manifestPath, config)
    const plan = getRestorePlan(backupSet, { config, environment: {}, anonymise: true })
    await assert.rejects(restoreDatabaseBackupSet({
      manifest: manifestPath,
      config,
      environment: {},
      anonymise: true,
      wipe: true,
      confirmTargetSet: getTargetSetConfirmation(plan)
    }, {
      readDatabaseBackupSet: () => backupSet,
      prepareDatabaseArchiveRestore: async options => {
        assert.equal(options.anonymise, true)
        assert.match(options.confirmTarget, /#anonymise=/)
        events.push('prepare')
        if (events.length === 2) throw new Error('Anonymisation failed')
        return { stagingDatabase: 'first-stage', stageCreated: true }
      },
      commitPreparedDatabaseRestore: async () => events.push('commit'),
      cleanupPreparedDatabaseRestore: async () => events.push('cleanup')
    }), /Anonymisation failed/)
    assert.deepEqual(events, ['prepare', 'prepare', 'cleanup'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
