const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { createLocalRecoveryDb } = require('../../create-local-db')
const config = require('../../config/pay-injection')

const {
  SERVICE_NAME,
  HOSTED_DATABASE,
  LOCAL_QUEUE_TABLE,
  QUEUE_TABLE,
  SOURCE_TABLE,
  BATCH_SIZE,
  PARENT_TABLE
} = config

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/flag/flag-pay-injection-matches.js [--dry-run]')
      console.log('Flags injection invoiceNumbers using natural keys from the local pay-processing paymentRequests table.')
      process.exit(0)
    }
  }

  return options
}

function buildQueueTableDdl (queueTable) {
  const keyColumnDefs = Object.entries(queueTable.keyColumns)
    .map(([name, type]) => `"${name}" ${type}`)
    .join(',\n      ')

  const flagColumnDefs = queueTable.flagColumns
    .map(col => `"${col}" boolean DEFAULT false`)
    .join(',\n      ')

  return `
    CREATE TABLE IF NOT EXISTS public."${queueTable.name}" (
      ${keyColumnDefs},
      ${flagColumnDefs},
      status character varying(20) DEFAULT 'PENDING',
      "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "${queueTable.name}_pkey" PRIMARY KEY ("${queueTable.primaryKey.join('", "')}")
    )
  `
}

async function ensureQueueTable (localConnection) {
  await localConnection.query(buildQueueTableDdl(QUEUE_TABLE))

  for (const column of QUEUE_TABLE.flagColumns) {
    await localConnection.query(`
      ALTER TABLE public."${LOCAL_QUEUE_TABLE}"
      ADD COLUMN IF NOT EXISTS "${column}" boolean DEFAULT false
    `)
  }

  await localConnection.query(`
    CREATE INDEX IF NOT EXISTS "idx_${LOCAL_QUEUE_TABLE}_status"
      ON public."${LOCAL_QUEUE_TABLE}" USING btree (status ASC NULLS LAST)
  `)
}

async function sourceTableExists (localConnection) {
  const { rows } = await localConnection.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = $1',
    [SOURCE_TABLE.table]
  )
  return rows.length > 0
}

function isValidSchemeId (value) {
  const number = Number(value)
  return Number.isFinite(number) && Number.isInteger(number)
}

async function loadSourceKeysFromLocalPayments (localConnection) {
  const exists = await sourceTableExists(localConnection)
  if (!exists) {
    throw new Error(`Local public."${SOURCE_TABLE.table}" does not exist. Run pay-processing recovery first.`)
  }

  const { rows } = await localConnection.query(`
    SELECT DISTINCT "agreementNumber", frn, "schemeId"
    FROM public."${SOURCE_TABLE.table}"
    WHERE "schemeId" IS NOT NULL
      AND frn IS NOT NULL
      AND "agreementNumber" IS NOT NULL
  `)

  return rows
    .filter(row => isValidSchemeId(row.schemeId))
    .map(row => ({
      agreementNumber: row.agreementNumber ?? null,
      frn: row.frn ?? null,
      schemeId: Number(row.schemeId)
    }))
}

function buildTuplePlaceholders (tupleCount, tupleSize, startParam = 1) {
  let paramIndex = startParam
  const tuples = []
  for (let i = 0; i < tupleCount; i++) {
    const tuple = []
    for (let j = 0; j < tupleSize; j++) {
      tuple.push(`$${paramIndex++}`)
    }
    tuples.push(`(${tuple.join(', ')})`)
  }
  return { placeholders: tuples.join(', '), nextParam: paramIndex }
}

async function findMatchedParentRows (hostedConnection, sourceKeys) {
  if (sourceKeys.length === 0) {
    return []
  }

  const columns = PARENT_TABLE.matchColumns
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const matched = []

  for (let i = 0; i < sourceKeys.length; i += BATCH_SIZE) {
    const batch = sourceKeys.slice(i, i + BATCH_SIZE)
    const { placeholders } = buildTuplePlaceholders(batch.length, columns.length)
    const params = batch.flatMap(key => columns.map(c => key[c]))
    const { rows } = await hostedConnection.query(
      `SELECT "invoiceId", "agreementNumber", frn, "schemeId"
       FROM public."${PARENT_TABLE.name}"
       WHERE (${columnList}) IN (${placeholders})`,
      params
    )
    matched.push(...rows)
  }

  return matched
}

async function upsertMatchedQueue (localConnection, matchedRows) {
  let upserted = 0

  for (let i = 0; i < matchedRows.length; i += BATCH_SIZE) {
    const batch = matchedRows.slice(i, i + BATCH_SIZE)
    const params = []
    const placeholders = batch.map((row, index) => {
      const offset = index * 3
      params.push(
        row.frn ?? null,
        row.agreementNumber ?? null,
        row.schemeId
      )
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`
    }).join(', ')

    const result = await localConnection.query(
      `
      INSERT INTO public."${LOCAL_QUEUE_TABLE}" (
        frn, "agreementNumber", "schemeId"
      ) VALUES ${placeholders}
      ON CONFLICT (frn, "agreementNumber", "schemeId") DO UPDATE SET
        "updatedAt" = CURRENT_TIMESTAMP
      `,
      params
    )
    upserted += result.rowCount
  }

  return upserted
}

async function markParentFound (localConnection, matchedRows) {
  if (matchedRows.length === 0) {
    return 0
  }

  let updated = 0

  for (let i = 0; i < matchedRows.length; i += BATCH_SIZE) {
    const batch = matchedRows.slice(i, i + BATCH_SIZE)
    const params = []
    const placeholders = batch.map((row, index) => {
      const offset = index * 3
      params.push(row.frn ?? null, row.agreementNumber ?? null, row.schemeId)
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`
    }).join(', ')

    const result = await localConnection.query(
      `
      UPDATE public."${LOCAL_QUEUE_TABLE}"
      SET "${PARENT_TABLE.flagColumn}" = true,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE (frn, "agreementNumber", "schemeId") IN (${placeholders})
      `,
      params
    )
    updated += result.rowCount
  }

  return updated
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_injection_flag_probe' })
    await connection.close()
  } catch (error) {
    console.log('Local recovery database is not available; running create-local-db.js first...')
    await createLocalRecoveryDb()
  }
}

async function run () {
  const options = parseArgs()

  await ensureLocalRecoveryDb()

  let hostedConnection
  let localConnection

  try {
    console.log(`Connecting to hosted ${HOSTED_DATABASE} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_injection_flag_reader' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_injection_flag_writer' })

    await ensureQueueTable(localConnection)

    console.log(`Loading source keys from local pay-processing ${SOURCE_TABLE.table}...`)
    const sourceKeys = await loadSourceKeysFromLocalPayments(localConnection)
    console.log(`Loaded ${sourceKeys.length} source keys`)

    if (options.dryRun) {
      console.log(`Dry run: would check ${sourceKeys.length} source keys against hosted public."${PARENT_TABLE.name}"`)
      return
    }

    const matchedRows = await findMatchedParentRows(hostedConnection, sourceKeys)
    console.log(`Found ${matchedRows.length} matching rows in hosted ${PARENT_TABLE.name}`)

    const upserted = await upsertMatchedQueue(localConnection, matchedRows)
    console.log(`Upserted ${upserted} source keys into ${LOCAL_QUEUE_TABLE}`)

    const flagged = await markParentFound(localConnection, matchedRows)
    console.log(`Flagged ${flagged} queue entries as ${PARENT_TABLE.flagColumn}`)
  } catch (error) {
    console.error(`Failed to flag ${SERVICE_NAME} matches:`, error.message)
    process.exit(1)
  } finally {
    if (hostedConnection) {
      await hostedConnection.close()
    }
    if (localConnection) {
      await localConnection.close()
    }
  }
}

run().catch(error => {
  console.error(`Failed to flag ${SERVICE_NAME} matches:`, error.message)
  process.exit(1)
})
