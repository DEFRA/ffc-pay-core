#!/usr/bin/env node

const { createConnection } = require('./db-connection')
const { saveServiceMetadata } = require('./metadata-storage')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    database: 'your-service-prd',
    environment: 'prd',
    includeAllTables: false,
    save: false,
    outputDir: null,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--database') args.database = argv[++i]
    else if (arg === '--environment') args.environment = argv[++i]
    else if (arg === '--include-all-tables') args.includeAllTables = true
    else if (arg === '--save') args.save = true
    else if (arg === '--output-dir') args.outputDir = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function discoverTableMetadata (databaseName, environment = 'prd') {
  const connection = await createConnection(databaseName, { environment })

  try {
    const tableResult = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )

    const tables = tableResult.rows.map(row => row.table_name)
    const filteredTables = tables.filter(tableName => !/^databasechangelog|^databasechangeloglock/i.test(String(tableName)))

    const metadata = []

    for (const tableName of filteredTables) {
      const keyResult = await connection.query(
        `SELECT column_name
         FROM information_schema.key_column_usage
         WHERE table_schema = 'public'
           AND table_name = $1
           AND constraint_name IN (
             SELECT constraint_name
             FROM information_schema.table_constraints
             WHERE table_schema = 'public'
               AND table_name = $1
               AND constraint_type = 'PRIMARY KEY'
           )
         ORDER BY ordinal_position`,
        [tableName]
      )

      const keyColumn = keyResult.rows[0]?.column_name || null
      metadata.push({
        name: tableName,
        keyColumn,
        include: true
      })
    }

    return metadata
  } finally {
    await connection?.pool?.end()
  }
}

async function main () {
  const args = parseArgs()

  if (args.help) {
    console.log('Usage: node app/database/discover-service-metadata.js --database <service-prd> --environment prd [--include-all-tables] [--save] [--output-dir <path>]')
    return
  }

  const metadata = await discoverTableMetadata(args.database, args.environment)
  const filtered = args.includeAllTables ? metadata : metadata.filter(item => item.include)

  if (args.save) {
    const result = await saveServiceMetadata(args.database, filtered, {
      environment: args.environment,
      outputDir: args.outputDir
    })
    console.log(JSON.stringify({ saved: result.saved, filePath: result.filePath, count: result.count }, null, 2))
    return
  }

  console.log(JSON.stringify(filtered, null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Metadata discovery failed:', error)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  discoverTableMetadata,
  main
}
