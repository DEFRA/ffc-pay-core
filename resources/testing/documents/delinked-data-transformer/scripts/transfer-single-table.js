#!/usr/bin/env node

// Small helper for local test runs: copy a single table from a configured
// remote source to a local PostgreSQL target. This script is self-contained
// and does not require app/config/local.js to be modified.

const { createConnection } = require('../app/database/db-connection')
const { processService: applyManagedIdentityGrants } = require('../app/database/grant-managed-identity')
const streamPrdToPre = require('../app/database/stream-prd-to-pre')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    sourceDbName: null,
    targetDbName: null,
    table: null,
    sourceEnvironment: process.env.DB_SOURCE_ENV || 'recovery',
    targetHost: process.env.LOCAL_POSTGRES_HOST || '127.0.0.1',
    targetPort: Number(process.env.LOCAL_POSTGRES_PORT || 5438),
    targetAdmin: process.env.LOCAL_POSTGRES_ADMIN || 'postgres',
    targetPassword: process.env.LOCAL_POSTGRES_PASSWORD || 'ppp',
    targetSsl: false,
    skipGrants: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source-db') args.sourceDbName = argv[++i]
    else if (arg === '--target-db') args.targetDbName = argv[++i]
    else if (arg === '--table') args.table = argv[++i]
    else if (arg === '--source-environment') args.sourceEnvironment = argv[++i]
    else if (arg === '--target-host') args.targetHost = argv[++i]
    else if (arg === '--target-port') args.targetPort = Number(argv[++i])
    else if (arg === '--target-admin') args.targetAdmin = argv[++i]
    else if (arg === '--target-password') args.targetPassword = argv[++i]
    else if (arg === '--target-ssl') args.targetSsl = argv[++i] === 'true'
    else if (arg === '--skip-grants') args.skipGrants = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function connectToLocalTarget (args, databaseName) {
  const connection = await createConnection(databaseName, {
    environment: 'local',
    host: args.targetHost,
    port: args.targetPort,
    username: args.targetAdmin,
    password: args.targetPassword,
    ssl: args.targetSsl
  })

  const { config, token } = connection
  await connection.pool.end()

  return { config, token }
}

async function main () {
  const args = parseArgs()

  if (args.help || !args.sourceDbName || !args.targetDbName || !args.table) {
    console.log('Usage: node scripts/transfer-single-table.js --source-db <db> --target-db <db> --table <table>')
    console.log('')
    console.log('Source credentials are read from env vars defined in app/constants/environment-definitions.js')
    console.log('  --source-environment <env>     default: DB_SOURCE_ENV or recovery')
    console.log('')
    console.log('Target credentials (defaults from LOCAL_POSTGRES_* env vars):')
    console.log('  --target-host <host>           default: LOCAL_POSTGRES_HOST or 127.0.0.1')
    console.log('  --target-port <port>           default: LOCAL_POSTGRES_PORT or 5438')
    console.log('  --target-admin <username>      default: LOCAL_POSTGRES_ADMIN or postgres')
    console.log('  --target-password <password>   default: LOCAL_POSTGRES_PASSWORD or postgres')
    console.log('  --target-ssl <true|false>      default: false')
    console.log('  --skip-grants                  Do not apply managed identity grants after transfer')
    process.exit(args.help ? 0 : 1)
  }

  console.log(`Copying single table ${args.table} from ${args.sourceEnvironment}/${args.sourceDbName} to local ${args.targetHost}:${args.targetPort}/${args.targetDbName}`)

  console.log(`Source credentials: using ${args.sourceAdmin || '<resolved from env>'} for ${args.sourceEnvironment}`)
  console.log(`Target credentials: using ${args.targetAdmin}@${args.targetHost}:${args.targetPort}`)

  const sourceConnection = await createConnection(args.sourceDbName, {
    environment: args.sourceEnvironment
  })

  const targetConnection = await connectToLocalTarget(args, args.targetDbName)

  try {
    const result = await streamPrdToPre.copyTableRows(
      sourceConnection.config,
      args.sourceDbName,
      targetConnection.config,
      args.targetDbName,
      args.table,
      sourceConnection.token,
      targetConnection.token,
      { dataOnly: false }
    )
    console.log('Result:', JSON.stringify(result, null, 2))

    if (!args.skipGrants) {
      console.log(`\nApplying managed identity grants for ${args.targetDbName}...`)
      const grantConnection = await createConnection(args.targetDbName, {
        environment: 'local',
        host: args.targetHost,
        port: args.targetPort,
        username: args.targetAdmin,
        password: args.targetPassword,
        ssl: args.targetSsl
      })

      try {
        const grantResult = await applyManagedIdentityGrants(
          { name: args.targetDbName, sourceDbName: args.sourceDbName, targetDbName: args.targetDbName },
          { targetEnvironment: 'local', dryRun: false, verify: true, connection: grantConnection }
        )
        console.log(`Managed identity grants applied: ${grantResult.applied || 0} table(s), ${grantResult.missing || 0} missing before apply`)
      } finally {
        await grantConnection?.pool?.end()
      }
    }
  } finally {
    await sourceConnection?.pool?.end()
  }
}

main().catch(error => {
  console.error('Single-table transfer failed:', error)
  process.exit(1)
})
