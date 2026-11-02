#!/usr/bin/env node

const { createConnection, normaliseEnvironmentName } = require('./db-connection')

function parseArgs (argv = process.argv.slice(2)) {
  const args = {
    environment: 'pre',
    database: 'ffc-pay-alerting-pre',
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--environment') args.environment = argv[++i]
    else if (arg === '--database') args.database = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }

  return args
}

async function tableExists (connection, tableName) {
  const result = await connection.query(
    `SELECT to_regclass('public.${tableName}') AS table_name`,
    []
  )

  return result.rows[0]?.table_name !== null
}

async function showTableStatus (connection, tableNames) {
  const statuses = {}

  for (const tableName of tableNames) {
    statuses[tableName] = await tableExists(connection, tableName)
  }

  return statuses
}

async function main () {
  const args = parseArgs()

  if (args.help) {
    console.log('Usage: node app/database/reset-liquibase-metadata.js --environment pre --database ffc-pay-alerting-pre')
    console.log('')
    console.log('This script connects to the target PRE database, drops the Liquibase metadata tables, and verifies whether the tables actually disappear from that exact connection.')
    return
  }

  const environment = normaliseEnvironmentName(args.environment)
  const database = args.database

  console.log(`Connecting to ${environment}/${database}...`)
  const connection = await createConnection(database, { environment })

  try {
    const tables = ['databasechangelog', 'databasechangeloglock']

    console.log('Before drop status:')
    const before = await showTableStatus(connection, tables)
    console.log(JSON.stringify(before, null, 2))

    for (const tableName of tables) {
      const existsBefore = await tableExists(connection, tableName)
      if (existsBefore) {
        console.log(`Dropping public.${tableName} ...`)
        await connection.query(`DROP TABLE IF EXISTS public.${tableName} CASCADE;`)
      } else {
        console.log(`public.${tableName} was not present before the drop attempt.`)
      }
    }

    console.log('After drop status:')
    const after = await showTableStatus(connection, tables)
    console.log(JSON.stringify(after, null, 2))

    const stillPresent = Object.entries(after)
      .filter(([_, value]) => value)
      .map(([name]) => name)

    if (stillPresent.length > 0) {
      console.error(`Tables still present after attempted drop: ${stillPresent.join(', ')}`)
      process.exitCode = 1
      return
    }

    console.log('Liquibase metadata tables are absent on this target database connection.')
  } catch (error) {
    console.error('Reset failed:', error)
    process.exitCode = 1
  } finally {
    if (connection?.pool) {
      await connection.pool.end()
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  tableExists,
  showTableStatus,
  main
}
