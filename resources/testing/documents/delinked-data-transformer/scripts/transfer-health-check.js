#!/usr/bin/env node

// Health-check a local transferred database for common post-transfer problems:
//   - sequences behind current max values
//   - tables missing a primary key
//   - foreign keys without a supporting index
//   - invalid indexes
//   - unvalidated foreign keys

const { createConnection } = require('../app/database/db-connection')
const streamPrdToPre = require('../app/database/stream-prd-to-pre')

const LOCAL_POSTGRES_SERVICE_PORT = 5490

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    targetDbName: null,
    targetHost: process.env.LOCAL_POSTGRES_HOST || '127.0.0.1',
    targetPort: Number(process.env.LOCAL_POSTGRES_PORT || LOCAL_POSTGRES_SERVICE_PORT),
    targetAdmin: process.env.LOCAL_POSTGRES_ADMIN || 'postgres',
    targetPassword: process.env.LOCAL_POSTGRES_PASSWORD || 'ppp',
    targetSsl: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target-db') args.targetDbName = argv[++i]
    else if (arg === '--target-host') args.targetHost = argv[++i]
    else if (arg === '--target-port') args.targetPort = Number(argv[++i])
    else if (arg === '--target-admin') args.targetAdmin = argv[++i]
    else if (arg === '--target-password') args.targetPassword = argv[++i]
    else if (arg === '--target-ssl') args.targetSsl = argv[++i] === 'true'
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function main () {
  const args = parseArgs()

  if (args.help || !args.targetDbName) {
    console.log('Usage: node scripts/transfer-health-check.js --target-db <db> [options]')
    console.log('')
    console.log('Target credentials (defaults from LOCAL_POSTGRES_* env vars):')
    console.log('  --target-host <host>           default: LOCAL_POSTGRES_HOST or 127.0.0.1')
    console.log('  --target-port <port>           default: LOCAL_POSTGRES_PORT or 5440')
    console.log('  --target-admin <username>      default: LOCAL_POSTGRES_ADMIN or postgres')
    console.log('  --target-password <password>   default: LOCAL_POSTGRES_PASSWORD or postgres')
    console.log('  --target-ssl <true|false>      default: false')
    process.exit(args.help ? 0 : 1)
  }

  console.log(`Running transfer health check on ${args.targetHost}:${args.targetPort}/${args.targetDbName}`)

  const connection = await createConnection(args.targetDbName, {
    environment: 'local',
    host: args.targetHost,
    port: args.targetPort,
    username: args.targetAdmin,
    password: args.targetPassword,
    ssl: args.targetSsl
  })

  try {
    await streamPrdToPre.runTransferHealthCheck(connection.config, args.targetDbName, connection.token)
    console.log('✅ Health check passed')
  } catch (error) {
    console.error('❌ Health check failed:', error.message)
    process.exit(1)
  } finally {
    await connection?.pool?.end()
  }
}

main().catch(error => {
  console.error('Health check failed:', error)
  process.exit(1)
})
