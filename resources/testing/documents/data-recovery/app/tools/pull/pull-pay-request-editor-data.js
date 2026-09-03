const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { ensureLocalTable } = require('../../services/schema-service')
const { fetchRowsBySingleKey, insertRows, filterExistingKeys } = require('../../services/pull-service')
const config = require('../../config/pay-request-editor')

const { HOSTED_DATABASE, LOCAL_QUEUE_TABLE, PARENT_TABLE, DEPENDENT_TABLES } = config
const KEY_BATCH_SIZE = 2000

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
      console.log('Usage: node tools/pull/pull-pay-request-editor-data.js [--dry-run] [--force] [--limit N]')
      console.log('--force: re-fetch rows even if they already exist locally')
      console.log('--limit N: process only the first N flagged natural keys (for testing)')
      process.exit(0)
    }
  }

  return options
}

async function getKeysToPull (localConnection, limit) {
  let sql = `SELECT frn, "agreementNumber", "schemeId"
     FROM public."${LOCAL_QUEUE_TABLE}"
     WHERE "${PARENT_TABLE.flagColumn}" = true
     ORDER BY frn, "agreementNumber", "schemeId"`

  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }

  const { rows } = await localConnection.query(sql)
  return rows
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

async function filterExistingParentKeys (localConnection, keys) {
  if (keys.length === 0) {
    return keys
  }

  const existing = new Set()
  const columns = PARENT_TABLE.matchColumns

  for (let i = 0; i < keys.length; i += KEY_BATCH_SIZE) {
    const batch = keys.slice(i, i + KEY_BATCH_SIZE)
    const columnList = columns.map(c => `"${c}"`).join(', ')
    const { placeholders } = buildTuplePlaceholders(batch.length, columns.length)
    const params = batch.flatMap(key => columns.map(c => key[c]))

    const { rows } = await localConnection.query(
      `SELECT ${columnList} FROM public."${PARENT_TABLE.localName}" WHERE (${columnList}) IN (${placeholders})`,
      params
    )

    rows.forEach(row => {
      existing.add(columns.map(c => String(row[c] ?? '')).join('|'))
    })
  }

  return keys.filter(key => !existing.has(columns.map(c => String(key[c] ?? '')).join('|')))
}

async function fetchParentRowsByKey (hostedConnection, keys) {
  if (keys.length === 0) {
    return []
  }

  const columns = PARENT_TABLE.matchColumns
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const allRows = []

  for (let i = 0; i < keys.length; i += KEY_BATCH_SIZE) {
    const batch = keys.slice(i, i + KEY_BATCH_SIZE)
    const { placeholders } = buildTuplePlaceholders(batch.length, columns.length)
    const params = batch.flatMap(key => columns.map(c => key[c]))

    const { rows } = await hostedConnection.query(
      `SELECT * FROM public."${PARENT_TABLE.name}" WHERE (${columnList}) IN (${placeholders})`,
      params
    )
    allRows.push(...rows)
  }

  return allRows
}

async function copyParentTable (hostedConnection, localConnection, options) {
  const keys = await getKeysToPull(localConnection, options.limit)
  console.log(`\n${PARENT_TABLE.name}: ${keys.length} natural keys flagged in queue`)

  if (keys.length === 0) {
    return 0
  }

  const { hostedColumns, localColumns } = await ensureLocalTable(localConnection, hostedConnection, PARENT_TABLE.localName, PARENT_TABLE.name)
  const insertColumns = localColumns.filter(c => hostedColumns.includes(c))

  if (options.dryRun) {
    console.log(`  Dry run: would fetch rows from hosted public."${PARENT_TABLE.name}" for these keys`)
    return 0
  }

  let keysToProcess = keys
  let skippedKeys = 0

  if (!options.force) {
    keysToProcess = await filterExistingParentKeys(localConnection, keys)
    skippedKeys = keys.length - keysToProcess.length

    if (keysToProcess.length === 0) {
      console.log(`  all ${keys.length} keys already local (skipped)`)
      console.log(`${PARENT_TABLE.name}: finished, 0 rows copied, ${skippedKeys} keys already local`)
      return 0
    }

    console.log(`  ${keysToProcess.length}/${keys.length} keys need fetching (${skippedKeys} already local)`)
  }

  const keyBatchCount = Math.ceil(keysToProcess.length / KEY_BATCH_SIZE)
  let totalRows = 0

  for (let i = 0; i < keysToProcess.length; i += KEY_BATCH_SIZE) {
    const keyBatch = keysToProcess.slice(i, i + KEY_BATCH_SIZE)
    const rows = await fetchParentRowsByKey(hostedConnection, keyBatch)

    if (rows.length > 0) {
      const inserted = await insertRows(localConnection, PARENT_TABLE.localName, insertColumns, [PARENT_TABLE.primaryKey], rows)
      totalRows += inserted
    }

    console.log(`  batch ${Math.floor(i / KEY_BATCH_SIZE) + 1}/${keyBatchCount}: ${keyBatch.length} keys fetched -> ${rows.length} rows (total inserted: ${totalRows})`)
  }

  console.log(`${PARENT_TABLE.name}: finished, ${totalRows} rows copied, ${skippedKeys} keys already local`)
  return totalRows
}

async function getLocalParentIds (localConnection, limit) {
  let sql = `
    SELECT DISTINCT pr."paymentRequestId"
    FROM public."${PARENT_TABLE.localName}" pr
    INNER JOIN public."${LOCAL_QUEUE_TABLE}" q
      ON pr.frn = q.frn
      AND pr."agreementNumber" = q."agreementNumber"
      AND pr."schemeId" = q."schemeId"
    WHERE q."${PARENT_TABLE.flagColumn}" = true
    ORDER BY pr."paymentRequestId"`
  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }
  const { rows } = await localConnection.query(sql)
  return rows.map(row => row.paymentRequestId)
}

async function updateQueueFlagsForDependentTable (localConnection, dependentConfig) {
  const result = await localConnection.query(
    `
    UPDATE public."${LOCAL_QUEUE_TABLE}" q
    SET "${dependentConfig.flagColumn}" = true,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."${PARENT_TABLE.localName}" pr
    JOIN public."${dependentConfig.localName}" dt
      ON dt."${dependentConfig.foreignKey}" = pr."paymentRequestId"
    WHERE q.frn = pr.frn
      AND q."agreementNumber" = pr."agreementNumber"
      AND q."schemeId" = pr."schemeId"
      AND q."${dependentConfig.flagColumn}" = false
    `
  )
  return result.rowCount
}

async function ensureDependentSchemas (hostedConnection, localConnection) {
  const schemas = {}
  for (const dependentConfig of DEPENDENT_TABLES) {
    const { hostedColumns, localColumns, primaryKey } = await ensureLocalTable(localConnection, hostedConnection, dependentConfig.localName, dependentConfig.name)
    schemas[dependentConfig.localName] = { hostedColumns, localColumns, primaryKey }
  }
  return schemas
}

async function getRemainingParentIds (localConnection, parentIds, dependentSchemas) {
  if (parentIds.length === 0) {
    return []
  }

  const remaining = new Set(parentIds)

  for (const dependentConfig of DEPENDENT_TABLES) {
    if (!dependentSchemas[dependentConfig.localName]) {
      continue
    }

    const existingKeys = await filterExistingKeys(
      localConnection,
      dependentConfig.localName,
      [dependentConfig.foreignKey],
      [...remaining].map(id => ({ [dependentConfig.foreignKey]: id })),
      { onProgress: (done, total) => console.log(`    checking ${dependentConfig.name}: ${done}/${total}`) }
    )
    const existingIds = new Set(existingKeys.map(key => key[dependentConfig.foreignKey]))
    for (const id of existingIds) {
      remaining.delete(id)
    }
  }

  return [...remaining].sort((a, b) => a - b)
}

async function copyDependentTables (hostedConnection, localConnection, options) {
  let parentIds = await getLocalParentIds(localConnection, options.limit)
  console.log(`\nFound ${parentIds.length} local ${PARENT_TABLE.localName} IDs to use for dependent-table lookup`)

  if (parentIds.length === 0) {
    console.log(`No ${PARENT_TABLE.name} pulled yet; skipping dependent tables`)
    return
  }

  console.log('Ensuring dependent tables exist locally...')
  const dependentSchemas = await ensureDependentSchemas(hostedConnection, localConnection)

  if (!options.force) {
    parentIds = await getRemainingParentIds(localConnection, parentIds, dependentSchemas)
    console.log(`  ${parentIds.length} parent IDs still need dependent data`)

    if (parentIds.length === 0) {
      console.log('All dependent data already local; skipping dependent tables')
      return
    }
  }

  for (const dependentConfig of DEPENDENT_TABLES) {
    console.log(`\nDependent table: ${dependentConfig.name}`)
    const { hostedColumns, localColumns, primaryKey } = dependentSchemas[dependentConfig.localName]
    const insertColumns = localColumns.filter(c => hostedColumns.includes(c))

    if (options.dryRun) {
      console.log(`  Dry run: would fetch rows from hosted public."${dependentConfig.name}" in batches of ${KEY_BATCH_SIZE}`)
      continue
    }

    const rows = await fetchRowsBySingleKey(hostedConnection, dependentConfig.name, hostedColumns, dependentConfig.foreignKey, parentIds)

    if (rows.length > 0) {
      const inserted = await insertRows(localConnection, dependentConfig.localName, insertColumns, primaryKey, rows)
      console.log(`  ${inserted} rows copied`)
    } else {
      console.log('  0 rows found in hosted')
    }

    const flaggedCount = await updateQueueFlagsForDependentTable(localConnection, dependentConfig)
    console.log(`${dependentConfig.name}: finished, ${flaggedCount} queue entries flagged`)
  }
}

async function run () {
  const options = parseArgs()

  let hostedConnection
  let localConnection

  try {
    console.log(`Connecting to hosted ${HOSTED_DATABASE} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_request_editor_data_pull' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_request_editor_data_pull' })

    await copyParentTable(hostedConnection, localConnection, options)
    await copyDependentTables(hostedConnection, localConnection, options)

    console.log('\nRequest-editor data pull complete.')
  } catch (error) {
    console.error('Failed to pull request-editor data:', error.message)
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
