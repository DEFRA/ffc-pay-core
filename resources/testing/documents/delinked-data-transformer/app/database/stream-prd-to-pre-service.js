#!/usr/bin/env node

const { streamPrdToPre } = require('./stream-prd-to-pre')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    sourceDbName: 'ffc-pay-request-editor-prd',
    targetDbName: undefined,
    dryRun: false,
    includeLiquibaseTables: false,
    sourceEnvironment: 'prd',
    targetEnvironment: 'pre',
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source-db') args.sourceDbName = argv[++i]
    else if (arg === '--target-db') args.targetDbName = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--include-liquibase') args.includeLiquibaseTables = true
    else if (arg === '--source-environment') args.sourceEnvironment = argv[++i]
    else if (arg === '--target-environment') args.targetEnvironment = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function main () {
  const args = parseArgs()

  if (args.help) {
    console.log('Usage: node app/database/stream-prd-to-pre-service.js [--source-db ffc-pay-request-editor-prd] [--target-db ffc-pay-request-editor-pre] [--dry-run] [--include-liquibase]')
    return
  }

  console.log('Running PRD -> PRE stream for a service database with Liquibase-safe defaults.')
  console.log(`Source: ${args.sourceEnvironment}/${args.sourceDbName}`)
  console.log(`Target: ${args.targetEnvironment}/${args.targetDbName || '<resolved from source>'}`)
  console.log(`Include Liquibase tables: ${args.includeLiquibaseTables}`)

  const result = await streamPrdToPre({
    sourceEnvironment: args.sourceEnvironment,
    targetEnvironment: args.targetEnvironment,
    sourceDbName: args.sourceDbName,
    targetDbName: args.targetDbName,
    dryRun: args.dryRun,
    includeLiquibaseTables: args.includeLiquibaseTables
  })

  console.log('Result:', JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Service PRD -> PRE stream failed:', error)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  main
}
