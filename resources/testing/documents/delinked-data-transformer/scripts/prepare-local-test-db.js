#!/usr/bin/env node

// Prepare a local Postgres database for transfer testing.
// Creates a test table with PK, FK, unique constraint and index,
// plus a mock managed identity role with grants.
//
// Run this from your normal VS Code terminal, not the Copilot sandbox.
//
// Example:
//   LOCAL_POSTGRES_HOST=127.0.0.1 \
//   LOCAL_POSTGRES_PORT=5438 \
//   LOCAL_POSTGRES_ADMIN=postgres \
//   LOCAL_POSTGRES_PASSWORD=postgres \
//   node scripts/prepare-local-test-db.js ffc-pay-submission
//   Setting this as pay-submission as a good example of a real database with multiple tables, grants, and Liquibase metadata.

const { Client } = require('pg')

const MID_ROLE_NAME = 'devffcinfdmid01'

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
    console.log('Usage: node scripts/prepare-local-test-db.js <database-name>')
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
    console.log(`Preparing ${args.databaseName} for local transfer test...\n`)

    // Create mock managed identity role if it does not exist.
    const roleResult = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [MID_ROLE_NAME])
    if (roleResult.rows.length === 0) {
      await client.query(`CREATE ROLE ${MID_ROLE_NAME} WITH LOGIN`)
      console.log(`  Created role ${MID_ROLE_NAME}`)
    } else {
      console.log(`  Role ${MID_ROLE_NAME} already exists`)
    }

    // Create Liquibase metadata tables if missing.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.databasechangelog (
        id character varying(255) NOT NULL,
        author character varying(255) NOT NULL,
        filename character varying(520) NOT NULL,
        dateexecuted timestamp with time zone NOT NULL,
        orderexecuted integer NOT NULL,
        exectype character varying(10) NOT NULL,
        md5sum character varying(35),
        description character varying(255),
        comments character varying(255),
        tag character varying(255),
        liquibase character varying(20),
        contexts character varying(255),
        labels character varying(255),
        deployment_id character varying(10)
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.databasechangeloglock (
        id integer NOT NULL,
        locked boolean NOT NULL,
        lockgranted timestamp with time zone,
        lockedby character varying(255),
        CONSTRAINT databasechangeloglock_pkey PRIMARY KEY (id)
      )
    `)

    // Grant the MID access to Liquibase tables so the grant-discovery logic can find it.
    await client.query(`GRANT ALL PRIVILEGES ON TABLE public.databasechangelog TO ${MID_ROLE_NAME}`)
    await client.query(`GRANT ALL PRIVILEGES ON TABLE public.databasechangeloglock TO ${MID_ROLE_NAME}`)
    console.log('  Ensured Liquibase tables exist and are granted to MID')

    // Grant the MID access to all existing non-Liquibase tables in the database
    // so the transfer test can verify that grants are preserved/restored.
    const existingTables = await client.query(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname NOT IN ('databasechangelog', 'databasechangeloglock')
      ORDER BY c.relname
    `)

    if (existingTables.rows.length > 0) {
      const tableList = existingTables.rows
        .map(row => `public."${row.table_name.replace(/"/g, '""')}"`)
        .join(', ')
      await client.query(`GRANT ALL PRIVILEGES ON TABLE ${tableList} TO ${MID_ROLE_NAME}`)
      console.log(`  Granted MID access to ${existingTables.rows.length} existing table(s)`)
    }

    // Create test tables with PK, FK, unique and index if they do not exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.test_parent (
        parent_id bigint PRIMARY KEY,
        parent_name character varying(100) NOT NULL
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.test_child (
        child_id bigint PRIMARY KEY,
        parent_id bigint NOT NULL,
        child_name character varying(100) NOT NULL,
        child_code character varying(50),
        CONSTRAINT fk_test_child_parent FOREIGN KEY (parent_id) REFERENCES public.test_parent(parent_id),
        CONSTRAINT uq_test_child_code UNIQUE (child_code)
      )
    `)

    await client.query('CREATE INDEX IF NOT EXISTS idx_test_child_name ON public.test_child(child_name)')

    // Seed some rows.
    await client.query(`
      INSERT INTO public.test_parent (parent_id, parent_name) VALUES (1, 'Parent One'), (2, 'Parent Two')
      ON CONFLICT (parent_id) DO NOTHING
    `)
    await client.query(`
      INSERT INTO public.test_child (child_id, parent_id, child_name, child_code) VALUES
        (101, 1, 'Child A', 'CHILD-A'),
        (102, 1, 'Child B', 'CHILD-B'),
        (103, 2, 'Child C', 'CHILD-C')
      ON CONFLICT (child_id) DO NOTHING
    `)
    console.log('  Created/updated test_parent and test_child with PK/FK/index/unique')

    // Grant the MID access to the test tables.
    await client.query(`GRANT ALL PRIVILEGES ON TABLE public.test_parent, public.test_child TO ${MID_ROLE_NAME}`)
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${MID_ROLE_NAME}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${MID_ROLE_NAME}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${MID_ROLE_NAME}`)
    console.log('  Granted MID access to test tables, sequences and default privileges')

    console.log('\nDatabase is ready for local transfer testing.')
    console.log('Next, run the transfer and verify that PK/FK/indexes/grants survive.')
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error('Prepare failed:', error.message)
  process.exit(1)
})
