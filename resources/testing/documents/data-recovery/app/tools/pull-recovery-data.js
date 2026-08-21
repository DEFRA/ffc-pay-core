const { createRecoveryConnection } = require('../database/recovery-db-connection')
const { createLocalConnection } = require('../database/local-db-connection')

const DEFAULT_TABLES = [
  { name: 'invoiceLines', flagColumn: 'foundInInvoiceLines', primaryKey: 'invoiceLineId' },
  { name: 'completedPaymentRequests', flagColumn: 'foundInCompletedPaymentRequests', primaryKey: 'completedPaymentRequestId' },
  { name: 'schedule', flagColumn: 'foundInSchedule', primaryKey: 'scheduleId' }
]

const DEPENDENT_TABLES = [
  { name: 'completedInvoiceLines', foreignKey: 'completedPaymentRequestId', flagColumn: 'foundInCompletedInvoiceLines' },
  { name: 'outbox', foreignKey: 'completedPaymentRequestId', flagColumn: 'foundInOutbox' }
]

const ID_BATCH_SIZE = 2000
const MAX_PARAMS = 30000

function parseArgs () {
  const args = process.argv.slice(2)
  const options = { tables: [], dryRun: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--table' || arg === '-t') {
      options.tables.push(args[++i])
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/pull-recovery-data.js [--table <tableName>] [--dry-run]')
      console.log('Tables: invoiceLines, completedPaymentRequests, schedule')
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

async function getTableColumns (localConnection, tableName) {
  const { rows } = await localConnection.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  )

  if (rows.length === 0) {
    throw new Error(`Could not find columns for local table ${tableName}`)
  }

  return rows.map(row => row.column_name)
}

async function getIdsToPull (localConnection, flagColumn) {
  const { rows } = await localConnection.query(
    `SELECT "paymentRequestId"
     FROM public."manualVerificationQueue"
     WHERE "${flagColumn}" = true
     ORDER BY "paymentRequestId"`
  )

  return rows.map(row => row.paymentRequestId)
}

async function fetchRowsForIds (hostedConnection, tableName, columns, ids) {
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ')
  const sql = `SELECT ${columnList} FROM public."${tableName}" WHERE "paymentRequestId" IN (${placeholders})`

  const { rows } = await hostedConnection.query(sql, ids)
  return rows
}

async function insertRows (localConnection, tableName, columns, primaryKey, rows) {
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const pk = `"${primaryKey}"`
  const maxRowsPerInsert = Math.max(1, Math.floor(MAX_PARAMS / columns.length))

  let inserted = 0

  for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
    const batch = rows.slice(i, i + maxRowsPerInsert)
    const params = []

    const valuePlaceholders = batch.map((row, rowIndex) => {
      const start = rowIndex * columns.length + 1
      return '(' + columns.map((_, colIndex) => `$${start + colIndex}`).join(', ') + ')'
    }).join(', ')

    batch.forEach(row => columns.forEach(col => params.push(row[col])))

    const sql = `
      INSERT INTO public."${tableName}" (${columnList})
      VALUES ${valuePlaceholders}
      ON CONFLICT (${pk}) DO NOTHING
    `

    const result = await localConnection.query(sql, params)
    inserted += result.rowCount
  }

  return inserted
}

async function copyTable (hostedConnection, localConnection, tableConfig, columns, dryRun) {
  const ids = await getIdsToPull(localConnection, tableConfig.flagColumn)
  console.log(`\n${tableConfig.name}: ${ids.length} payment request IDs flagged in queue`)

  if (ids.length === 0) {
    return 0
  }

  if (dryRun) {
    console.log(`  Dry run: would fetch rows from hosted public."${tableConfig.name}" for these IDs in batches of ${ID_BATCH_SIZE}`)
    return 0
  }

  let totalRows = 0
  const idBatchCount = Math.ceil(ids.length / ID_BATCH_SIZE)

  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const idBatch = ids.slice(i, i + ID_BATCH_SIZE)
    const rows = await fetchRowsForIds(hostedConnection, tableConfig.name, columns, idBatch)

    if (rows.length > 0) {
      const inserted = await insertRows(localConnection, tableConfig.name, columns, tableConfig.primaryKey, rows)
      totalRows += inserted
    }

    console.log(`  batch ${Math.floor(i / ID_BATCH_SIZE) + 1}/${idBatchCount}: ${idBatch.length} IDs -> ${rows.length} rows (total inserted: ${totalRows})`)
  }

  console.log(`${tableConfig.name}: finished, ${totalRows} rows copied`)
  return totalRows
}

async function getHostedTableSchema (hostedConnection, tableName) {
  const { rows: columns } = await hostedConnection.query(
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  )

  if (columns.length === 0) {
    throw new Error(`Could not find hosted table ${tableName}`)
  }

  const { rows: pkColumns } = await hostedConnection.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`public."${tableName}"`]
  )

  return { columns, primaryKey: pkColumns.map(row => row.column_name) }
}

function buildCreateTableSql (tableName, schema) {
  const columnDefs = schema.columns.map(col => {
    let type = col.data_type
    if (type === 'character varying' && col.character_maximum_length) {
      type = `character varying(${col.character_maximum_length})`
    } else if (type === 'numeric' && col.numeric_precision !== null) {
      type = `numeric(${col.numeric_precision},${col.numeric_scale || 0})`
    } else if (type === 'character') {
      type = col.character_maximum_length ? `character(${col.character_maximum_length})` : 'character'
    }
    return `"${col.column_name}" ${type}`
  })

  let sql = `CREATE TABLE IF NOT EXISTS public."${tableName}" (\n  ${columnDefs.join(',\n  ')}`
  if (schema.primaryKey.length > 0) {
    sql += `,\n  CONSTRAINT "${tableName}_pkey" PRIMARY KEY (${schema.primaryKey.map(c => `"${c}"`).join(', ')})`
  }
  sql += '\n)'

  return sql
}

async function ensureLocalTable (localConnection, hostedConnection, tableName) {
  const schema = await getHostedTableSchema(hostedConnection, tableName)
  await localConnection.query(buildCreateTableSql(tableName, schema))

  const { rows } = await localConnection.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  )

  return { columns: rows.map(row => row.column_name), primaryKey: schema.primaryKey }
}

async function getLocalCompletedPaymentRequestIds (localConnection) {
  const { rows } = await localConnection.query(
    `SELECT DISTINCT "completedPaymentRequestId" FROM public."completedPaymentRequests" ORDER BY "completedPaymentRequestId"`
  )
  return rows.map(row => row.completedPaymentRequestId)
}

async function fetchDependentRows (hostedConnection, tableName, columns, parentIds, foreignKey) {
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const placeholders = parentIds.map((_, index) => `$${index + 1}`).join(', ')
  const sql = `SELECT ${columnList} FROM public."${tableName}" WHERE "${foreignKey}" IN (${placeholders})`

  const { rows } = await hostedConnection.query(sql, parentIds)
  return rows
}

async function insertDependentRows (localConnection, tableName, columns, primaryKey, rows) {
  const maxRowsPerInsert = primaryKey.length > 0
    ? Math.max(1, Math.floor(MAX_PARAMS / columns.length))
    : Math.max(1, Math.floor(MAX_PARAMS / (columns.length + 1)))

  let inserted = 0

  for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
    const batch = rows.slice(i, i + maxRowsPerInsert)
    const params = []

    const valuePlaceholders = batch.map((row, rowIndex) => {
      const start = rowIndex * columns.length + 1
      return '(' + columns.map((_, colIndex) => `$${start + colIndex}`).join(', ') + ')'
    }).join(', ')

    batch.forEach(row => columns.forEach(col => params.push(row[col])))

    let sql
    if (primaryKey.length > 0) {
      const pkList = primaryKey.map(c => `"${c}"`).join(', ')
      sql = `
        INSERT INTO public."${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
        VALUES ${valuePlaceholders}
        ON CONFLICT (${pkList}) DO NOTHING
      `
    } else {
      sql = `
        INSERT INTO public."${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
        VALUES ${valuePlaceholders}
      `
    }

    const result = await localConnection.query(sql, params)
    inserted += result.rowCount
  }

  return inserted
}

async function updateQueueFlagsForDependentTable (localConnection, dependentConfig) {
  const result = await localConnection.query(
    `
    UPDATE public."manualVerificationQueue" q
    SET "${dependentConfig.flagColumn}" = true,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM public."completedPaymentRequests" cpr
    JOIN public."${dependentConfig.name}" dt
      ON dt."${dependentConfig.foreignKey}" = cpr."completedPaymentRequestId"
    WHERE q."paymentRequestId" = cpr."paymentRequestId"
      AND q."${dependentConfig.flagColumn}" = false
    `
  )
  return result.rowCount
}

async function copyDependentTables (hostedConnection, localConnection, dryRun) {
  const parentIds = await getLocalCompletedPaymentRequestIds(localConnection)
  console.log(`\nFound ${parentIds.length} local completedPaymentRequestIds to use for dependent-table lookup`)

  if (parentIds.length === 0) {
    console.log('No completedPaymentRequests pulled yet; skipping dependent tables')
    return
  }

  for (const dependentConfig of DEPENDENT_TABLES) {
    console.log(`\nDependent table: ${dependentConfig.name}`)
    const { columns, primaryKey } = await ensureLocalTable(localConnection, hostedConnection, dependentConfig.name)

    if (dryRun) {
      console.log(`  Dry run: would fetch rows from hosted public."${dependentConfig.name}" in batches of ${ID_BATCH_SIZE}`)
      continue
    }

    let totalRows = 0
    const idBatchCount = Math.ceil(parentIds.length / ID_BATCH_SIZE)

    for (let i = 0; i < parentIds.length; i += ID_BATCH_SIZE) {
      const idBatch = parentIds.slice(i, i + ID_BATCH_SIZE)
      const rows = await fetchDependentRows(hostedConnection, dependentConfig.name, columns, idBatch, dependentConfig.foreignKey)

      if (rows.length > 0) {
        const inserted = await insertDependentRows(localConnection, dependentConfig.name, columns, primaryKey, rows)
        totalRows += inserted
      }

      console.log(`  batch ${Math.floor(i / ID_BATCH_SIZE) + 1}/${idBatchCount}: ${idBatch.length} IDs -> ${rows.length} rows (total inserted: ${totalRows})`)
    }

    const flaggedCount = await updateQueueFlagsForDependentTable(localConnection, dependentConfig)
    console.log(`${dependentConfig.name}: finished, ${totalRows} rows copied, ${flaggedCount} queue entries flagged`)
  }
}

async function run () {
  const options = parseArgs()
  const tables = getRequestedTables(options.tables)

  let hostedConnection
  let localConnection

  try {
    console.log('Connecting to hosted recovery database (read-only)...')
    hostedConnection = await createRecoveryConnection({ applicationName: 'ffc_pay_recovery_data_pull' })

    console.log('Connecting to local recovery database (write)...')
    localConnection = await createLocalConnection({ applicationName: 'ffc_pay_recovery_data_pull' })

    for (const tableConfig of tables) {
      const columns = await getTableColumns(localConnection, tableConfig.name)
      await copyTable(hostedConnection, localConnection, tableConfig, columns, options.dryRun)
    }

    await copyDependentTables(hostedConnection, localConnection, options.dryRun)

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
