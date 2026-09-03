#!/usr/bin/env node

// Inspect a local Postgres database for tables, keys, indexes and grants.
// Run this from your normal VS Code terminal, not the Copilot sandbox.
//
// Example:
//   LOCAL_POSTGRES_HOST=127.0.0.1 \
//   LOCAL_POSTGRES_PORT=5438 \
//   LOCAL_POSTGRES_ADMIN=postgres \
//   LOCAL_POSTGRES_PASSWORD=postgres \
//   node scripts/inspect-local-db.js ffc-pay-submission

const { Client } = require('pg')

function parseArgs (argv = process.argv.slice(2)) {
  const databaseName = argv[0]
  const host = process.env.LOCAL_POSTGRES_HOST || '127.0.0.1'
  const port = Number(process.env.LOCAL_POSTGRES_PORT || 5438)
  const user = process.env.LOCAL_POSTGRES_ADMIN || 'postgres'
  const password = process.env.LOCAL_POSTGRES_PASSWORD || 'ppp'

  return { databaseName, host, port, user, password }
}

async function main () {
  const args = parseArgs()
  if (!args.databaseName) {
    console.log('Usage: node scripts/inspect-local-db.js <database-name>')
    console.log('Environment variables: LOCAL_POSTGRES_HOST, LOCAL_POSTGRES_PORT, LOCAL_POSTGRES_ADMIN, LOCAL_POSTGRES_PASSWORD')
    process.exit(1)
  }

  const client = new Client({
    host: args.host,
    port: args.port,
    user: args.user,
    password: args.password,
    database: args.databaseName,
    ssl: false
  })

  await client.connect()

  try {
    console.log(`\nConnected to ${args.host}:${args.port}/${args.databaseName}\n`)

    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")
    console.log(`Tables (${tables.rows.length}):`)
    for (const row of tables.rows) {
      console.log(`  - ${row.table_name}`)
    }

    const pks = await client.query(`
      SELECT tc.table_name, kcu.column_name, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.ordinal_position
    `)
    console.log(`\nPrimary keys (${pks.rows.length}):`)
    for (const row of pks.rows) {
      console.log(`  - ${row.table_name}.${row.column_name} (${row.constraint_name})`)
    }

    const fks = await client.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name
    `)
    console.log(`\nForeign keys (${fks.rows.length}):`)
    for (const row of fks.rows) {
      console.log(`  - ${row.table_name}.${row.column_name} -> ${row.foreign_table}.${row.foreign_column} (${row.constraint_name})`)
    }

    const uniques = await client.query("SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE constraint_type = 'UNIQUE' AND table_schema = 'public' ORDER BY table_name")
    console.log(`\nUnique constraints (${uniques.rows.length}):`)
    for (const row of uniques.rows) {
      console.log(`  - ${row.table_name} (${row.constraint_name})`)
    }

    const indexes = await client.query("SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname")
    console.log(`\nIndexes (${indexes.rows.length}):`)
    for (const row of indexes.rows) {
      console.log(`  - ${row.tablename}.${row.indexname}`)
    }

    const grants = await client.query(`
      SELECT DISTINCT grantee, table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND grantee NOT IN ('PUBLIC', 'postgres')
      ORDER BY grantee, table_name, privilege_type
    `)
    console.log(`\nGrants (${grants.rows.length} rows):`)
    for (const row of grants.rows) {
      console.log(`  - ${row.grantee} on ${row.table_name}: ${row.privilege_type}`)
    }
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error('Inspect failed:', error.message)
  process.exit(1)
})
