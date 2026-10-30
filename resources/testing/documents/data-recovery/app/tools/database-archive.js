#!/usr/bin/env node

const crypto = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Transform, pipeline } = require('stream')
const { promisify } = require('util')
const { buildSourceConfig } = require('../database/source-database-connection')
const { createPostgresConnection } = require('../database/postgres-connection')
const { resolveTargetProfile } = require('../config/database-profiles')
const {
  getPgSslMode,
  buildConnectionArgs,
  buildToolEnvironment,
  parsePgMajorVersion,
  quoteIdentifier,
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
  runPgTool,
  getPgToolVersion,
  hashFile,
  hashSchemaDumpFile,
  findFirstSchemaDumpDifference
} = require('../services/database-archive-service')

const ARCHIVE_FORMAT = 'ffc-pay-database-archive'
const ARCHIVE_VERSION = 1
const TARGET_APP_ROLES_ENV = 'RECOVERY_TARGET_APP_ROLES'
const pipelineAsync = promisify(pipeline)

function parseArgs (argv = process.argv.slice(2)) {
  const [action, ...rest] = argv
  const options = { action, dryRun: false, wipe: false, confirmTarget: null, output: null, archive: null, help: false }

  if (!action || action === '--help' || action === '-h') {
    options.help = true
    return options
  }
  if (!['backup', 'restore'].includes(action)) {
    throw new Error(`Unknown action "${action}". Choose backup or restore.`)
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--output') {
      options.output = rest[++i]
      if (!options.output) throw new Error('--output requires a file path')
    } else if (arg === '--archive') {
      options.archive = rest[++i]
      if (!options.archive) throw new Error('--archive requires a file path')
    } else if (arg === '--confirm-target') {
      options.confirmTarget = rest[++i]
      if (!options.confirmTarget) throw new Error('--confirm-target requires the configured target endpoint')
    } else if (arg === '--wipe') {
      options.wipe = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option "${arg}"`)
    }
  }

  if (options.help) return options
  if (action === 'backup' && options.archive) throw new Error('Use --output with backup, not --archive')
  if (action === 'restore' && options.output) throw new Error('Use --archive with restore, not --output')
  if (action === 'restore' && !options.archive) throw new Error('Restore requires --archive <file>')
  if (action === 'backup' && options.wipe) throw new Error('--wipe is only valid with restore')
  if (options.dryRun && action === 'backup') throw new Error('--dry-run is only valid with restore')

  return options
}

function usage () {
  return [
    'Usage:',
    '  npm run database:backup -- [--output <archive.dump>]',
    '  npm run database:restore -- --archive <archive.dump> --wipe --confirm-target <host:port/database> [--dry-run]',
    '',
    'The source and target are selected through RECOVERY_SOURCE_* and RECOVERY_TARGET_* environment variables.'
  ].join('\n')
}

function getSourceProfile (environment) {
  const serviceName = environment.RECOVERY_SERVICE_NAME?.trim() || null
  const source = buildSourceConfig({ serviceName, environment })
  return { serviceName, source }
}

function getTargetProfile (environment, archiveSource) {
  const serviceName = environment.RECOVERY_SERVICE_NAME?.trim() || archiveSource.serviceName
  return resolveTargetProfile(serviceName, environment).config
}

function getToolVersions () {
  const pgDump = getPgToolVersion('pg_dump')
  const pgRestore = getPgToolVersion('pg_restore')
  return {
    pgDump,
    pgDumpMajor: parsePgMajorVersion(pgDump),
    pgRestore,
    pgRestoreMajor: parsePgMajorVersion(pgRestore)
  }
}

function getConnectionEnvironment (config, environment, side) {
  return buildToolEnvironment(config, getPgSslMode(config, environment, side), environment)
}

function getTimestampToken () {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${timestamp}_${crypto.randomBytes(4).toString('hex')}`
}

function getSafeFilePart (value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function getDefaultArchivePath (databaseName) {
  return path.resolve(__dirname, '../..', 'dumps', `${getSafeFilePart(databaseName)}-${getTimestampToken()}.dump`)
}

function assertFreshDatabaseSnapshot (metadata) {
  if (!['libc', 'icu'].includes(metadata.localeProvider)) {
    throw new Error(`Database locale provider "${metadata.localeProvider}" is not supported for automatic restore`)
  }
  if (metadata.collationVersion && metadata.actualCollationVersion && metadata.collationVersion !== metadata.actualCollationVersion) {
    throw new Error(`Source database collation version is stale (${metadata.collationVersion} != ${metadata.actualCollationVersion}); refresh its indexes before backup`)
  }
}

async function exportSourceSnapshot (client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const { rows } = await client.query('SELECT pg_export_snapshot() AS snapshot_id')
  return rows[0].snapshot_id
}

function buildDumpArgs (databaseConfig, snapshotId, outputPath, schemaOnly = false) {
  const args = [
    ...buildConnectionArgs(databaseConfig),
    '--no-owner',
    '--no-privileges',
    '--no-tablespaces'
  ]
  if (!schemaOnly) args.push('--verbose')
  args.push('--file', outputPath)
  if (snapshotId) args.push('--snapshot', snapshotId)

  if (schemaOnly) {
    args.push('--schema-only', '--format=plain', '--quote-all-identifiers')
  } else {
    args.push('--format=custom')
  }

  return args
}

function buildDumpStreamArgs (databaseConfig, snapshotId) {
  return [
    ...buildConnectionArgs(databaseConfig),
    '--no-owner',
    '--no-privileges',
    '--no-tablespaces',
    '--verbose',
    '--format=custom',
    '--snapshot', snapshotId
  ]
}

function waitForSuccessfulExit (child, command) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`))
      }
    })
  })
}

async function streamPgDumpToRestore (sourceConfig, stagingConfig, snapshotId, environment) {
  const dump = spawn('pg_dump', buildDumpStreamArgs(sourceConfig, snapshotId), {
    env: getConnectionEnvironment(sourceConfig, environment, 'source'),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const restoreArgs = [
    ...buildConnectionArgs(stagingConfig),
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    '--no-tablespaces',
    '--verbose'
  ]
  const restore = spawn('pg_restore', restoreArgs, {
    env: getConnectionEnvironment(stagingConfig, environment, 'target'),
    stdio: ['pipe', 'ignore', 'pipe']
  })

  dump.stderr.on('data', chunk => process.stderr.write(`[pg_dump] ${chunk.toString()}`))
  restore.stderr.on('data', chunk => process.stderr.write(`[pg_restore] ${chunk.toString()}`))

  const archiveHash = crypto.createHash('sha256')
  const hashStream = new Transform({
    transform (chunk, encoding, callback) {
      archiveHash.update(chunk)
      callback(null, chunk)
    }
  })
  const dumpExit = waitForSuccessfulExit(dump, 'pg_dump')
  const restoreExit = waitForSuccessfulExit(restore, 'pg_restore')
  const transfer = pipelineAsync(dump.stdout, hashStream, restore.stdin)

  try {
    await Promise.all([transfer, dumpExit, restoreExit])
    return archiveHash.digest('hex')
  } catch (error) {
    if (dump.exitCode === null && !dump.killed) dump.kill('SIGTERM')
    if (restore.exitCode === null && !restore.killed) restore.kill('SIGTERM')
    await Promise.allSettled([transfer, dumpExit, restoreExit])
    throw error
  }
}

function runSchemaDump (databaseConfig, snapshotId, outputPath, environment, side) {
  runPgTool('pg_dump', buildDumpArgs(databaseConfig, snapshotId, outputPath, true), {
    environment: getConnectionEnvironment(databaseConfig, environment, side)
  })
}

function publishFileWithoutOverwrite (temporaryPath, finalPath) {
  fs.linkSync(temporaryPath, finalPath)
  fs.unlinkSync(temporaryPath)
}

async function collectSourceSnapshot (connection, sourceConfig, environment, versions, temporaryDirectory) {
  const client = await connection.pool.connect()
  let transactionOpen = false

  try {
    const snapshotId = await exportSourceSnapshot(client)
    transactionOpen = true
    const metadata = await readDatabaseMetadata(client)
    assertFreshDatabaseSnapshot(metadata)

    if (versions.pgDumpMajor < metadata.serverMajor) {
      throw new Error(`pg_dump ${versions.pgDumpMajor} cannot dump PostgreSQL ${metadata.serverMajor}`)
    }

    const inventory = await getDatabaseInventory(client)
    const foreignTables = inventory.filter(relation => relation.kind === 'f')
    if (foreignTables.length > 0) {
      const names = foreignTables.slice(0, 10).map(relation => `${relation.schema}.${relation.name}`).join(', ')
      throw new Error(`Database contains foreign tables whose external data is not included in PostgreSQL backups: ${names}`)
    }

    console.log(`Counting rows in ${inventory.filter(relation => ['r', 'm'].includes(relation.kind)).length} table(s) against the exported source snapshot...`)
    const rowCounts = await getExactDataCounts(client, inventory)
    const extensions = await getDatabaseExtensions(client)
    const schemaPath = path.join(temporaryDirectory, 'source-schema.sql')
    runSchemaDump(sourceConfig, snapshotId, schemaPath, environment, 'source')
    const schemaSha256 = await hashSchemaDumpFile(schemaPath)

    return { client, snapshotId, metadata, inventory, rowCounts, extensions, schemaSha256, schemaPath }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
    client.release()
    throw error
  }
}

async function createDatabaseArchive (options = {}) {
  const environment = options.environment || process.env
  const { serviceName, source } = getSourceProfile(environment)
  const versions = getToolVersions()
  const connection = await createPostgresConnection(source, { connectionName: 'source database' })
  let snapshot
  let temporaryDirectory
  let outputPath
  let manifestPath
  let archivePublished = false
  let manifestPublished = false
  let archiveSucceeded = false

  try {
    outputPath = path.resolve(options.output || getDefaultArchivePath(connection.database))
    manifestPath = `${outputPath}.json`
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    if (fs.existsSync(outputPath) || fs.existsSync(manifestPath)) {
      throw new Error(`Archive output already exists: ${outputPath}`)
    }
    temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(outputPath), '.database-archive-'))
    fs.chmodSync(temporaryDirectory, 0o700)

    snapshot = await collectSourceSnapshot(connection, source, environment, versions, temporaryDirectory)
    const archiveTemporaryPath = path.join(temporaryDirectory, path.basename(outputPath))
    runPgTool('pg_dump', buildDumpArgs(source, snapshot.snapshotId, archiveTemporaryPath), {
      environment: getConnectionEnvironment(source, environment, 'source')
    })
    fs.chmodSync(archiveTemporaryPath, 0o600)

    runPgTool('pg_restore', ['--list', archiveTemporaryPath], {
      environment: getConnectionEnvironment(source, environment, 'source'),
      stdio: ['ignore', 'ignore', 'inherit']
    })

    const manifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      createdAt: new Date().toISOString(),
      archive: path.basename(outputPath),
      sha256: await hashFile(archiveTemporaryPath),
      source: {
        database: snapshot.metadata.database,
        serviceName: environment.RECOVERY_SERVICE_NAME?.trim() || null,
        host: source.host,
        port: Number(source.port),
        serverAddress: snapshot.metadata.serverAddress,
        serverPort: snapshot.metadata.serverPort,
        serverVersion: snapshot.metadata.serverVersion,
        serverVersionNum: snapshot.metadata.serverVersionNum,
        serverMajor: snapshot.metadata.serverMajor,
        encoding: snapshot.metadata.encoding,
        collation: snapshot.metadata.collation,
        ctype: snapshot.metadata.ctype,
        localeProvider: snapshot.metadata.localeProvider,
        icuLocale: snapshot.metadata.icuLocale,
        collationVersion: snapshot.metadata.collationVersion,
        actualCollationVersion: snapshot.metadata.actualCollationVersion
      },
      client: versions,
      verification: {
        schemaSha256: snapshot.schemaSha256,
        inventory: snapshot.inventory,
        rowCounts: snapshot.rowCounts,
        extensions: snapshot.extensions
      }
    }

    const manifestTemporaryPath = path.join(temporaryDirectory, `${path.basename(outputPath)}.json`)
    const manifestDescriptor = fs.openSync(manifestTemporaryPath, 'wx', 0o600)
    fs.writeFileSync(manifestDescriptor, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.closeSync(manifestDescriptor)

    publishFileWithoutOverwrite(archiveTemporaryPath, outputPath)
    archivePublished = true
    publishFileWithoutOverwrite(manifestTemporaryPath, manifestPath)
    manifestPublished = true
    archiveSucceeded = true

    console.log(`Database archive created: ${outputPath}`)
    console.log(`Archive SHA-256: ${manifest.sha256}`)
    console.log(`Verified ${snapshot.inventory.length} relations and ${snapshot.rowCounts.length - 1} row counts from one source snapshot.`)
    console.log(`Source database: ${snapshot.metadata.database} (PostgreSQL ${snapshot.metadata.serverMajor})`)
    console.log(`Service profile: ${serviceName}`)
    return { archive: outputPath, manifest: manifestPath, sourceDatabase: snapshot.metadata.database }
  } catch (error) {
    if (archivePublished) fs.rmSync(outputPath, { force: true })
    if (manifestPublished) fs.rmSync(manifestPath, { force: true })
    throw error
  } finally {
    if (snapshot?.client) {
      await snapshot.client.query(archiveSucceeded ? 'COMMIT' : 'ROLLBACK').catch(() => {})
      snapshot.client.release()
    }
    await connection.close()
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function readArchiveManifest (archivePath) {
  const manifestPath = `${archivePath}.json`
  if (!fs.existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`)
  if (!fs.existsSync(manifestPath)) throw new Error(`Archive metadata not found: ${manifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read archive metadata: ${error.message}`)
  }

  if (manifest.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION) {
    throw new Error(`Unsupported archive format or version in ${manifestPath}`)
  }
  if (manifest.archive !== path.basename(archivePath)) {
    throw new Error('Archive filename does not match its metadata')
  }
  if (!manifest.source?.database || !manifest.source?.serverMajor || !manifest.client?.pgDumpMajor || !manifest.verification?.schemaSha256) {
    throw new Error('Archive metadata is incomplete')
  }

  return { manifest, manifestPath }
}

async function validateArchiveFile (archivePath, manifest, versions, environment, target) {
  const actualChecksum = await hashFile(archivePath)
  if (actualChecksum !== manifest.sha256) {
    throw new Error('Archive SHA-256 does not match its metadata; the archive may be incomplete or modified')
  }

  runPgTool('pg_restore', ['--list', archivePath], {
    environment: getConnectionEnvironment(target, environment, 'target'),
    stdio: ['ignore', 'ignore', 'inherit']
  })

  if (versions.pgRestoreMajor < manifest.client.pgDumpMajor) {
    throw new Error(`pg_restore ${versions.pgRestoreMajor} is older than the archive client ${manifest.client.pgDumpMajor}`)
  }
}

async function databaseExists (connection, databaseName) {
  const { rows } = await connection.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  return rows.length > 0
}

async function validateAvailableExtensions (connection, extensions, options = {}) {
  if (extensions.length === 0) return
  const names = extensions.map(extension => extension.name)
  const requireExactVersions = options.requireExactVersions === true
  const query = requireExactVersions
    ? 'SELECT name, version FROM pg_available_extension_versions WHERE name = ANY($1::text[])'
    : 'SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])'
  const { rows } = await connection.query(query, [names])
  const available = new Set(requireExactVersions
    ? rows.map(row => `${row.name}:${row.version}`)
    : rows.map(row => row.name))
  const missing = extensions.filter(extension => requireExactVersions
    ? !available.has(`${extension.name}:${extension.version}`)
    : !available.has(extension.name))
  if (missing.length > 0) {
    const requirement = requireExactVersions ? 'exact extension versions' : 'extensions'
    throw new Error(`Target PostgreSQL is missing required ${requirement}: ${missing.map(extension => `${extension.name} ${extension.version}`).join(', ')}`)
  }
}

function normalizeInventory (inventory) {
  return inventory.map(({ schema, name, kind }) => ({ schema, name, kind }))
}

async function validateRestoredDatabase (targetConfig, stagingDatabase, manifest, environment, temporaryDirectory, options = {}) {
  const stagingConfig = { ...targetConfig, database: stagingDatabase }
  const connection = await createPostgresConnection(stagingConfig, { connectionName: 'staging database' })

  try {
    const metadata = await readDatabaseMetadata(connection)
    assertFreshDatabaseSnapshot(metadata)
    const localeComparison = compareDatabaseLocales(manifest.source, metadata)
    if (!localeComparison.compatible) {
      throw new Error(`Staging database locale or encoding differs from the source archive (${localeComparison.differences.join('; ')})`)
    }
    if (localeComparison.collationVersionDiffers) {
      console.warn(`Source and target collation library versions differ (${manifest.source.actualCollationVersion} vs ${metadata.actualCollationVersion}); indexes were rebuilt using the target version. Verify collation-sensitive behavior before cutover.`)
    }

    const inventory = await getDatabaseInventory(connection)
    if (JSON.stringify(normalizeInventory(inventory)) !== JSON.stringify(normalizeInventory(manifest.verification.inventory))) {
      throw new Error('Staging database relation inventory does not match the source archive')
    }

    const rowCounts = await getExactDataCounts(connection, inventory)
    if (JSON.stringify(rowCounts) !== JSON.stringify(manifest.verification.rowCounts)) {
      throw new Error('Staging database exact row counts do not match the source archive')
    }

    const extensions = await getDatabaseExtensions(connection)
    const extensionComparison = compareDatabaseExtensions(manifest.verification.extensions, extensions)
    if (!extensionComparison.compatible) {
      throw new Error(`Staging database extension set differs from the source archive (${extensionComparison.differences.join('; ')})`)
    }
    if (extensionComparison.versionDifferences.length > 0) {
      const differences = extensionComparison.versionDifferences.join('; ')
      if (environment.RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS === 'true') {
        throw new Error(`Staging extension versions differ from the source archive (${differences})`)
      }
      console.warn(`Source and target extension versions differ; target versions were restored (${differences}). Verify extension behavior before cutover. Set RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS=true to reject version differences.`)
    }

    const schemaPath = path.join(temporaryDirectory, 'staging-schema.sql')
    runSchemaDump(stagingConfig, null, schemaPath, environment, 'target')
    const schemaSha256 = await hashSchemaDumpFile(schemaPath)
    if (schemaSha256 !== manifest.verification.schemaSha256) {
      const difference = options.sourceSchemaPath
        ? findFirstSchemaDumpDifference(options.sourceSchemaPath, schemaPath)
        : null
      const details = difference
        ? ` First differing normalized schema line ${difference.line}: source=${JSON.stringify(difference.source)}, staging=${JSON.stringify(difference.target)}`
        : ''
      fs.unlinkSync(schemaPath)
      throw new Error(`Staging database schema fingerprint does not match the source archive (source=${manifest.verification.schemaSha256}, staging=${schemaSha256}).${details}`)
    }
    fs.unlinkSync(schemaPath)

    return {
      relationCount: inventory.length,
      rowCount: rowCounts.length - 1,
      extensionCount: extensions.length,
      schemaSha256,
      collationVersionDiffers: localeComparison.collationVersionDiffers
    }
  } finally {
    await connection.close()
  }
}

function getTargetAppRoles (environment) {
  const value = environment[TARGET_APP_ROLES_ENV]
  if (!value?.trim()) return []
  return [...new Set(value.split(',').map(role => role.trim()).filter(Boolean))]
}

async function applyTargetAppRoles (connection, databaseName, owner, environment) {
  const roles = getTargetAppRoles(environment)
  if (roles.length === 0) return []

  const { rows: roleRows } = await connection.query(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
    [roles]
  )
  const foundRoles = new Set(roleRows.map(row => row.rolname))
  const missingRoles = roles.filter(role => !foundRoles.has(role))
  if (missingRoles.length > 0) {
    throw new Error(`Target application roles do not exist: ${missingRoles.join(', ')}`)
  }

  const { rows: schemaRows } = await connection.query(`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
    ORDER BY nspname
  `)

  for (const role of roles) {
    const quotedRole = quoteIdentifier(role)
    await connection.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quotedRole}`)
    for (const row of schemaRows) {
      const schema = quoteIdentifier(row.schema_name)
      await connection.query(`GRANT USAGE ON SCHEMA ${schema} TO ${quotedRole}`)
      await connection.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${quotedRole}`)
      await connection.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${quotedRole}`)
      await connection.query(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${schema} TO ${quotedRole}`)
      await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)} IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${quotedRole}`)
      await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quotedRole}`)
      await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(owner)} IN SCHEMA ${schema} GRANT EXECUTE ON ROUTINES TO ${quotedRole}`)
    }
  }
  return roles
}

async function terminateDatabaseConnections (connection, databaseName) {
  await connection.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [databaseName]
  )
}

async function replaceTargetDatabase (connection, targetDatabase, stagingDatabase, backupDatabase) {
  const lockName = `database-archive:${targetDatabase}`
  await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName])

  let targetDisabled = false
  let oldTargetRenamed = false
  let stagingRenamed = false

  try {
    const targetExists = await databaseExists(connection, targetDatabase)
    if (targetExists) {
      await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} WITH ALLOW_CONNECTIONS false`)
      targetDisabled = true
      await terminateDatabaseConnections(connection, targetDatabase)
      await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} RENAME TO ${quoteIdentifier(backupDatabase)}`)
      oldTargetRenamed = true
    }

    await connection.query(`ALTER DATABASE ${quoteIdentifier(stagingDatabase)} RENAME TO ${quoteIdentifier(targetDatabase)}`)
    stagingRenamed = true
    return targetExists ? backupDatabase : null
  } catch (error) {
    const rollbackErrors = []
    if (stagingRenamed) {
      try {
        await terminateDatabaseConnections(connection, targetDatabase)
        await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} RENAME TO ${quoteIdentifier(stagingDatabase)}`)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message)
      }
    }
    if (oldTargetRenamed) {
      try {
        await connection.query(`ALTER DATABASE ${quoteIdentifier(backupDatabase)} RENAME TO ${quoteIdentifier(targetDatabase)}`)
        await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} WITH ALLOW_CONNECTIONS true`)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message)
      }
    } else if (targetDisabled) {
      await connection.query(`ALTER DATABASE ${quoteIdentifier(targetDatabase)} WITH ALLOW_CONNECTIONS true`).catch(rollbackError => rollbackErrors.push(rollbackError.message))
    }

    if (rollbackErrors.length > 0) {
      throw new Error(`Target cutover failed: ${error.message}; rollback also failed: ${rollbackErrors.join('; ')}`)
    }
    throw error
  } finally {
    await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => {})
  }
}

async function dropDatabaseIfExists (connection, databaseName) {
  if (!await databaseExists(connection, databaseName)) return
  await terminateDatabaseConnections(connection, databaseName)
  await connection.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`)
}

async function prepareDatabaseArchiveRestore (options = {}) {
  const environment = options.environment || process.env
  const archivePath = path.resolve(options.archive)
  const { manifest } = readArchiveManifest(archivePath)
  const target = getTargetProfile(environment, manifest.source)
  const versions = getToolVersions()
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ffc-pay-database-restore-'))
  const maintenanceDatabase = environment.RECOVERY_TARGET_ADMIN_DATABASE?.trim() || 'postgres'
  const maintenanceConfig = { ...target, database: maintenanceDatabase }
  let maintenanceConnection
  let stagingDatabase
  let stageCreated = false
  let handedOff = false

  try {
    await validateArchiveFile(archivePath, manifest, versions, environment, target)
    maintenanceConnection = await createPostgresConnection(maintenanceConfig, { connectionName: 'target maintenance database' })
    const targetServer = await readDatabaseMetadata(maintenanceConnection)
    assertRestoreCompatibility({
      sourceMajor: manifest.source.serverMajor,
      pgDumpMajor: versions.pgDumpMajor,
      pgRestoreMajor: versions.pgRestoreMajor,
      archiveDumpMajor: manifest.client.pgDumpMajor,
      targetMajor: targetServer.serverMajor
    })

    const targetIdentity = {
      database: target.database,
      serverAddress: targetServer.serverAddress,
      serverPort: targetServer.serverPort
    }
    const sourceIdentity = {
      database: manifest.source.database,
      serverAddress: manifest.source.serverAddress,
      serverPort: manifest.source.serverPort
    }
    if (isSameDatabase(sourceIdentity, targetIdentity, { host: manifest.source.host, port: manifest.source.port }, target)) {
      throw new Error('Source and target resolve to the same PostgreSQL database; refusing to restore')
    }

    const confirmation = getTargetConfirmation(target)
    await validateAvailableExtensions(maintenanceConnection, manifest.verification.extensions, {
      requireExactVersions: environment.RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS === 'true'
    })
    if (options.dryRun) {
      console.log(`[DRY RUN] Archive checksum and TOC are valid: ${archivePath}`)
      console.log(`[DRY RUN] Source database: ${manifest.source.database} on PostgreSQL ${manifest.source.serverMajor}`)
      console.log(`[DRY RUN] Target database: ${confirmation} on PostgreSQL ${targetServer.serverMajor}`)
      console.log(`[DRY RUN] A live restore requires --wipe --confirm-target '${confirmation}'`)
      return { dryRun: true, target: confirmation }
    }

    assertRestoreConfirmation(target, options)
    const token = getTimestampToken()
    stagingDatabase = createTemporaryDatabaseName(target.database, 'restore', token)
    const backupDatabase = createTemporaryDatabaseName(target.database, 'previous', token)
    if (await databaseExists(maintenanceConnection, stagingDatabase) || await databaseExists(maintenanceConnection, backupDatabase)) {
      throw new Error('Generated staging or backup database name already exists; retry the restore')
    }

    const createDatabaseSql = buildCreateDatabaseSql(stagingDatabase, manifest.source, targetServer.serverMajor, target.user)
    await maintenanceConnection.query(createDatabaseSql)
    stageCreated = true

    const stagingConfig = { ...target, database: stagingDatabase }
    const restoreArgs = [
      ...buildConnectionArgs(stagingConfig),
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--no-tablespaces',
      '--verbose',
      archivePath
    ]
    runPgTool('pg_restore', restoreArgs, {
      environment: getConnectionEnvironment(stagingConfig, environment, 'target')
    })

    const validation = await validateRestoredDatabase(target, stagingDatabase, manifest, environment, temporaryDirectory)
    console.log(`Staging validation passed: ${validation.relationCount} relations, ${validation.rowCount} exact row counts, ${validation.extensionCount} extensions.`)

    const stagingRoleConnection = await createPostgresConnection(stagingConfig, { connectionName: 'staging role setup' })
    let grantedRoles
    try {
      grantedRoles = await applyTargetAppRoles(stagingRoleConnection, stagingDatabase, target.user, environment)
    } finally {
      await stagingRoleConnection.close()
    }
    if (grantedRoles.length > 0) console.log(`Granted target application roles: ${grantedRoles.join(', ')}`)

    handedOff = true
    return {
      prepared: true,
      archivePath,
      target,
      confirmation,
      stagingDatabase,
      backupDatabase,
      maintenanceConnection,
      temporaryDirectory,
      validation,
      stageCreated
    }
  } finally {
    if (!handedOff) {
      if (stageCreated && stagingDatabase) {
        await dropDatabaseIfExists(maintenanceConnection, stagingDatabase).catch(error => {
          console.error(`Could not remove incomplete staging database ${stagingDatabase}: ${error.message}`)
        })
      }
      if (maintenanceConnection) await maintenanceConnection.close()
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

async function commitPreparedDatabaseRestore (prepared) {
  const previousDatabase = await replaceTargetDatabase(
    prepared.maintenanceConnection,
    prepared.target.database,
    prepared.stagingDatabase,
    prepared.backupDatabase
  )
  prepared.stageCreated = false
  console.log(`Database refresh complete: ${prepared.target.database}`)
  if (previousDatabase) console.log(`Previous target kept offline for rollback as: ${previousDatabase}`)
  if (prepared.archivePath) {
    console.log(`Source archive: ${prepared.archivePath}`)
  } else {
    console.log(`Streamed source database: ${prepared.sourceDatabase}`)
    console.log(`Stream SHA-256: ${prepared.streamedArchiveSha256}`)
  }
  console.log(`Target endpoint: ${prepared.confirmation}`)
  return {
    target: prepared.confirmation,
    previousDatabase,
    validation: prepared.validation
  }
}

async function cleanupPreparedDatabaseRestore (prepared) {
  if (prepared.stageCreated && prepared.stagingDatabase) {
    await dropDatabaseIfExists(prepared.maintenanceConnection, prepared.stagingDatabase).catch(error => {
      console.error(`Could not remove incomplete staging database ${prepared.stagingDatabase}: ${error.message}`)
    })
    prepared.stageCreated = false
  }
  if (prepared.maintenanceConnection) {
    await prepared.maintenanceConnection.close()
    prepared.maintenanceConnection = null
  }
  fs.rmSync(prepared.temporaryDirectory, { recursive: true, force: true })
}

async function prepareDatabaseStreamRestore (options = {}) {
  const environment = options.environment || process.env
  const { serviceName, source } = getSourceProfile(environment)
  const target = getTargetProfile(environment, { serviceName, database: source.database })
  const versions = getToolVersions()
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ffc-pay-database-stream-'))
  const maintenanceDatabase = environment.RECOVERY_TARGET_ADMIN_DATABASE?.trim() || 'postgres'
  const maintenanceConfig = { ...target, database: maintenanceDatabase }
  let sourceConnection
  let snapshot
  let maintenanceConnection
  let stagingDatabase
  let stageCreated = false
  let handedOff = false

  try {
    sourceConnection = await createPostgresConnection(source, { connectionName: 'stream source database' })
    snapshot = await collectSourceSnapshot(sourceConnection, source, environment, versions, temporaryDirectory)
    maintenanceConnection = await createPostgresConnection(maintenanceConfig, { connectionName: 'stream target maintenance database' })
    const targetServer = await readDatabaseMetadata(maintenanceConnection)
    assertRestoreCompatibility({
      sourceMajor: snapshot.metadata.serverMajor,
      pgDumpMajor: versions.pgDumpMajor,
      pgRestoreMajor: versions.pgRestoreMajor,
      archiveDumpMajor: versions.pgDumpMajor,
      targetMajor: targetServer.serverMajor
    })

    const sourceIdentity = {
      database: snapshot.metadata.database,
      serverAddress: snapshot.metadata.serverAddress,
      serverPort: snapshot.metadata.serverPort
    }
    const targetIdentity = {
      database: target.database,
      serverAddress: targetServer.serverAddress,
      serverPort: targetServer.serverPort
    }
    if (isSameDatabase(sourceIdentity, targetIdentity, { host: source.host, port: source.port }, target)) {
      throw new Error('Source and target resolve to the same PostgreSQL database; refusing to stream')
    }

    await validateAvailableExtensions(maintenanceConnection, snapshot.extensions, {
      requireExactVersions: environment.RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS === 'true'
    })
    const confirmation = getTargetConfirmation(target)
    if (options.dryRun) {
      console.log(`[DRY RUN] Source is readable: ${snapshot.metadata.database} on PostgreSQL ${snapshot.metadata.serverMajor}`)
      console.log(`[DRY RUN] Target is compatible: ${confirmation} on PostgreSQL ${targetServer.serverMajor}`)
      console.log(`[DRY RUN] A live stream requires --wipe --confirm-target '${confirmation}'`)
      return { dryRun: true, sourceDatabase: snapshot.metadata.database, target: confirmation }
    }

    assertRestoreConfirmation(target, options)
    const token = getTimestampToken()
    stagingDatabase = createTemporaryDatabaseName(target.database, 'stream', token)
    const backupDatabase = createTemporaryDatabaseName(target.database, 'previous', token)
    if (await databaseExists(maintenanceConnection, stagingDatabase) || await databaseExists(maintenanceConnection, backupDatabase)) {
      throw new Error('Generated staging or backup database name already exists; retry the stream')
    }

    await maintenanceConnection.query(
      buildCreateDatabaseSql(stagingDatabase, snapshot.metadata, targetServer.serverMajor, target.user)
    )
    stageCreated = true

    const stagingConfig = { ...target, database: stagingDatabase }
    const streamedArchiveSha256 = await streamPgDumpToRestore(source, stagingConfig, snapshot.snapshotId, environment)
    const sourceSnapshot = snapshot
    await sourceSnapshot.client.query('COMMIT')
    sourceSnapshot.client.release()
    snapshot = null

    const streamManifest = {
      source: {
        ...sourceSnapshot.metadata,
        serviceName,
        host: source.host,
        port: Number(source.port)
      },
      verification: {
        schemaSha256: sourceSnapshot.schemaSha256,
        inventory: sourceSnapshot.inventory,
        rowCounts: sourceSnapshot.rowCounts,
        extensions: sourceSnapshot.extensions
      }
    }
    const validation = await validateRestoredDatabase(target, stagingDatabase, streamManifest, environment, temporaryDirectory, {
      sourceSchemaPath: sourceSnapshot.schemaPath
    })
    console.log(`Streaming stage validated: ${validation.relationCount} relations, ${validation.rowCount} exact row counts, ${validation.extensionCount} extensions.`)

    const stagingRoleConnection = await createPostgresConnection(stagingConfig, { connectionName: 'stream staging role setup' })
    let grantedRoles
    try {
      grantedRoles = await applyTargetAppRoles(stagingRoleConnection, stagingDatabase, target.user, environment)
    } finally {
      await stagingRoleConnection.close()
    }
    if (grantedRoles.length > 0) console.log(`Granted target application roles: ${grantedRoles.join(', ')}`)

    handedOff = true
    return {
      prepared: true,
      sourceDatabase: sourceSnapshot.metadata.database,
      archivePath: null,
      streamedArchiveSha256,
      target,
      confirmation,
      stagingDatabase,
      backupDatabase,
      maintenanceConnection,
      temporaryDirectory,
      validation,
      stageCreated
    }
  } finally {
    if (snapshot?.client) {
      await snapshot.client.query('ROLLBACK').catch(() => {})
      snapshot.client.release()
    }
    if (sourceConnection) await sourceConnection.close()
    if (!handedOff) {
      if (stageCreated && stagingDatabase) {
        await dropDatabaseIfExists(maintenanceConnection, stagingDatabase).catch(error => {
          console.error(`Could not remove incomplete stream staging database ${stagingDatabase}: ${error.message}`)
        })
      }
      if (maintenanceConnection) await maintenanceConnection.close()
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

async function restoreDatabaseArchive (options = {}) {
  const prepared = await prepareDatabaseArchiveRestore(options)
  if (prepared.dryRun) return prepared

  try {
    return await commitPreparedDatabaseRestore(prepared)
  } finally {
    await cleanupPreparedDatabaseRestore(prepared)
  }
}

async function main (argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }

  const result = options.action === 'backup'
    ? await createDatabaseArchive(options)
    : await restoreDatabaseArchive(options)
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Database ${process.argv[2] || 'archive'} failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  usage,
  buildDumpArgs,
  getSourceProfile,
  getTargetProfile,
  createDatabaseArchive,
  readArchiveManifest,
  validateAvailableExtensions,
  validateRestoredDatabase,
  applyTargetAppRoles,
  databaseExists,
  terminateDatabaseConnections,
  dropDatabaseIfExists,
  replaceTargetDatabase,
  prepareDatabaseArchiveRestore,
  prepareDatabaseStreamRestore,
  commitPreparedDatabaseRestore,
  cleanupPreparedDatabaseRestore,
  restoreDatabaseArchive,
  main
}
