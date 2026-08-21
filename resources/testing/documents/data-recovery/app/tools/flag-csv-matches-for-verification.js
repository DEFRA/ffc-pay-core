const path = require('path')
const { createRecoveryConnection } = require('../database/recovery-db-connection')
const { createLocalConnection } = require('../database/local-db-connection')
const { parseCsvIds } = require('../util/parse-csv-ids')
const { createLocalRecoveryDb } = require('../create-local-db')

const CSV_FILE = path.resolve(__dirname, '..', 'pr-id.csv')
const BATCH_SIZE = 5000

const VERIFICATION_TABLES = [
  { tableName: 'invoiceLines', flagColumn: 'foundInInvoiceLines' },
  { tableName: 'completedPaymentRequests', flagColumn: 'foundInCompletedPaymentRequests' },
  { tableName: 'schedule', flagColumn: 'foundInSchedule' }
]

async function ensureQueueTable (client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public."manualVerificationQueue" (
      "paymentRequestId" integer NOT NULL,
      "foundInInvoiceLines" boolean DEFAULT false,
      "foundInCompletedPaymentRequests" boolean DEFAULT false,
      "foundInSchedule" boolean DEFAULT false,
      "foundInCompletedInvoiceLines" boolean DEFAULT false,
      "foundInOutbox" boolean DEFAULT false,
      status character varying(20) DEFAULT 'PENDING',
      "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "manualVerificationQueue_pkey" PRIMARY KEY ("paymentRequestId")
    )
  `)

  const requiredColumns = [
    { name: 'foundInInvoiceLines', type: 'boolean DEFAULT false' },
    { name: 'foundInCompletedPaymentRequests', type: 'boolean DEFAULT false' },
    { name: 'foundInSchedule', type: 'boolean DEFAULT false' },
    { name: 'foundInCompletedInvoiceLines', type: 'boolean DEFAULT false' },
    { name: 'foundInOutbox', type: 'boolean DEFAULT false' }
  ]

  for (const column of requiredColumns) {
    await client.query(`
      ALTER TABLE public."manualVerificationQueue"
      ADD COLUMN IF NOT EXISTS "${column.name}" ${column.type}
    `)
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS "idx_manualVerificationQueue_status"
      ON public."manualVerificationQueue" USING btree (status ASC NULLS LAST)
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

  for (let i = 0; i < matchedIds.length; i += BATCH_SIZE) {
    const batch = matchedIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map((_, index) => `($${index + 1}, true)`).join(', ')
    const result = await localConnection.query(
      `
      INSERT INTO public."manualVerificationQueue" ("paymentRequestId", "${flagColumn}")
      VALUES ${placeholders}
      ON CONFLICT ("paymentRequestId") DO UPDATE SET
        "${flagColumn}" = true,
        status = CASE
          WHEN "manualVerificationQueue".status = 'VERIFIED' THEN 'VERIFIED'
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
  const { rows } = await client.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE "foundInInvoiceLines") AS invoice_lines,
      COUNT(*) FILTER (WHERE "foundInCompletedPaymentRequests") AS completed_payment_requests,
      COUNT(*) FILTER (WHERE "foundInSchedule") AS schedule,
      COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
      COUNT(*) FILTER (WHERE status = 'VERIFIED') AS verified,
      COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress
    FROM public."manualVerificationQueue"
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
    console.log('Connecting to hosted recovery database (read-only)...')
    hostedConnection = await createRecoveryConnection({ applicationName: 'ffc_pay_recovery_flag_reader' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_flag_writer' })

    console.log(`Loading payment request IDs from ${CSV_FILE}...`)
    const ids = parseCsvIds(CSV_FILE)
    console.log(`Loaded ${ids.length} unique payment request IDs`)

    localClient = await localConnection.pool.connect()

    await localClient.query('BEGIN')
    await ensureQueueTable(localClient)
    await loadStagingTable(localClient, ids)

    for (const { tableName, flagColumn } of VERIFICATION_TABLES) {
      const matchedIds = await getMatchingIdsFromHostedTable(hostedConnection, ids, tableName)
      console.log(`Found ${matchedIds.length} IDs in hosted ${tableName}`)

      if (matchedIds.length > 0) {
        const flaggedCount = await flagMatchesForTable(localClient, matchedIds, flagColumn)
        console.log(`Flagged ${flaggedCount} IDs for ${flagColumn}`)
      }
    }

    const summary = await getSummary(localClient)
    await localClient.query('COMMIT')

    console.log('\nManual verification queue summary:')
    console.log(`  Total flagged:       ${summary.total}`)
    console.log(`  In invoiceLines:     ${summary.invoice_lines}`)
    console.log(`  In completedPRs:     ${summary.completed_payment_requests}`)
    console.log(`  In schedule:         ${summary.schedule}`)
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
