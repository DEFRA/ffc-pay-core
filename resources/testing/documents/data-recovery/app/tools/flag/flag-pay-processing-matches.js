const path = require('path')
const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { parseCsvIds } = require('../../util/parse-csv-ids')
const { createLocalRecoveryDb } = require('../../create-local-db')
const payProcessing = require('../../config/pay-processing')

const { HOSTED_DATABASE, QUEUE_TABLE, TABLES } = payProcessing
const CSV_FILE = path.resolve(__dirname, '../..', payProcessing.CSV_FILE)
const BATCH_SIZE = payProcessing.BATCH_SIZE

function buildQueueTableDdl (tableName, flagColumns) {
  const flagColumnDefs = flagColumns
    .map(col => `"${col}" boolean DEFAULT false`)
    .join(',\n      ')

  return `
    CREATE TABLE IF NOT EXISTS public."${tableName}" (
      "paymentRequestId" integer NOT NULL,
      ${flagColumnDefs},
      status character varying(20) DEFAULT 'PENDING',
      "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "${tableName}_pkey" PRIMARY KEY ("paymentRequestId")
    )
  `
}

async function ensureQueueTable (client) {
  const flagColumns = QUEUE_TABLE.flagColumns
  await client.query(buildQueueTableDdl(QUEUE_TABLE.name, flagColumns))

  for (const column of flagColumns) {
    await client.query(`
      ALTER TABLE public."${QUEUE_TABLE.name}"
      ADD COLUMN IF NOT EXISTS "${column}" boolean DEFAULT false
    `)
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS "idx_${QUEUE_TABLE.name}_status"
      ON public."${QUEUE_TABLE.name}" USING btree (status ASC NULLS LAST)
  `)
}

async function loadStagingTable (client, ids) {
  await client.query('DROP TABLE IF EXISTS _staging_csv_payment_request_ids')
  await client.query(`
    CREATE TEMP TABLE _staging_csv_payment_request_ids (
      "paymentRequestId" integer PRIMARY KEY
    )
  `)

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map((_, index) => `($${index + 1})`).join(', ')
    await client.query(
      `INSERT INTO _staging_csv_payment_request_ids ("paymentRequestId") VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      batch
    )
  }
}

async function getMatchingIdsFromHostedTable (hostedConnection, ids, tableName) {
  const matchedIds = []

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map((_, index) => `$${index + 1}`).join(', ')
    const result = await hostedConnection.query(
      `SELECT DISTINCT "paymentRequestId" FROM public."${tableName}" WHERE "paymentRequestId" IN (${placeholders})`,
      batch
    )
    matchedIds.push(...result.rows.map(row => row.paymentRequestId))
  }

  return matchedIds
}

async function flagMatchesForTable (localConnection, matchedIds, flagColumn) {
  if (matchedIds.length === 0) {
    return 0
  }

  let flaggedCount = 0
  const primaryKeyColumns = Array.isArray(QUEUE_TABLE.primaryKey) ? QUEUE_TABLE.primaryKey : [QUEUE_TABLE.primaryKey]
  const pkList = primaryKeyColumns.map(c => `"${c}"`).join(', ')

  for (let i = 0; i < matchedIds.length; i += BATCH_SIZE) {
    const batch = matchedIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map((_, index) => `($${index + 1}, true)`).join(', ')
    const result = await localConnection.query(
      `
      INSERT INTO public."${QUEUE_TABLE.name}" ("paymentRequestId", "${flagColumn}")
      VALUES ${placeholders}
      ON CONFLICT (${pkList}) DO UPDATE SET
        "${flagColumn}" = true,
        status = CASE
          WHEN "${QUEUE_TABLE.name}".status = 'VERIFIED' THEN 'VERIFIED'
          ELSE 'PENDING'
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "paymentRequestId"
      `,
      batch
    )
    flaggedCount += result.rowCount
  }

  return flaggedCount
}

async function getSummary (client) {
  const flagCounts = QUEUE_TABLE.flagColumns
    .map(col => `COUNT(*) FILTER (WHERE "${col}") AS "${col}"`)
    .join(',\n      ')

  const { rows } = await client.query(`
    SELECT
      COUNT(*) AS total,
      ${flagCounts},
      COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
      COUNT(*) FILTER (WHERE status = 'VERIFIED') AS verified,
      COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress
    FROM public."${QUEUE_TABLE.name}"
  `)
  return rows[0]
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_flag_probe' })
    await connection.close()
    console.log('Local recovery database is already running.')
  } catch (error) {
    console.log('Local recovery database is not available; running create-local-db.js first...')
    await createLocalRecoveryDb()
  }
}

async function run () {
  await ensureLocalRecoveryDb()

  let hostedConnection
  let localConnection
  let localClient

  try {
    console.log(`Connecting to hosted ${HOSTED_DATABASE} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_recovery_flag_reader' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_flag_writer' })

    console.log(`Loading payment request IDs from ${CSV_FILE}...`)
    const ids = parseCsvIds(CSV_FILE)
    console.log(`Loaded ${ids.length} unique payment request IDs`)

    localClient = await localConnection.pool.connect()

    await localClient.query('BEGIN')
    await ensureQueueTable(localClient)
    await loadStagingTable(localClient, ids)

    for (const { name, flagColumn } of TABLES) {
      const matchedIds = await getMatchingIdsFromHostedTable(hostedConnection, ids, name)
      console.log(`Found ${matchedIds.length} IDs in hosted ${name}`)

      if (matchedIds.length > 0) {
        const flaggedCount = await flagMatchesForTable(localClient, matchedIds, flagColumn)
        console.log(`Flagged ${flaggedCount} IDs for ${flagColumn}`)
      }
    }

    const summary = await getSummary(localClient)
    await localClient.query('COMMIT')

    console.log('\nManual verification queue summary:')
    console.log(`  Total flagged:       ${summary.total}`)
    for (const flagColumn of QUEUE_TABLE.flagColumns) {
      console.log(`  ${flagColumn}:  ${summary[flagColumn]}`)
    }
    console.log(`  PENDING:             ${summary.pending}`)
    console.log(`  VERIFIED:            ${summary.verified}`)
    console.log(`  REJECTED:            ${summary.rejected}`)
    console.log(`  IN_PROGRESS:         ${summary.in_progress}`)
  } catch (error) {
    if (localClient) {
      await localClient.query('ROLLBACK').catch(() => {})
    }
    console.error('Failed to flag CSV matches for manual verification:', error.message)
    process.exit(1)
  } finally {
    if (localClient) {
      localClient.release()
    }
    if (hostedConnection) {
      await hostedConnection.close()
    }
    if (localConnection) {
      await localConnection.close()
    }
  }
}

run()
