const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { createLocalRecoveryDb } = require('../../create-local-db')
const eventHub = require('../../config/event-hub')

const { SERVICE_NAME, HOSTED_DATABASE, LOCAL_QUEUE_TABLE, QUEUE_TABLE, SOURCE_TABLE, AGREEMENTS_TABLE, BATCH_SIZE, TABLES } = eventHub

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/flag/flag-event-hub-matches.js [--dry-run]')
      console.log('Flags event-hub matches using keys derived from the local pay-processing paymentRequests table.')
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

async function getExistingFlagColumns (localConnection) {
  const { rows } = await localConnection.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND data_type = 'boolean'
      AND column_name LIKE 'foundIn%'
  `, [LOCAL_QUEUE_TABLE])
  return rows.map(r => r.column_name)
}

async function ensureQueueTable (localConnection) {
  await localConnection.query(buildQueueTableDdl(QUEUE_TABLE))

  const existingFlagColumns = await getExistingFlagColumns(localConnection)
  const configuredFlagColumns = new Set(QUEUE_TABLE.flagColumns)

  for (const column of QUEUE_TABLE.flagColumns) {
    await localConnection.query(`
      ALTER TABLE public."${LOCAL_QUEUE_TABLE}"
      ADD COLUMN IF NOT EXISTS "${column}" boolean DEFAULT false
    `)
  }

  for (const column of existingFlagColumns) {
    if (!configuredFlagColumns.has(column)) {
      await localConnection.query(`
        ALTER TABLE public."${LOCAL_QUEUE_TABLE}"
        DROP COLUMN IF EXISTS "${column}"
      `)
      console.log(`  Dropped obsolete flag column "${column}" from ${LOCAL_QUEUE_TABLE}`)
    }
  }

  await localConnection.query(`
    CREATE INDEX IF NOT EXISTS "idx_${LOCAL_QUEUE_TABLE}_status"
      ON public."${LOCAL_QUEUE_TABLE}" USING btree (status ASC NULLS LAST)
  `)
}

async function tableExists (localConnection, tableName) {
  const { rows } = await localConnection.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = \'public\' AND table_name = $1',
    [tableName]
  )
  return rows.length > 0
}

async function agreementsTableHasRows (localConnection) {
  const { rows } = await localConnection.query(
    `SELECT COUNT(*)::int AS count FROM public."${AGREEMENTS_TABLE.table}"`
  )
  return rows[0].count > 0
}

function isValidSchemeId (value) {
  const number = Number(value)
  return Number.isFinite(number) && Number.isInteger(number)
}

async function loadSourceKeysFromLocalPayments (localConnection, dryRun) {
  const agreementsExists = await tableExists(localConnection, AGREEMENTS_TABLE.table)
  const useAgreements = agreementsExists && await agreementsTableHasRows(localConnection)

  if (useAgreements) {
    console.log(`  Using ${AGREEMENTS_TABLE.table} as source of business keys`)
  } else {
    console.log(`  Using ${SOURCE_TABLE.table} as source of business keys`)
  }

  const sourceTable = useAgreements ? AGREEMENTS_TABLE : SOURCE_TABLE
  const exists = await tableExists(localConnection, sourceTable.table)
  if (!exists) {
    if (dryRun) {
      console.log(`  Dry run: source table public."${sourceTable.table}" does not exist yet`)
      return []
    }
    throw new Error(`Local public."${sourceTable.table}" does not exist.`)
  }

  const distinctClause = useAgreements ? '' : 'DISTINCT '
  const { rows } = await localConnection.query(`
    SELECT ${distinctClause}frn, "agreementNumber", "schemeId"
    FROM public."${sourceTable.table}"
    WHERE "schemeId" IS NOT NULL
      AND frn IS NOT NULL
      AND "agreementNumber" IS NOT NULL
  `)

  if (rows.length === 0) {
    if (dryRun) {
      console.log(`  Dry run: source table public."${sourceTable.table}" exists but is empty`)
      return []
    }
    throw new Error(`No rows found in local public."${sourceTable.table}".`)
  }

  return rows
    .filter(row => isValidSchemeId(row.schemeId))
    .map(row => ({
      frn: row.frn ?? null,
      agreementNumber: row.agreementNumber ?? null,
      schemeId: row.schemeId ?? null
    }))
}

async function upsertSourceKeys (localConnection, sourceKeys) {
  let upserted = 0

  for (let i = 0; i < sourceKeys.length; i += BATCH_SIZE) {
    const batch = sourceKeys.slice(i, i + BATCH_SIZE)
    const params = []
    const placeholders = batch.map((key, index) => {
      const offset = index * 3
      params.push(key.frn, key.agreementNumber, key.schemeId)
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

async function createSourceKeysTempTable (connection, sourceKeys, tableName, preserveRows) {
  await connection.query(`DROP TABLE IF EXISTS ${tableName}`)
  await connection.query(`
    CREATE TEMP TABLE ${tableName} (
      frn bigint NOT NULL,
      "agreementNumber" text,
      "schemeId" integer NOT NULL,
      PRIMARY KEY (frn, "schemeId")
    ) ${preserveRows ? 'ON COMMIT PRESERVE ROWS' : 'ON COMMIT DROP'}
  `)

  const batchSize = 5000
  for (let i = 0; i < sourceKeys.length; i += batchSize) {
    const batch = sourceKeys.slice(i, i + batchSize)
    const params = []
    const placeholders = batch.map((key, index) => {
      const offset = index * 3
      params.push(key.frn, key.agreementNumber, key.schemeId)
      return `($${offset + 1}::bigint, $${offset + 2}::text, $${offset + 3})`
    }).join(', ')

    await connection.query(
      `INSERT INTO ${tableName} VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      params
    )
  }
}

async function createHostedSourceKeysTempTable (hostedConnection, sourceKeys) {
  await createSourceKeysTempTable(hostedConnection, sourceKeys, '_event_hub_source_keys', true)
  await hostedConnection.query('ANALYZE _event_hub_source_keys')
  console.log(`  Loaded ${sourceKeys.length} source keys into hosted temp table`)
}

async function createLocalSourceKeysTempTable (localConnection, sourceKeys) {
  await createSourceKeysTempTable(localConnection, sourceKeys, '_event_hub_source_keys_local', false)
  console.log(`  Loaded ${sourceKeys.length} source keys into local temp table`)
}

function getMatchFieldEntries (tableConfig) {
  return Object.entries(tableConfig.matchFields)
}

function buildJoinCondition (sourceColumn, targetExpression, isDirectColumn) {
  if (sourceColumn === 'schemeId') {
    return `s."${sourceColumn}"${isDirectColumn ? '' : '::text'} = ${targetExpression}`
  }
  if (sourceColumn === 'frn') {
    return `s."${sourceColumn}" = (${targetExpression})::bigint`
  }
  return `s."${sourceColumn}" = ${targetExpression}`
}

function buildSelectExpression (sourceColumn, targetExpression, isDirectColumn) {
  if (sourceColumn === 'frn') {
    return `(${targetExpression})::bigint AS "${sourceColumn}"`
  }
  return `${targetExpression} AS "${sourceColumn}"`
}

async function findMatchedTuplesForTable (hostedConnection, tableConfig) {
  const isDirectColumn = tableConfig.matchType === 'direct-columns'
  const jsonColumn = isDirectColumn ? null : tableConfig.jsonColumn
  const entries = getMatchFieldEntries(tableConfig)

  const countResult = await hostedConnection.query(
    `SELECT COUNT(*)::int AS count FROM public."${tableConfig.name}"`
  )
  console.log(`  ${tableConfig.name} has ${Number(countResult.rows[0].count).toLocaleString()} rows`)

  if (entries.length === 0) {
    console.log(`    ${tableConfig.name}: no match fields configured`)
    return []
  }

  const joinConditions = entries
    .map(([sourceColumn, targetColumn]) => {
      const targetExpression = isDirectColumn
        ? `t."${targetColumn}"`
        : `t.${jsonColumn}->>'${targetColumn}'`
      return buildJoinCondition(sourceColumn, targetExpression, isDirectColumn)
    })
    .join(' AND ')

  const selectAliases = entries
    .map(([sourceColumn, targetColumn]) => {
      const targetExpression = isDirectColumn
        ? `t."${targetColumn}"`
        : `t.${jsonColumn}->>'${targetColumn}'`
      return buildSelectExpression(sourceColumn, targetExpression, isDirectColumn)
    })
    .join(', ')

  const frnField = entries.find(([sourceColumn]) => sourceColumn === 'frn')
  const frnFilter = !isDirectColumn && frnField
    ? `WHERE t.${jsonColumn}->>'${frnField[1]}' ~ '^\\d+$'`
    : ''

  const matchSql = `
    SELECT DISTINCT ${selectAliases}
    FROM public."${tableConfig.name}" t
    JOIN _event_hub_source_keys s
      ON ${joinConditions}
    ${frnFilter}
  `

  await hostedConnection.query('SET LOCAL enable_nestloop = off')
  await hostedConnection.query('SET LOCAL work_mem = \'256MB\'')
  await hostedConnection.query('SET LOCAL statement_timeout = \'600000\'')

  console.log(`    ${tableConfig.name}: running match query...`)
  const explainResult = await hostedConnection.query(`EXPLAIN ${matchSql}`)
  for (const line of explainResult.rows.map(r => r['QUERY PLAN'])) {
    console.log(`      ${line}`)
  }

  const { rows } = await hostedConnection.query(matchSql)
  console.log(`    ${tableConfig.name}: matched ${rows.length}`)

  return rows
}

function buildColumnExpression (sourceColumn) {
  if (sourceColumn === 'frn') {
    return `"${sourceColumn}"`
  }
  return `"${sourceColumn}"::text`
}

function buildTypedPlaceholder (sourceColumn, paramIndex) {
  if (sourceColumn === 'frn') {
    return `$${paramIndex}::bigint`
  }
  return `$${paramIndex}::text`
}

function buildTuplePlaceholders (tupleCount, entries, startParam = 1) {
  let paramIndex = startParam
  const tuples = []
  for (let i = 0; i < tupleCount; i++) {
    const tuple = entries.map(([sourceColumn]) => buildTypedPlaceholder(sourceColumn, paramIndex++))
    tuples.push(`(${tuple.join(', ')})`)
  }
  return { placeholders: tuples.join(', '), nextParam: paramIndex }
}

function normaliseMatchValue (sourceColumn, value) {
  if (sourceColumn === 'frn') {
    const stringValue = value === null || value === undefined ? '' : String(value).trim()
    return stringValue === '' ? null : stringValue
  }
  return String(value ?? '')
}

async function updateQueueForMatchedTuples (localConnection, tableConfig, matchedTuples) {
  const entries = getMatchFieldEntries(tableConfig)
  if (entries.length === 0 || matchedTuples.length === 0) {
    return 0
  }

  let updated = 0

  for (let i = 0; i < matchedTuples.length; i += BATCH_SIZE) {
    const batch = matchedTuples.slice(i, i + BATCH_SIZE)
    const queueColumns = entries.map(([sourceColumn]) => buildColumnExpression(sourceColumn)).join(', ')
    const { placeholders } = buildTuplePlaceholders(batch.length, entries, 1)
    const params = batch.flatMap(row => {
      const lowerRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]))
      return entries.map(([sourceColumn]) => normaliseMatchValue(sourceColumn, lowerRow[sourceColumn.toLowerCase()]))
    })

    const result = await localConnection.query(
      `
      UPDATE public."${LOCAL_QUEUE_TABLE}"
      SET "${tableConfig.flagColumn}" = true,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE (${queueColumns}) IN (${placeholders})
      `,
      params
    )
    updated += result.rowCount
  }

  console.log(`  Flagged ${updated} queue entries for ${tableConfig.flagColumn}`)
  return updated
}

async function flagTable (hostedConnection, localConnection, tableConfig, dryRun) {
  console.log(`\nFlagging ${tableConfig.name}...`)

  if (dryRun) {
    console.log(`  Dry run: would check hosted public."${tableConfig.name}"`)
    return 0
  }

  const matchedTuples = await findMatchedTuplesForTable(hostedConnection, tableConfig)
  console.log(`  Found ${matchedTuples.length} distinct matching tuples in hosted ${tableConfig.name}`)

  return updateQueueForMatchedTuples(localConnection, tableConfig, matchedTuples)
}

async function getSummary (localConnection) {
  const { rows } = await localConnection.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE "foundInWarnings") AS warnings,
      COUNT(*) FILTER (WHERE "foundInPayments") AS payments,
      COUNT(*) FILTER (WHERE "foundInHolds") AS holds,
      COUNT(*) FILTER (WHERE "foundInPaymentBatchEvents") AS payment_batch_events,
      COUNT(*) FILTER (WHERE "foundInPaymentFrnEvents") AS payment_frn_events,
      COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
      COUNT(*) FILTER (WHERE status = 'VERIFIED') AS verified,
      COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress
    FROM public."${LOCAL_QUEUE_TABLE}"
  `)
  return rows[0]
}

async function ensureLocalRecoveryDb () {
  try {
    const connection = await createLocalConnection({ applicationName: 'ffc_pay_event_hub_flag_probe' })
    await connection.close()
    console.log('Local recovery database is already running.')
  } catch (error) {
    console.log('Local recovery database is not available; running create-local-db.js first...')
    await createLocalRecoveryDb()
  }
}

async function run () {
  const options = parseArgs()

  let hostedConnection
  let hostedClient
  let localConnection
  let localClient

  try {
    await ensureLocalRecoveryDb()

    console.log(`Connecting to hosted ${SERVICE_NAME} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_event_hub_flag_reader' })
    hostedClient = await hostedConnection.pool.connect()

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_event_hub_flag_writer' })

    localClient = await localConnection.pool.connect()
    await localClient.query('BEGIN')

    await ensureQueueTable(localClient)

    console.log('\nLoading source keys from local pay-processing paymentRequests...')
    const sourceKeys = await loadSourceKeysFromLocalPayments(localClient, options.dryRun)
    console.log(`Loaded ${sourceKeys.length} source keys`)

    if (sourceKeys.length > 0) {
      const upserted = await upsertSourceKeys(localClient, sourceKeys)
      console.log(`Upserted ${upserted} source keys into ${LOCAL_QUEUE_TABLE}`)
    } else if (options.dryRun) {
      console.log('  Dry run: no source keys to upsert')
    }

    if (sourceKeys.length > 0 && !options.dryRun) {
      await createHostedSourceKeysTempTable(hostedClient, sourceKeys)
      await createLocalSourceKeysTempTable(localClient, sourceKeys)
    }

    for (const tableConfig of TABLES) {
      await flagTable(hostedClient, localClient, tableConfig, options.dryRun)
    }

    const summary = await getSummary(localClient)
    await localClient.query('COMMIT')

    console.log('\nEvent-hub verification queue summary:')
    console.log(`  Total queued:        ${summary.total}`)
    console.log(`  In warnings:         ${summary.warnings}`)
    console.log(`  In payments:         ${summary.payments}`)
    console.log(`  In holds:            ${summary.holds}`)
    console.log(`  In paymentBatchEvents: ${summary.payment_batch_events}`)
    console.log(`  In paymentFrnEvents: ${summary.payment_frn_events}`)
    console.log(`  PENDING:             ${summary.pending}`)
    console.log(`  VERIFIED:            ${summary.verified}`)
    console.log(`  REJECTED:            ${summary.rejected}`)
    console.log(`  IN_PROGRESS:         ${summary.in_progress}`)
  } catch (error) {
    if (localClient) {
      await localClient.query('ROLLBACK').catch(() => {})
    }
    console.error('Failed to flag event-hub matches:', error.message)
    process.exit(1)
  } finally {
    if (localClient) {
      localClient.release()
    }
    if (hostedClient) {
      hostedClient.release()
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
