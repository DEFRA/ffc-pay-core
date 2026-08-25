const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { ensureLocalTable } = require('../../services/schema-service')
const { fetchRowsByTuple, insertRows, filterExistingKeys } = require('../../services/pull-service')
const { runBatched, buildTuplePlaceholders } = require('../../services/batch-service')
const eventHub = require('../../config/event-hub')

const { SERVICE_NAME, HOSTED_DATABASE, LOCAL_QUEUE_TABLE, TABLES } = eventHub

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { dryRun: false, force: false, limit: 0 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--limit') {
      options.limit = Number(args[++i])
      if (!Number.isFinite(options.limit) || options.limit <= 0) {
        throw new Error('--limit must be a positive number')
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/pull/pull-event-hub-data.js [--dry-run] [--force] [--limit N]')
      console.log('Pulls event-hub rows flagged in the local verification queue.')
      console.log('--force: re-fetch rows even if they already exist locally')
      console.log('--limit N: process only the first N flagged source keys (for testing)')
      process.exit(0)
    }
  }

  return options
}

function keyOf (key, sourceColumns) {
  return sourceColumns.map(sourceCol => key[sourceCol]).join('|')
}

function getKeyColumns (tableConfig) {
  return Object.keys(tableConfig.matchFields)
}

async function getSourceKeysToPull (localConnection, tableConfig, limit) {
  const sourceColumns = getKeyColumns(tableConfig)
  const selectList = sourceColumns.map(c => `"${c}"`).join(', ')
  let sql = `SELECT DISTINCT ${selectList}
     FROM public."${LOCAL_QUEUE_TABLE}"
     WHERE "${tableConfig.flagColumn}" = true
     ORDER BY ${selectList}`

  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }

  const { rows } = await localConnection.query(sql)
  return rows
}

function buildTupleColumns (tableConfig) {
  const sourceColumns = getKeyColumns(tableConfig)
  const isJson = !!tableConfig.jsonColumn

  return sourceColumns.map(sourceCol => {
    const targetField = tableConfig.matchFields[sourceCol]
    if (!isJson) {
      return { name: sourceCol, expression: `"${targetField}"` }
    }
    return { name: sourceCol, expression: `${tableConfig.jsonColumn}->>'${targetField}'` }
  })
}

function normaliseSourceKey (sourceCol, value) {
  if (value === null || value === undefined) {
    return null
  }
  if (sourceCol === 'frn') {
    return String(value)
  }
  if (sourceCol === 'schemeId') {
    return String(value)
  }
  return value
}

async function filterExistingSourceKeys (localConnection, tableConfig, sourceKeys) {
  if (sourceKeys.length === 0) {
    return sourceKeys
  }

  const tupleColumns = buildTupleColumns(tableConfig)
  const sourceColumns = getKeyColumns(tableConfig)
  const existing = new Set()

  const rows = await filterExistingKeys(
    localConnection,
    tableConfig.localName,
    tupleColumns,
    sourceKeys,
    { maxParams: 5000 }
  )

  rows.forEach(row => existing.add(keyOf(row, sourceColumns)))
  return sourceKeys.filter(key => !existing.has(keyOf(key, sourceColumns)))
}

async function createPullKeysTempTable (hostedClient, sourceKeys, entries) {
  await hostedClient.query('DROP TABLE IF EXISTS _event_hub_pull_keys')
  const columnDefs = entries
    .map(([sourceCol]) => `"${sourceCol}" text`)
    .join(', ')

  await hostedClient.query(`
    CREATE TEMP TABLE _event_hub_pull_keys (
      ${columnDefs}
    ) ON COMMIT PRESERVE ROWS
  `)

  const batchSize = 1000
  for (let i = 0; i < sourceKeys.length; i += batchSize) {
    const batch = sourceKeys.slice(i, i + batchSize)
    const params = []
    const placeholders = batch.map((key, index) => {
      const offset = index * entries.length
      const tuple = entries.map(([sourceCol], colIndex) => {
        params.push(key[sourceCol])
        return `$${offset + colIndex + 1}`
      })
      return `(${tuple.join(', ')})`
    }).join(', ')

    await hostedClient.query(
      `INSERT INTO _event_hub_pull_keys VALUES ${placeholders}`,
      params
    )
  }

  await hostedClient.query('ANALYZE _event_hub_pull_keys')
}

function buildPullJoinCondition (tableConfig) {
  const isDirectColumn = tableConfig.matchType === 'direct-columns'
  const jsonColumn = tableConfig.jsonColumn

  return Object.entries(tableConfig.matchFields)
    .map(([sourceCol, targetField]) => {
      if (isDirectColumn) {
        return `t."${targetField}"::text = k."${sourceCol}"`
      }
      return `t.${jsonColumn}->>'${targetField}' = k."${sourceCol}"`
    })
    .join(' AND ')
}

async function fetchMatchedRows (hostedConnection, tableConfig, sourceKeys, hostedColumns) {
  if (sourceKeys.length === 0) {
    return []
  }

  const hostedClient = await hostedConnection.pool.connect()

  try {
    await hostedClient.query('BEGIN')

    const entries = Object.entries(tableConfig.matchFields)
    await createPullKeysTempTable(hostedClient, sourceKeys, entries)

    await hostedClient.query('SET LOCAL enable_nestloop = off')
    await hostedClient.query('SET LOCAL work_mem = \'256MB\'')
    await hostedClient.query('SET LOCAL statement_timeout = \'600000\'')

    const joinCondition = buildPullJoinCondition(tableConfig)
    const columnList = hostedColumns.map(c => `t."${c}"`).join(', ')

    const { rows } = await hostedClient.query(`
      SELECT DISTINCT ${columnList}
      FROM public."${tableConfig.name}" t
      JOIN _event_hub_pull_keys k
        ON ${joinCondition}
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

async function copyTable (hostedConnection, localConnection, tableConfig, options) {
  const sourceKeys = await getSourceKeysToPull(localConnection, tableConfig, options.limit)
  console.log(`\n${tableConfig.name}: ${sourceKeys.length} source keys flagged in queue`)

  if (sourceKeys.length > 0) {
    console.log(`  Sample source key: ${JSON.stringify(sourceKeys[0])}`)
    console.log(`  Tuple columns: ${JSON.stringify(buildTupleColumns(tableConfig).map(c => ({ name: c.name, expression: c.expression })))}`)
  }

  if (sourceKeys.length === 0) {
    return 0
  }

  const { hostedColumns, localColumns, primaryKey } = await ensureLocalTable(localConnection, hostedConnection, tableConfig.localName, tableConfig.name)
  const insertColumns = localColumns.filter(c => hostedColumns.includes(c))

  const localCountResult = await localConnection.query(`SELECT COUNT(*)::int AS count FROM public."${tableConfig.localName}"`)
  const localRowCount = Number(localCountResult.rows[0].count)
  console.log(`  Local ${tableConfig.localName} has ${localRowCount} rows`)

  if (options.dryRun) {
    console.log(`  Dry run: would fetch rows from hosted public."${tableConfig.name}"`)
    return 0
  }

  const keysToFetch = options.force || localRowCount === 0
    ? sourceKeys
    : await filterExistingSourceKeys(localConnection, tableConfig, sourceKeys)
  const skippedCount = sourceKeys.length - keysToFetch.length
  console.log(`  ${keysToFetch.length}/${sourceKeys.length} keys to fetch (${skippedCount} skipped)`)

  if (keysToFetch.length === 0) {
    console.log(`  all ${sourceKeys.length} keys already local (skipped)`)
    console.log(`${tableConfig.name}: finished, 0 rows copied`)
    return 0
  }

  console.log(`  ${keysToFetch.length}/${sourceKeys.length} keys need fetching (${skippedCount} already local)`)

  const rows = await fetchMatchedRows(hostedConnection, tableConfig, keysToFetch, hostedColumns)
  console.log(`  Fetched ${rows.length} rows from hosted ${tableConfig.name}`)
  if (rows.length > 0) {
    console.log(`  Sample fetched row keys: ${JSON.stringify(Object.fromEntries(getKeyColumns(tableConfig).map(c => [c, rows[0][c] ?? rows[0][tableConfig.matchFields[c]]])))}`)
  }

  let totalRows = 0
  if (rows.length > 0) {
    totalRows = await insertRows(localConnection, tableConfig.localName, insertColumns, primaryKey, rows)
  }

  console.log(`${tableConfig.name}: finished, ${totalRows} rows copied`)
  return totalRows
}

async function run () {
  const options = parseArgs()

  let hostedConnection
  let localConnection

  try {
    console.log(`Connecting to hosted ${SERVICE_NAME} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_event_hub_data_pull' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_event_hub_data_pull' })

    for (const tableConfig of TABLES) {
      await copyTable(hostedConnection, localConnection, tableConfig, options)
    }

    console.log('\nEvent-hub data pull complete.')
  } catch (error) {
    console.error('Failed to pull event-hub data:', error.message)
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

run()
