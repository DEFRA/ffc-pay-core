const { createRecoveryConnection } = require('../../database/recovery-db-connection')
const { createLocalConnection } = require('../../database/local-db-connection')
const { ensureLocalTable } = require('../../services/schema-service')
const { fetchRowsBySingleKey, insertRows, filterExistingKeys } = require('../../services/pull-service')
const payProcessing = require('../../config/pay-processing')

const { HOSTED_DATABASE, LOCAL_QUEUE_TABLE, TABLES: DEFAULT_TABLES, DEPENDENT_TABLES } = payProcessing
const ID_BATCH_SIZE = 2000

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { tables: [], dryRun: false, force: false, limit: 0 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--table' || arg === '-t') {
      options.tables.push(args[++i])
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--limit') {
      options.limit = Number(args[++i])
      if (!Number.isFinite(options.limit) || options.limit <= 0) {
        throw new Error('--limit must be a positive number')
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/pull/pull-pay-processing-data.js [--table <tableName>] [--dry-run] [--force] [--limit N]')
      console.log('Tables: invoiceLines, completedPaymentRequests, paymentRequests, schedule')
      console.log('--force: re-fetch rows even if they already exist locally')
      console.log('--limit N: process only the first N flagged payment request IDs (for testing)')
      process.exit(0)
    }
  }

  return options
}

function getRequestedTables (requested) {
  if (requested.length === 0) {
    return DEFAULT_TABLES
  }

  const invalid = requested.filter(name => !DEFAULT_TABLES.some(t => t.name === name))
  if (invalid.length > 0) {
    throw new Error(`Unknown table(s): ${invalid.join(', ')}. Allowed: ${DEFAULT_TABLES.map(t => t.name).join(', ')}`)
  }

  return DEFAULT_TABLES.filter(t => requested.includes(t.name))
}

async function getIdsToPull (localConnection, flagColumn, limit) {
  let sql = `SELECT "paymentRequestId"
     FROM public."${LOCAL_QUEUE_TABLE}"
     WHERE "${flagColumn}" = true
     ORDER BY "paymentRequestId"`

  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }

  const { rows } = await localConnection.query(sql)
  return rows.map(row => row.paymentRequestId)
}

async function copyTable (hostedConnection, localConnection, tableConfig, hostedColumns, localColumns, options) {
  const ids = await getIdsToPull(localConnection, tableConfig.flagColumn, options.limit)
  console.log(`\n${tableConfig.name}: ${ids.length} payment request IDs flagged in queue`)

  if (ids.length === 0) {
    return 0
  }

  if (options.dryRun) {
    console.log(`  Dry run: would fetch rows from hosted public."${tableConfig.name}" for these IDs in batches of ${ID_BATCH_SIZE}`)
    return 0
  }

  const insertColumns = localColumns.filter(c => hostedColumns.includes(c))
  let idsToProcess = ids
  let skippedIds = 0

  if (!options.force) {
    const missing = await filterExistingKeys(
      localConnection,
      tableConfig.localName,
      ['paymentRequestId'],
      ids.map(id => ({ paymentRequestId: id }))
    )
    idsToProcess = missing.map(key => key.paymentRequestId)
    skippedIds = ids.length - idsToProcess.length

    if (idsToProcess.length === 0) {
      console.log(`  all ${ids.length} IDs already local (skipped)`)
      console.log(`${tableConfig.name}: finished, 0 rows copied, ${skippedIds} IDs already local`)
      return 0
    }

    console.log(`  ${idsToProcess.length}/${ids.length} IDs need fetching (${skippedIds} already local)`)
  }

  const idBatchCount = Math.ceil(idsToProcess.length / ID_BATCH_SIZE)
  let totalRows = 0

  for (let i = 0; i < idsToProcess.length; i += ID_BATCH_SIZE) {
    const idBatch = idsToProcess.slice(i, i + ID_BATCH_SIZE)
    const rows = await fetchRowsBySingleKey(hostedConnection, tableConfig.name, hostedColumns, 'paymentRequestId', idBatch)

    if (rows.length > 0) {
      const inserted = await insertRows(localConnection, tableConfig.localName, insertColumns, [tableConfig.primaryKey], rows)
      totalRows += inserted
    }

    console.log(`  batch ${Math.floor(i / ID_BATCH_SIZE) + 1}/${idBatchCount}: ${idBatch.length} IDs fetched -> ${rows.length} rows (total inserted: ${totalRows})`)
  }

  console.log(`${tableConfig.name}: finished, ${totalRows} rows copied, ${skippedIds} IDs already local`)
  return totalRows
}

async function getLocalCompletedPaymentRequestIds (localConnection, limit) {
  const parentTable = DEFAULT_TABLES.find(t => t.name === 'completedPaymentRequests')
  let sql = `SELECT DISTINCT "completedPaymentRequestId" FROM public."${parentTable.localName}" ORDER BY "completedPaymentRequestId"`
  if (limit > 0) {
    sql += ` LIMIT ${limit}`
  }
  const { rows } = await localConnection.query(sql)
  return rows.map(row => row.completedPaymentRequestId)
}

async function updateQueueFlagsForDependentTable (localConnection, dependentConfig) {
  const parentTable = DEFAULT_TABLES.find(t => t.name === 'completedPaymentRequests')
  const result = await localConnection.query(
    `
    UPDATE public."${LOCAL_QUEUE_TABLE}" q
    SET "${dependentConfig.flagColumn}" = true,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."${parentTable.localName}" cpr
    JOIN public."${dependentConfig.localName}" dt
      ON dt."${dependentConfig.foreignKey}" = cpr."completedPaymentRequestId"
    WHERE q."paymentRequestId" = cpr."paymentRequestId"
      AND q."${dependentConfig.flagColumn}" = false
    `
  )
  return result.rowCount
}

async function getRemainingParentIds (localConnection, parentIds, dependentSchemas) {
  if (parentIds.length === 0) {
    return []
  }

  let remaining = new Set(parentIds)

  for (const dependentConfig of DEPENDENT_TABLES) {
    if (!dependentSchemas[dependentConfig.localName]) {
      continue
    }

    const missingKeys = await filterExistingKeys(
      localConnection,
      dependentConfig.localName,
      [dependentConfig.foreignKey],
      [...remaining].map(id => ({ [dependentConfig.foreignKey]: id })),
      { onProgress: (done, total) => console.log(`    checking ${dependentConfig.name}: ${done}/${total}`) }
    )
    const missingIds = new Set(missingKeys.map(key => key[dependentConfig.foreignKey]))

    // Keep only parent IDs that still need dependent data
    remaining = new Set([...remaining].filter(id => missingIds.has(id)))
  }

  return [...remaining].sort((a, b) => a - b)
}

async function ensureDependentSchemas (hostedConnection, localConnection) {
  const schemas = {}
  for (const dependentConfig of DEPENDENT_TABLES) {
    const { hostedColumns, localColumns, primaryKey } = await ensureLocalTable(localConnection, hostedConnection, dependentConfig.localName, dependentConfig.name)
    schemas[dependentConfig.localName] = { hostedColumns, localColumns, primaryKey }
  }
  return schemas
}

async function copyDependentTables (hostedConnection, localConnection, options) {
  let parentIds = await getLocalCompletedPaymentRequestIds(localConnection, options.limit)
  console.log(`\nFound ${parentIds.length} local completedPaymentRequestIds to use for dependent-table lookup`)

  if (parentIds.length === 0) {
    console.log('No completedPaymentRequests pulled yet; skipping dependent tables')
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
      console.log(`  Dry run: would fetch rows from hosted public."${dependentConfig.name}" in batches of ${ID_BATCH_SIZE}`)
      continue
    }

    const rows = await fetchRowsBySingleKey(
      hostedConnection,
      dependentConfig.name,
      hostedColumns,
      dependentConfig.foreignKey,
      parentIds,
      { onProgress: (done, total) => console.log(`    fetching ${dependentConfig.name}: ${done}/${total}`) }
    )

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
  const tables = getRequestedTables(options.tables)

  let hostedConnection
  let localConnection

  try {
    console.log(`Connecting to hosted ${HOSTED_DATABASE} database (read-only)...`)
    hostedConnection = await createRecoveryConnection({ database: HOSTED_DATABASE, applicationName: 'ffc_pay_recovery_data_pull' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_data_pull' })

    for (const tableConfig of tables) {
      const { hostedColumns, localColumns } = await ensureLocalTable(localConnection, hostedConnection, tableConfig.localName, tableConfig.name)
      await copyTable(hostedConnection, localConnection, tableConfig, hostedColumns, localColumns, options)
    }

    await copyDependentTables(hostedConnection, localConnection, options)

    console.log('\nData pull complete.')
  } catch (error) {
    console.error('Failed to pull recovery data:', error.message)
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
