const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { createLocalRecoveryDb } = require('../../create-local-db')
const config = require('../../config/pay-tracking')

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
      console.log('Usage: node tools/flag/flag-pay-tracking-matches.js [--dry-run]')
      console.log('Flags tracking reportData using sourceSystem mapped from schemeId, plus frn and agreementNumber from the local pay-processing paymentRequests table.')
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

function mapSourceSystem (schemeId, sourceSystemMap) {
  const key = Number(schemeId)
  if (!Number.isFinite(key)) {
    return null
  }
  return sourceSystemMap[key] ?? null
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

  const seen = new Map()
  rows.forEach(row => {
    const sourceSystem = mapSourceSystem(row.schemeId, config.SOURCE_SYSTEM_MAP)
    if (sourceSystem === null) {
      return
    }
    const tupleKey = `${sourceSystem}|${row.frn}|${row.agreementNumber}`
    if (!seen.has(tupleKey)) {
      seen.set(tupleKey, {
        agreementNumber: row.agreementNumber ?? null,
        frn: row.frn ?? null,
        schemeId: Number(row.schemeId),
        sourceSystem
      })
    }
  })

  return Array.from(seen.values())
}

async function createHostedTempKeysTable (hostedClient) {
  await hostedClient.query(`
    CREATE TEMP TABLE IF NOT EXISTS _tracking_source_keys (
      "sourceSystem" character varying(50) NOT NULL,
      frn bigint NOT NULL,
      "agreementNumber" character varying(50) NOT NULL,
      "schemeId" integer NOT NULL,
      PRIMARY KEY ("sourceSystem", frn, "agreementNumber")
    ) ON COMMIT DROP
  `)
}

async function insertKeysIntoHostedTempTable (hostedClient, sourceKeys) {
  let inserted = 0

  for (let i = 0; i < sourceKeys.length; i += BATCH_SIZE) {
    const batch = sourceKeys.slice(i, i + BATCH_SIZE)
    const params = []
    const placeholders = batch.map((key, index) => {
      const offset = index * 4
      params.push(
        key.sourceSystem,
        key.frn,
        key.agreementNumber,
        key.schemeId
      )
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
    }).join(', ')

    const result = await hostedClient.query(
      `
      INSERT INTO _tracking_source_keys (
        "sourceSystem", frn, "agreementNumber", "schemeId"
      ) VALUES ${placeholders}
      ON CONFLICT ("sourceSystem", frn, "agreementNumber") DO NOTHING
      `,
      params
    )
    inserted += result.rowCount
  }

  return inserted
}

async function findMatchedParentRows (hostedConnection, sourceKeys) {
  const hostedClient = await hostedConnection.pool.connect()

  try {
    await hostedClient.query('BEGIN')
    await createHostedTempKeysTable(hostedClient)
    const inserted = await insertKeysIntoHostedTempTable(hostedClient, sourceKeys)
    console.log(`  Loaded ${inserted} source keys into hosted temp table`)

    const { rows } = await hostedClient.query(`
      SELECT DISTINCT rd."reportDataId", rd."sourceSystem", rd.frn, rd."agreementNumber"
      FROM public."${PARENT_TABLE.name}" rd
      INNER JOIN _tracking_source_keys k
        ON rd."sourceSystem" = k."sourceSystem"
        AND rd.frn = k.frn
        AND rd."agreementNumber" = k."agreementNumber"
    `)

    await hostedClient.query('COMMIT')
    return rows
  } catch (error) {
    await hostedClient.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    hostedClient.release()
  }
}

async function upsertMatchedQueue (localConnection, matchedRows, sourceKeyMap) {
  let upserted = 0

  for (let i = 0; i < matchedRows.length; i += BATCH_SIZE) {
    const batch = matchedRows.slice(i, i + BATCH_SIZE)
    const params = []
    const placeholders = batch.map((row, index) => {
      const sourceKey = sourceKeyMap.get(`${row.sourceSystem}|${row.frn}|${row.agreementNumber}`)
      const offset = index * 4
      params.push(
        row.frn ?? null,
        row.agreementNumber ?? null,
        sourceKey?.schemeId ?? null,
        row.sourceSystem
      )
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
    }).join(', ')

    const result = await localConnection.query(
      `
      INSERT INTO public."${LOCAL_QUEUE_TABLE}" (
        frn, "agreementNumber", "schemeId", "sourceSystem"
      ) VALUES ${placeholders}
      ON CONFLICT (frn, "agreementNumber", "schemeId") DO UPDATE SET
        "sourceSystem" = EXCLUDED."sourceSystem",
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
      params.push(row.frn ?? null, row.agreementNumber ?? null, row.sourceSystem)
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`
    }).join(', ')

    const result = await localConnection.query(
      `
      UPDATE public."${LOCAL_QUEUE_TABLE}"
      SET "${PARENT_TABLE.flagColumn}" = true,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE (frn, "agreementNumber", "sourceSystem") IN (${placeholders})
      `,
      params
    )
    updated += result.rowCount
  }

  return updated
}

async function clearQueueTable (localConnection) {
  await localConnection.query(`TRUNCATE TABLE public."${LOCAL_QUEUE_TABLE}"`)
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_tracking_flag_probe' })
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
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_tracking_flag_reader' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_tracking_flag_writer' })

    await ensureQueueTable(localConnection)

    console.log(`Loading source keys from local pay-processing ${SOURCE_TABLE.table}...`)
    const sourceKeys = await loadSourceKeysFromLocalPayments(localConnection)
    console.log(`Loaded ${sourceKeys.length} distinct source keys`)

    if (options.dryRun) {
      console.log(`Dry run: would check ${sourceKeys.length} source keys against hosted public."${PARENT_TABLE.name}"`)
      return
    }

    console.log(`Clearing existing ${LOCAL_QUEUE_TABLE} before re-loading...`)
    await clearQueueTable(localConnection)

    const sourceKeyMap = new Map(sourceKeys.map(k => [`${k.sourceSystem}|${k.frn}|${k.agreementNumber}`, k]))
    const matchedRows = await findMatchedParentRows(hostedConnection, sourceKeys)
    const uniqueMatchedRows = Array.from(
      new Map(matchedRows.map(row => [`${row.sourceSystem}|${row.frn}|${row.agreementNumber}`, row])).values()
    )
    console.log(`Found ${matchedRows.length} matching rows in hosted ${PARENT_TABLE.name} (${uniqueMatchedRows.length} unique business keys)`)

    const upserted = await upsertMatchedQueue(localConnection, uniqueMatchedRows, sourceKeyMap)
    console.log(`Upserted ${upserted} source keys into ${LOCAL_QUEUE_TABLE}`)

    const flagged = await markParentFound(localConnection, uniqueMatchedRows)
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
