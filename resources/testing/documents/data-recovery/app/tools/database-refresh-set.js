#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const databaseRefresh = require('../config/database-refresh')
const databaseProfiles = require('../config/database-profiles')
const archiveTool = require('./database-archive')
const {
  createTemporaryDatabaseName,
  getTargetConfirmation,
  quoteIdentifier
} = require('../services/database-archive-service')

const SET_FORMAT = 'ffc-pay-database-refresh-set'
const SET_VERSION = 1

function parseArgs (argv = process.argv.slice(2)) {
  const [action, ...rest] = argv
  const options = {
    action,
    help: false,
    dryRun: false,
    wipe: false,
    outputDir: null,
    manifest: null,
    confirmTargetSet: null,
    databaseNames: []
  }

  if (!action || action === '--help' || action === '-h') {
    options.help = true
    return options
  }
  if (!['backup', 'restore', 'stream'].includes(action)) {
    throw new Error(`Unknown action "${action}". Choose backup, restore, or stream.`)
  }

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--output-dir') {
      options.outputDir = rest[++index]
      if (!options.outputDir) throw new Error('--output-dir requires a directory path')
    } else if (arg === '--manifest') {
      options.manifest = rest[++index]
      if (!options.manifest) throw new Error('--manifest requires a set manifest path')
    } else if (arg === '--database') {
      const databaseName = rest[++index]
      if (!databaseName) throw new Error('--database requires a base database name')
      options.databaseNames.push(databaseName)
    } else if (arg === '--confirm-target-set') {
      options.confirmTargetSet = rest[++index]
      if (!options.confirmTargetSet) throw new Error('--confirm-target-set requires the token printed by --dry-run')
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--wipe') {
      options.wipe = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option "${arg}"`)
    }
  }

  if (options.help) return options

  if (action === 'backup') {
    if (options.manifest || options.dryRun || options.wipe || options.confirmTargetSet) {
      throw new Error('Backup accepts only --output-dir and --database')
    }
  } else if (action === 'restore') {
    if (!options.manifest) throw new Error('Restore requires --manifest <set-manifest.json>')
    if (options.outputDir || options.databaseNames.length > 0) {
      throw new Error('Restore uses the database list recorded in the backup-set manifest')
    }
    if (options.dryRun && (options.wipe || options.confirmTargetSet)) {
      throw new Error('Do not pass --wipe or --confirm-target-set with --dry-run')
    }
    if (!options.dryRun && !options.wipe) {
      throw new Error('A live set restore requires --wipe')
    }
    if (!options.dryRun && !options.confirmTargetSet) {
      throw new Error('A live set restore requires --confirm-target-set from a dry run')
    }
  } else {
    if (options.manifest || options.outputDir) throw new Error('Streaming accepts only --database, --dry-run, and live confirmation options')
    if (options.dryRun && (options.wipe || options.confirmTargetSet)) {
      throw new Error('Do not pass --wipe or --confirm-target-set with --dry-run')
    }
    if (!options.dryRun && !options.wipe) throw new Error('A live stream requires --wipe')
    if (!options.dryRun && !options.confirmTargetSet) {
      throw new Error('A live stream requires --confirm-target-set from a dry run')
    }
  }

  return options
}

function usage () {
  return [
    'Usage:',
    '  npm run database:backup-set -- [--output-dir <directory>] [--database <base-name> ...]',
    '  npm run database:restore-set -- --manifest <set-manifest.json> --dry-run',
    '  npm run database:restore-set -- --manifest <set-manifest.json> --wipe --confirm-target-set <token>',
    '  npm run database:stream-set -- --dry-run [--database <base-name> ...]',
    '  npm run database:stream-set -- --wipe --confirm-target-set <token> [--database <base-name> ...]',
    '',
    'The base database names and SOURCE_ENV/TARGET_ENV are configured in app/config/database-refresh.js.'
  ].join('\n')
}

function getConfiguredDatabaseNames (requestedNames, config = databaseRefresh) {
  const configuredNames = config.DATABASE_NAMES
  if (!Array.isArray(configuredNames) || configuredNames.length === 0) {
    throw new Error('DATABASE_NAMES in app/config/database-refresh.js must contain at least one base database name')
  }

  if (new Set(configuredNames).size !== configuredNames.length) {
    throw new Error('DATABASE_NAMES in app/config/database-refresh.js contains duplicate base names')
  }

  const selectedNames = requestedNames.length > 0 ? requestedNames : configuredNames
  if (new Set(selectedNames).size !== selectedNames.length) {
    throw new Error('The selected database list contains duplicate base names')
  }

  for (const baseName of selectedNames) {
    if (!configuredNames.includes(baseName)) {
      throw new Error(`Database "${baseName}" is not listed in app/config/database-refresh.js`)
    }
    databaseProfiles.resolveDatabasePair(baseName, config.SOURCE_ENV, config.TARGET_ENV)
  }

  return selectedNames
}

function buildDatabaseEnvironment (baseName, side, environment = process.env, config = databaseRefresh) {
  const databaseEnvironment = {
    ...environment,
    RECOVERY_SERVICE_NAME: baseName
  }
  delete databaseEnvironment.RECOVERY_SOURCE_DATABASE
  delete databaseEnvironment.RECOVERY_TARGET_DATABASE

  if (side === 'source') {
    databaseEnvironment.RECOVERY_SOURCE_ENV = config.SOURCE_ENV
  } else {
    databaseEnvironment.RECOVERY_TARGET_ENV = config.TARGET_ENV
    databaseEnvironment.RECOVERY_TARGET_MODE = config.TARGET_ENV === 'local' ? 'local' : 'hosted'
  }

  return databaseEnvironment
}

function getSetRunToken () {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${timestamp}_${crypto.randomBytes(4).toString('hex')}`
}

function safeFilePart (value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function writePrivateJson (filePath, value) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

async function createDatabaseBackupSet (options = {}, dependencies = {}) {
  const config = options.config || databaseRefresh
  const environment = options.environment || process.env
  const databaseNames = getConfiguredDatabaseNames(options.databaseNames || [], config)
  const createArchive = dependencies.createDatabaseArchive || archiveTool.createDatabaseArchive
  const outputRoot = path.resolve(options.outputDir || path.resolve(__dirname, '../..', 'dumps'))
  const setName = `database-refresh-${safeFilePart(config.SOURCE_ENV)}-to-${safeFilePart(config.TARGET_ENV)}-${getSetRunToken()}`
  const finalDirectory = path.join(outputRoot, setName)

  fs.mkdirSync(outputRoot, { recursive: true })
  if (fs.existsSync(finalDirectory)) throw new Error(`Backup-set output already exists: ${finalDirectory}`)

  const temporaryDirectory = fs.mkdtempSync(path.join(outputRoot, `.${setName}-`))
  fs.chmodSync(temporaryDirectory, 0o700)

  try {
    const databases = []
    for (const baseName of databaseNames) {
      const names = databaseProfiles.resolveDatabasePair(baseName, config.SOURCE_ENV, config.TARGET_ENV)
      const archiveFile = `${safeFilePart(names.sourceDatabase)}.dump`
      const archivePath = path.join(temporaryDirectory, archiveFile)
      const sourceEnvironment = buildDatabaseEnvironment(baseName, 'source', environment, config)

      console.log(`\n=== Backing up ${names.sourceDatabase} ===`)
      await createArchive({ environment: sourceEnvironment, output: archivePath })
      databases.push({
        baseName,
        sourceDatabase: names.sourceDatabase,
        targetDatabaseAtCreation: names.targetDatabase,
        archive: archiveFile
      })
    }

    const manifest = {
      format: SET_FORMAT,
      version: SET_VERSION,
      name: setName,
      createdAt: new Date().toISOString(),
      sourceEnvironment: config.SOURCE_ENV,
      targetEnvironmentAtCreation: config.TARGET_ENV,
      databases
    }
    writePrivateJson(path.join(temporaryDirectory, 'database-refresh-set.json'), manifest)
    fs.renameSync(temporaryDirectory, finalDirectory)

    const manifestPath = path.join(finalDirectory, 'database-refresh-set.json')
    console.log(`\nDatabase backup set created: ${manifestPath}`)
    return { name: setName, manifest: manifestPath, databases }
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

function readDatabaseBackupSet (manifestPath, config = databaseRefresh) {
  const resolvedManifestPath = path.resolve(manifestPath)
  if (!fs.existsSync(resolvedManifestPath)) throw new Error(`Backup-set manifest not found: ${resolvedManifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read backup-set manifest: ${error.message}`)
  }

  if (manifest.format !== SET_FORMAT || manifest.version !== SET_VERSION || !Array.isArray(manifest.databases) || manifest.databases.length === 0) {
    throw new Error('Backup-set manifest format, version, or database list is invalid')
  }
  if (!manifest.sourceEnvironment || !manifest.targetEnvironmentAtCreation) {
    throw new Error('Backup-set manifest is missing its source or target environment')
  }

  const configuredNames = new Set(getConfiguredDatabaseNames([], config))
  const seen = new Set()
  const directory = path.dirname(resolvedManifestPath)
  const databases = manifest.databases.map(entry => {
    if (!entry.baseName || !configuredNames.has(entry.baseName)) {
      throw new Error(`Backup-set database "${entry.baseName}" is not in the current DATABASE_NAMES configuration`)
    }
    if (seen.has(entry.baseName)) throw new Error(`Backup-set contains duplicate database "${entry.baseName}"`)
    seen.add(entry.baseName)

    const expectedSourceDatabase = databaseProfiles.getServiceDatabaseName(entry.baseName, manifest.sourceEnvironment, 'SOURCE_ENV')
    if (entry.sourceDatabase !== expectedSourceDatabase) {
      throw new Error(`Backup-set source name does not match ${entry.baseName}-${manifest.sourceEnvironment}`)
    }
    if (typeof entry.archive !== 'string' || path.basename(entry.archive) !== entry.archive) {
      throw new Error(`Invalid archive path for ${entry.baseName} in backup-set manifest`)
    }

    const archivePath = path.resolve(directory, entry.archive)
    if (!archivePath.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`Archive path escapes the backup-set directory for ${entry.baseName}`)
    }
    const { manifest: archiveManifest } = archiveTool.readArchiveManifest(archivePath)
    if (archiveManifest.source.database !== expectedSourceDatabase) {
      throw new Error(`Archive source database does not match ${expectedSourceDatabase}`)
    }
    if (archiveManifest.source.serviceName && archiveManifest.source.serviceName !== entry.baseName) {
      throw new Error(`Archive service name does not match ${entry.baseName}`)
    }
    return { ...entry, archivePath, archiveSha256: archiveManifest.sha256 }
  })

  return { manifest, manifestPath: resolvedManifestPath, databases }
}

function getRestorePlan (backupSet, options = {}) {
  const config = options.config || databaseRefresh
  const environment = options.environment || process.env

  return backupSet.databases.map(entry => {
    const targetEnvironment = buildDatabaseEnvironment(entry.baseName, 'target', environment, config)
    const target = archiveTool.getTargetProfile(targetEnvironment, {
      serviceName: entry.baseName,
      database: entry.sourceDatabase
    })
    return {
      ...entry,
      environment: targetEnvironment,
      target,
      confirmation: getTargetConfirmation(target)
    }
  })
}

function getStreamRestorePlan (requestedNames, options = {}) {
  const config = options.config || databaseRefresh
  const environment = options.environment || process.env
  const databaseNames = getConfiguredDatabaseNames(requestedNames, config)

  return databaseNames.map(baseName => {
    const names = databaseProfiles.resolveDatabasePair(baseName, config.SOURCE_ENV, config.TARGET_ENV)
    const sourceEnvironment = buildDatabaseEnvironment(baseName, 'source', environment, config)
    const targetEnvironment = buildDatabaseEnvironment(baseName, 'target', environment, config)
    const transferEnvironment = { ...sourceEnvironment, ...targetEnvironment }
    const target = archiveTool.getTargetProfile(targetEnvironment, {
      serviceName: baseName,
      database: names.sourceDatabase
    })

    return {
      baseName,
      sourceDatabase: names.sourceDatabase,
      targetDatabase: names.targetDatabase,
      environment: transferEnvironment,
      target,
      confirmation: getTargetConfirmation(target)
    }
  })
}

function getTargetSetConfirmation (plan, operation = 'archive') {
  const setIdentity = plan
    .map(entry => `${operation}:${entry.baseName}:${entry.sourceDatabase || ''}=${entry.confirmation}:${entry.archiveSha256 || ''}`)
    .join('\n')
  return crypto.createHash('sha256').update(setIdentity).digest('hex').slice(0, 16)
}

async function dryRunDatabaseRestoreSet (plan, options = {}, dependencies = {}) {
  const restoreArchive = dependencies.restoreDatabaseArchive || archiveTool.restoreDatabaseArchive
  const results = []
  for (const entry of plan) {
    results.push(await restoreArchive({
      archive: entry.archivePath,
      environment: entry.environment,
      dryRun: true
    }))
  }

  const confirmation = getTargetSetConfirmation(plan)
  console.log('\nDatabase restore-set dry run passed. Targets:')
  for (const entry of plan) console.log(`  ${entry.baseName}: ${entry.confirmation}`)
  console.log(`Live restore requires --wipe --confirm-target-set ${confirmation}`)
  return { dryRun: true, confirmation, targets: plan.map(entry => entry.confirmation), results }
}

async function dryRunDatabaseStreamSet (plan, dependencies = {}) {
  const prepareStream = dependencies.prepareDatabaseStreamRestore || archiveTool.prepareDatabaseStreamRestore
  const results = []
  for (const entry of plan) {
    results.push(await prepareStream({ environment: entry.environment, dryRun: true }))
  }

  const confirmation = getTargetSetConfirmation(plan, 'stream')
  console.log('\nDatabase stream dry run passed. Targets:')
  for (const entry of plan) console.log(`  ${entry.baseName}: ${entry.sourceDatabase} -> ${entry.confirmation}`)
  console.log(`Live stream requires --wipe --confirm-target-set ${confirmation}`)
  return { dryRun: true, confirmation, targets: plan.map(entry => entry.confirmation), results }
}

async function rollbackCommittedDatabaseRestore (prepared) {
  const connection = prepared.maintenanceConnection
  const targetDatabase = prepared.target.database

  if (!prepared.previousDatabase) {
    await archiveTool.dropDatabaseIfExists(connection, targetDatabase)
    return
  }

  const failedDatabase = createTemporaryDatabaseName(targetDatabase, 'failed', getSetRunToken())
  if (await archiveTool.databaseExists(connection, failedDatabase)) {
    throw new Error(`Rollback database already exists: ${failedDatabase}`)
  }

  await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} WITH ALLOW_CONNECTIONS false`)
  await archiveTool.terminateDatabaseConnections(connection, targetDatabase)
  await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} RENAME TO ${quoteIdentifier(failedDatabase)}`)
  await connection.query(`ALTER DATABASE ${quoteIdentifier(prepared.previousDatabase)} RENAME TO ${quoteIdentifier(targetDatabase)}`)
  await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} WITH ALLOW_CONNECTIONS true`)
  await archiveTool.dropDatabaseIfExists(connection, failedDatabase)
}

async function restoreDatabaseBackupSet (options = {}, dependencies = {}) {
  const config = options.config || databaseRefresh
  const environment = options.environment || process.env
  const readSet = dependencies.readDatabaseBackupSet || readDatabaseBackupSet
  const backupSet = readSet(options.manifest, config)
  const plan = getRestorePlan(backupSet, { config, environment })
  const confirmation = getTargetSetConfirmation(plan)

  if (options.dryRun) return dryRunDatabaseRestoreSet(plan, options, dependencies)
  if (options.wipe !== true) throw new Error('A live set restore requires --wipe')
  if (options.confirmTargetSet !== confirmation) {
    throw new Error(`--confirm-target-set must exactly match the dry-run token: ${confirmation}`)
  }

  const prepareArchive = dependencies.prepareDatabaseArchiveRestore || archiveTool.prepareDatabaseArchiveRestore
  const commitArchive = dependencies.commitPreparedDatabaseRestore || archiveTool.commitPreparedDatabaseRestore
  const cleanupArchive = dependencies.cleanupPreparedDatabaseRestore || archiveTool.cleanupPreparedDatabaseRestore
  const rollbackArchive = dependencies.rollbackPreparedDatabaseRestore || rollbackCommittedDatabaseRestore
  const prepared = []
  const committed = []

  try {
    for (const entry of plan) {
      console.log(`\n=== Staging ${entry.baseName} for ${entry.confirmation} ===`)
      const database = await prepareArchive({
        archive: entry.archivePath,
        environment: entry.environment,
        wipe: true,
        confirmTarget: entry.confirmation
      })
      database.baseName = entry.baseName
      prepared.push(database)
    }

    console.log('\nAll databases passed staging validation. Starting cutover.')
    try {
      for (const database of prepared) {
        const result = await commitArchive(database)
        database.previousDatabase = result.previousDatabase
        committed.push(database)
      }
    } catch (error) {
      const rollbackErrors = []
      for (const database of committed.reverse()) {
        try {
          await rollbackArchive(database)
        } catch (rollbackError) {
          rollbackErrors.push(`${database.baseName}: ${rollbackError.message}`)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`Database-set cutover failed: ${error.message}; rollback failures: ${rollbackErrors.join('; ')}`)
      }
      throw new Error(`Database-set cutover failed and completed cutovers were rolled back: ${error.message}`)
    }

    return {
      manifest: backupSet.manifestPath,
      targetEnvironment: config.TARGET_ENV,
      databases: prepared.map(database => ({
        baseName: database.baseName,
        target: database.confirmation,
        previousDatabase: database.previousDatabase || null
      }))
    }
  } finally {
    for (const database of prepared) await cleanupArchive(database)
  }
}

async function streamDatabaseRefreshSet (options = {}, dependencies = {}) {
  const config = options.config || databaseRefresh
  const environment = options.environment || process.env
  const plan = getStreamRestorePlan(options.databaseNames || [], { config, environment })
  const confirmation = getTargetSetConfirmation(plan, 'stream')

  if (options.dryRun) return dryRunDatabaseStreamSet(plan, dependencies)
  if (options.wipe !== true) throw new Error('A live stream requires --wipe')
  if (options.confirmTargetSet !== confirmation) {
    throw new Error(`--confirm-target-set must exactly match the stream dry-run token: ${confirmation}`)
  }

  const prepareStream = dependencies.prepareDatabaseStreamRestore || archiveTool.prepareDatabaseStreamRestore
  const commitStream = dependencies.commitPreparedDatabaseRestore || archiveTool.commitPreparedDatabaseRestore
  const cleanupStream = dependencies.cleanupPreparedDatabaseRestore || archiveTool.cleanupPreparedDatabaseRestore
  const rollbackStream = dependencies.rollbackPreparedDatabaseRestore || rollbackCommittedDatabaseRestore
  const prepared = []
  const committed = []

  try {
    for (const entry of plan) {
      console.log(`\n=== Streaming ${entry.sourceDatabase} to ${entry.confirmation} ===`)
      const database = await prepareStream({
        environment: entry.environment,
        wipe: true,
        confirmTarget: entry.confirmation
      })
      database.baseName = entry.baseName
      prepared.push(database)
    }

    console.log('\nAll streamed databases passed staging validation. Starting cutover.')
    try {
      for (const database of prepared) {
        const result = await commitStream(database)
        database.previousDatabase = result.previousDatabase
        committed.push(database)
      }
    } catch (error) {
      const rollbackErrors = []
      for (const database of committed.reverse()) {
        try {
          await rollbackStream(database)
        } catch (rollbackError) {
          rollbackErrors.push(`${database.baseName}: ${rollbackError.message}`)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`Stream-set cutover failed: ${error.message}; rollback failures: ${rollbackErrors.join('; ')}`)
      }
      throw new Error(`Stream-set cutover failed and completed cutovers were rolled back: ${error.message}`)
    }

    return {
      sourceEnvironment: config.SOURCE_ENV,
      targetEnvironment: config.TARGET_ENV,
      databases: prepared.map(database => ({
        baseName: database.baseName,
        sourceDatabase: database.sourceDatabase,
        target: database.confirmation,
        streamedArchiveSha256: database.streamedArchiveSha256,
        previousDatabase: database.previousDatabase || null
      }))
    }
  } finally {
    for (const database of prepared) await cleanupStream(database)
  }
}

async function main (argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }

  const result = options.action === 'backup'
    ? await createDatabaseBackupSet(options)
    : options.action === 'restore'
      ? await restoreDatabaseBackupSet(options)
      : await streamDatabaseRefreshSet(options)
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Database set ${process.argv[2] || 'operation'} failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  SET_FORMAT,
  SET_VERSION,
  parseArgs,
  usage,
  getConfiguredDatabaseNames,
  buildDatabaseEnvironment,
  createDatabaseBackupSet,
  readDatabaseBackupSet,
  getRestorePlan,
  getStreamRestorePlan,
  getTargetSetConfirmation,
  dryRunDatabaseRestoreSet,
  dryRunDatabaseStreamSet,
  rollbackCommittedDatabaseRestore,
  restoreDatabaseBackupSet,
  streamDatabaseRefreshSet,
  main
}
