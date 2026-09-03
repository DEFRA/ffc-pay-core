#!/usr/bin/env node

// Self-contained helper: copy every table in a source service database to a
// local PostgreSQL target. This script does NOT require app/config/local.js to
// be modified; it reads source credentials from DB_SOURCE_ENV / RECOVERY_DB_*
// (or POSTGRES_PRD_* as a fallback) and target credentials from LOCAL_POSTGRES_*.

const { spawn } = require('child_process')
const { createConnection } = require('../app/database/db-connection')
const { processService: applyManagedIdentityGrants } = require('../app/database/grant-managed-identity')
const streamPrdToPre = require('../app/database/stream-prd-to-pre')
// edit this port to change to the relevant service
const LOCAL_POSTGRES_SERVICE_PORT = 5440

function resolveLocalPostgresPort (explicitPort) {
  if (explicitPort) {
    return Number(explicitPort)
  }
  if (LOCAL_POSTGRES_SERVICE_PORT) {
    return LOCAL_POSTGRES_SERVICE_PORT
  }
  const envPort = process.env.LOCAL_POSTGRES_PORT
  if (envPort) {
    return Number(envPort)
  }
  return 5432
}

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    sourceDbName: null,
    targetDbName: null,
    sourceEnvironment: process.env.DB_SOURCE_ENV || 'recovery',
    targetHost: process.env.LOCAL_POSTGRES_HOST || '127.0.0.1',
    targetPort: resolveLocalPostgresPort(),
    targetAdmin: process.env.LOCAL_POSTGRES_ADMIN || 'postgres',
    targetPassword: process.env.LOCAL_POSTGRES_PASSWORD || 'ppp',
    targetSsl: false,
    continueOnError: false,
    skipGrants: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source-db') args.sourceDbName = argv[++i]
    else if (arg === '--target-db') args.targetDbName = argv[++i]
    else if (arg === '--source-environment') args.sourceEnvironment = argv[++i]
    else if (arg === '--target-host') args.targetHost = argv[++i]
    else if (arg === '--target-port') args.targetPort = Number(argv[++i])
    else if (arg === '--target-admin') args.targetAdmin = argv[++i]
    else if (arg === '--target-password') args.targetPassword = argv[++i]
    else if (arg === '--target-ssl') args.targetSsl = argv[++i] === 'true'
    else if (arg === '--continue-on-error') args.continueOnError = true
    else if (arg === '--skip-grants') args.skipGrants = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function connectToLocalTarget (args, databaseName) {
  return await createConnection(databaseName, {
    environment: 'local',
    host: args.targetHost,
    port: args.targetPort,
    username: args.targetAdmin,
    password: args.targetPassword,
    ssl: args.targetSsl
  })
}

async function listSourceTables (sourceConfig, sourceDbName, sourceToken) {
  const sql = `
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN ('databasechangelog', 'databasechangeloglock')
    ORDER BY pg_relation_size(c.oid) ASC
  `
  const payload = await streamPrdToPre.executePsqlCommand(sourceConfig, sourceDbName, sql, sourceToken)
  return String(payload).split('\n').map(line => line.trim()).filter(Boolean)
}

async function copyTable (args, sourceConnection, targetConnection, tableName, dataOnly = false) {
  console.log(`\nCopying table: ${tableName}`)
  return await streamPrdToPre.copyTableRows(
    sourceConnection.config,
    args.sourceDbName,
    targetConnection.config,
    args.targetDbName,
    tableName,
    sourceConnection.token,
    targetConnection.token,
    { dataOnly }
  )
}

async function executePsqlAdminCommand (args, adminDbName, sql) {
  return await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PGPASSWORD: args.targetPassword,
      PGSSLMODE: args.targetSsl ? 'require' : 'disable'
    }
    const child = spawn('psql', [
      '-h', args.targetHost,
      '-p', String(args.targetPort),
      '-U', args.targetAdmin,
      '-d', adminDbName,
      '-w',
      '-v', 'ON_ERROR_STOP=1',
      '-c', sql
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`psql admin command failed for ${adminDbName}: ${stderr}`))
        return
      }
      resolve()
    })
  })
}

async function dropAndRecreateLocalTargetDatabase (args, targetDbName) {
  console.log(`\nRecreating local target database ${targetDbName}...`)
  await executePsqlAdminCommand(args, 'postgres', `REVOKE CONNECT ON DATABASE "${targetDbName}" FROM PUBLIC; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${targetDbName}' AND pid <> pg_backend_pid();`)
  await executePsqlAdminCommand(args, 'postgres', `DROP DATABASE IF EXISTS "${targetDbName}"`)
  await executePsqlAdminCommand(args, 'postgres', `CREATE DATABASE "${targetDbName}"`)
  console.log(`Target database ${targetDbName} recreated.`)
}

async function restoreTargetSchema (args, sourceConnection, targetConnection) {
  console.log('\nRestoring full schema to target before copying data...')
  await streamPrdToPre.restoreDatabaseSchema(
    sourceConnection.config,
    args.sourceDbName,
    targetConnection.config,
    args.targetDbName,
    {
      sourceToken: sourceConnection.token,
      targetToken: targetConnection.token
    }
  )
  console.log('Schema restored successfully.')
}

async function applyGrants (args, sourceConnection, grantConnection) {
  console.log(`\nApplying managed identity grants for ${args.targetDbName}...`)
  const grantResult = await applyManagedIdentityGrants(
    { name: args.targetDbName, sourceDbName: args.sourceDbName, targetDbName: args.targetDbName },
    {
      sourceEnvironment: args.sourceEnvironment,
      targetEnvironment: 'local',
      sourceConnection,
      dryRun: false,
      verify: true,
      connection: grantConnection
    }
  )
  console.log(`Managed identity grants applied: ${grantResult.applied || 0} table(s), ${grantResult.missing || 0} missing before apply`)
  return grantResult
}

async function main () {
  const args = parseArgs()

  if (args.help || !args.sourceDbName || !args.targetDbName) {
    console.log('Usage: node scripts/transfer-service-to-local.js --source-db <db> --target-db <db> [options]')
    console.log('')
    console.log('Source credentials are read from env vars defined in app/constants/environment-definitions.js')
    console.log('  --source-environment <env>     default: DB_SOURCE_ENV or recovery')
    console.log('')
    console.log('Target credentials (defaults from LOCAL_POSTGRES_* env vars):')
    console.log('  --target-host <host>           default: LOCAL_POSTGRES_HOST or 127.0.0.1')
    console.log('  --target-port <port>           default: LOCAL_POSTGRES_PORT or set to service')
    console.log('  --target-admin <username>      default: LOCAL_POSTGRES_ADMIN or postgres')
    console.log('  --target-password <password>   default: LOCAL_POSTGRES_PASSWORD or postgres')
    console.log('  --target-ssl <true|false>      default: false')
    console.log('')
    console.log('Options:')
    console.log('  --continue-on-error            Copy remaining tables if one fails')
    console.log('  --skip-grants                  Do not apply managed identity grants after transfer')
    process.exit(args.help ? 0 : 1)
  }

  console.log(`Copying all tables from ${args.sourceEnvironment}/${args.sourceDbName} to local ${args.targetHost}:${args.targetPort}/${args.targetDbName}`)
  console.log(`Source credentials: resolved from environment definitions for ${args.sourceEnvironment}`)
  console.log(`Target credentials: using ${args.targetAdmin}@${args.targetHost}:${args.targetPort}`)
  if (args.skipGrants) {
    console.log('Managed identity grants will be skipped (--skip-grants)')
  }

  const sourceConnection = await createConnection(args.sourceDbName, {
    environment: args.sourceEnvironment
  })

  let targetConnection = await connectToLocalTarget(args, args.targetDbName)

  try {
    console.log('\nDiscovering source tables...')
    const tables = await listSourceTables(sourceConnection.config, args.sourceDbName, sourceConnection.token)
    const dependencies = await streamPrdToPre.getForeignKeyDependencies(sourceConnection.config, args.sourceDbName, sourceConnection.token)
    const orderedTables = streamPrdToPre.sortTablesByDependencies(tables, dependencies)
    console.log(`Found ${orderedTables.length} table(s) to copy`)

    if (!orderedTables.length) {
      console.log('No application tables found; nothing to copy.')
      return
    }

    await targetConnection.pool.end()
    targetConnection = null

    await dropAndRecreateLocalTargetDatabase(args, args.targetDbName)

    targetConnection = await connectToLocalTarget(args, args.targetDbName)
    await restoreTargetSchema(args, sourceConnection, targetConnection)

    // Foreign key checks are disabled per-import psql session via PGOPTIONS in
    // stream-prd-to-pre.js, so each COPY can load rows in any order.
    const results = []
    const failures = []
    for (const tableName of orderedTables) {
      try {
        const result = await copyTable(args, sourceConnection, targetConnection, tableName, true)
        results.push(result)
      } catch (error) {
        failures.push({ tableName, error: error.message })
        console.error(`❌ Failed to copy ${tableName}: ${error.message}`)
        if (!args.continueOnError) {
          throw error
        }
        console.log('Continuing to next table because --continue-on-error is set.')
      }
    }

    if (!args.skipGrants) {
      const grantConnection = await createConnection(args.targetDbName, {
        environment: 'local',
        host: args.targetHost,
        port: args.targetPort,
        username: args.targetAdmin,
        password: args.targetPassword,
        ssl: args.targetSsl
      })

      try {
        await applyGrants(args, sourceConnection, grantConnection)
      } finally {
        await grantConnection?.pool?.end()
      }
    }

    console.log('\n=== Summary ===')
    console.log(`Tables copied: ${results.length}`)
    console.log(`Failures: ${failures.length}`)
    if (failures.length) {
      for (const failure of failures) {
        console.log(`  - ${failure.tableName}: ${failure.error}`)
      }
    }

    if (failures.length && !args.continueOnError) {
      process.exit(1)
    }
  } finally {
    await sourceConnection?.pool?.end()
    await targetConnection?.pool?.end()
  }
}

main().catch(error => {
  console.error('Service-to-local transfer failed:', error)
  process.exit(1)
})
