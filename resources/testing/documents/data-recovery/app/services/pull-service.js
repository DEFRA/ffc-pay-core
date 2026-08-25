const { runBatched, buildInPlaceholders, buildTuplePlaceholders } = require('./batch-service')

const DEFAULT_MAX_PARAMS = 5000

function keyOf (row, columns) {
  return columns.map(col => row[col]).join('|')
}

function normalizeColumnExpression (column) {
  if (typeof column === 'string') {
    return { name: column, expression: `"${column}"` }
  }
  return {
    name: column.name,
    expression: column.expression || `"${column.name}"`
  }
}

async function filterExistingKeys (localConnection, tableName, keyColumns, keys, options = {}) {
  if (keys.length === 0 || keyColumns.length === 0) {
    return keys
  }

  // Use a single client for all temp-table operations so the temp table stays
  // in the same session. If localConnection is already a client (no pool),
  // fall back to using it directly.
  const ownsClient = localConnection.pool && typeof localConnection.pool.connect === 'function'
  const client = ownsClient ? await localConnection.pool.connect() : localConnection

  try {
    const columnExpressions = keyColumns.map(normalizeColumnExpression)
    const keyColumnNames = columnExpressions.map(c => c.name)
    const existing = new Set()
    const tempTable = '_recovery_filter_keys'

    await client.query(`DROP TABLE IF EXISTS "${tempTable}"`)

    const columnDefs = columnExpressions.map(c => `"${c.name}" text`).join(', ')
    await client.query(`CREATE TEMP TABLE "${tempTable}" (${columnDefs})`)

    const maxParams = options.maxParams || DEFAULT_MAX_PARAMS
    const colsPerRow = columnExpressions.length
    const insertBatchSize = Math.max(1, Math.floor(maxParams / colsPerRow))

    for (let i = 0; i < keys.length; i += insertBatchSize) {
      const batch = keys.slice(i, i + insertBatchSize)
      const placeholders = batch.map((_, rowIndex) => {
        const start = rowIndex * colsPerRow + 1
        return '(' + columnExpressions.map((_, colIndex) => `$${start + colIndex}`).join(', ') + ')'
      }).join(', ')
      const params = batch.flatMap(key => keyColumnNames.map(col => key[col] === undefined ? null : key[col]))
      await client.query(
        `INSERT INTO "${tempTable}" VALUES ${placeholders}`,
        params
      )

      if (options.onProgress && keys.length > insertBatchSize) {
        options.onProgress(Math.min(i + insertBatchSize, keys.length), keys.length)
      }
    }

    const selectList = columnExpressions.map(c => `(t.${c.expression})::text AS "${c.name}"`).join(', ')
    const joinConditions = columnExpressions.map(c => `(t.${c.expression})::text = "${tempTable}"."${c.name}"`).join(' AND ')

    const { rows } = await client.query(
      `SELECT ${selectList} FROM public."${tableName}" t JOIN "${tempTable}" ON ${joinConditions}`
    )

    rows.forEach(row => existing.add(keyOf(row, keyColumnNames)))

    await client.query(`DROP TABLE IF EXISTS "${tempTable}"`)

    return keys.filter(key => !existing.has(keyOf(key, keyColumnNames)))
  } finally {
    if (ownsClient) {
      client.release()
    }
  }
}

async function fetchRowsBySingleKey (hostedConnection, tableName, columns, keyColumn, keys, options = {}) {
  if (keys.length === 0) {
    return []
  }

  const maxParams = options.maxParams || DEFAULT_MAX_PARAMS
  const batchSize = Math.max(1, Math.floor(maxParams / 1))
  const batchCount = Math.ceil(keys.length / batchSize)
  const columnList = columns.map(c => `"${c}"`).join(', ')

  const rows = await runBatched(keys, 1, maxParams, async (batch, offset) => {
    const placeholders = buildInPlaceholders(batch.length)
    const { rows: batchRows } = await hostedConnection.query(
      `SELECT ${columnList} FROM public."${tableName}" WHERE "${keyColumn}" IN (${placeholders})`,
      batch
    )

    if (options.onProgress && batchCount > 1) {
      options.onProgress(offset + batch.length, keys.length)
    }

    return batchRows
  })

  return rows
}

async function fetchRowsByTuple (hostedConnection, tableName, columns, tupleColumns, tuples, options = {}) {
  if (tuples.length === 0) {
    return []
  }

  const maxParams = options.maxParams || DEFAULT_MAX_PARAMS
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const normalizedColumns = tupleColumns.map(normalizeColumnExpression)
  const tupleColumnList = normalizedColumns.map(c => c.expression).join(', ')
  const tupleColumnNames = normalizedColumns.map(c => c.name)

  const rows = await runBatched(tuples, tupleColumnNames.length, maxParams, async (batch) => {
    const { placeholders } = buildTuplePlaceholders(batch.length, tupleColumnNames.length)
    const params = batch.flatMap(tuple => tupleColumnNames.map(col => tuple[col]))
    const { rows: batchRows } = await hostedConnection.query(
      `SELECT ${columnList} FROM public."${tableName}" WHERE (${tupleColumnList}) IN (${placeholders})`,
      params
    )
    return batchRows
  })

  return rows
}

function buildInsertSql (tableName, columns, primaryKey) {
  const columnList = columns.map(c => `"${c}"`).join(', ')
  const valuePlaceholders = (rowIndex, colCount) => {
    const start = rowIndex * colCount + 1
    return '(' + columns.map((_, colIndex) => `$${start + colIndex}`).join(', ') + ')'
  }

  let conflictClause = ''
  if (primaryKey && primaryKey.length > 0) {
    const pkList = primaryKey.map(c => `"${c}"`).join(', ')
    conflictClause = ` ON CONFLICT (${pkList}) DO NOTHING`
  }

  return {
    sqlTemplate: (rowCount) => {
      const placeholders = Array.from({ length: rowCount }, (_, i) => valuePlaceholders(i, columns.length)).join(', ')
      return `INSERT INTO public."${tableName}" (${columnList}) VALUES ${placeholders}${conflictClause}`
    }
  }
}

async function insertRows (localConnection, tableName, columns, primaryKey, rows, options = {}) {
  if (rows.length === 0) {
    return 0
  }

  const maxParams = options.maxParams || DEFAULT_MAX_PARAMS
  const maxRowsPerInsert = Math.max(1, Math.floor(maxParams / columns.length))
  const { sqlTemplate } = buildInsertSql(tableName, columns, primaryKey)

  let inserted = 0

  for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
    const batch = rows.slice(i, i + maxRowsPerInsert)
    const params = []
    batch.forEach(row => columns.forEach(col => params.push(row[col])))

    const sql = sqlTemplate(batch.length)
    const result = await localConnection.query(sql, params)
    inserted += result.rowCount
  }

  return inserted
}

module.exports = {
  filterExistingKeys,
  fetchRowsBySingleKey,
  fetchRowsByTuple,
  insertRows,
  keyOf
}
