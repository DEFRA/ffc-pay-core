const fs = require('fs')
const path = require('path')

const SCHEMA_CACHE_DIR = path.resolve(__dirname, '..', '.schema-cache')

function normalizeDataType (column) {
  let type = column.data_type

  if (type === 'character varying' && column.character_maximum_length) {
    type = `character varying(${column.character_maximum_length})`
  } else if (type === 'numeric' && column.numeric_precision !== null) {
    type = `numeric(${column.numeric_precision},${column.numeric_scale || 0})`
  } else if (type === 'character' && column.character_maximum_length) {
    type = `character(${column.character_maximum_length})`
  }

  return type
}

function readCache (cacheKey) {
  try {
    const filePath = path.join(SCHEMA_CACHE_DIR, `${cacheKey}.json`)
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    }
  } catch (error) {
    console.warn(`Failed to read schema cache for ${cacheKey}: ${error.message}`)
  }
  return null
}

function writeCache (cacheKey, data) {
  try {
    fs.mkdirSync(SCHEMA_CACHE_DIR, { recursive: true })
    const filePath = path.join(SCHEMA_CACHE_DIR, `${cacheKey}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  } catch (error) {
    console.warn(`Failed to write schema cache for ${cacheKey}: ${error.message}`)
  }
}

async function getTableColumns (connection, tableName) {
  const { rows } = await connection.query(
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  )

  if (rows.length === 0) {
    throw new Error(`Could not find columns for table "${tableName}"`)
  }

  return rows
}

async function getPrimaryKeyColumns (connection, tableName) {
  const { rows } = await connection.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [`public."${tableName}"`]
  )

  return rows.map(row => row.column_name)
}

function normalizeIndexColumns (rawColumns) {
  if (Array.isArray(rawColumns)) {
    return rawColumns
  }
  if (typeof rawColumns === 'string') {
    // Defensive: handle any case where the driver returns a stringified array.
    return rawColumns.replace(/[{}]/g, '').split(',').filter(c => c.length > 0)
  }
  return []
}

async function getSensibleIndexes (connection, tableName) {
  const { rows } = await connection.query(
    `
    SELECT
      i.relname AS index_name,
      am.amname AS index_type,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
      pg_get_expr(ix.indexprs, ix.indrelid) AS expression
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = $1
      AND NOT ix.indisprimary
      AND am.amname = 'btree'
      AND ix.indexprs IS NULL
      AND ix.indpred IS NULL
    GROUP BY i.relname, am.amname, ix.indisunique, ix.indisprimary, ix.indpred, ix.indexprs, ix.indrelid
    ORDER BY i.relname
    `,
    [tableName]
  )

  return rows.map(row => ({
    ...row,
    columns: normalizeIndexColumns(row.columns)
  }))
}

async function introspectTable (hostedConnection, tableName, options = {}) {
  const cacheKey = `${hostedConnection.database || 'unknown'}.${tableName}`
  const cached = options.skipCache ? null : readCache(cacheKey)

  if (cached && Array.isArray(cached.indexes)) {
    cached.indexes = cached.indexes.map(index => ({
      ...index,
      columns: normalizeIndexColumns(index.columns)
    }))
    return cached
  }

  const columns = await getTableColumns(hostedConnection, tableName)
  const primaryKey = await getPrimaryKeyColumns(hostedConnection, tableName)
  const indexes = options.includeIndexes !== false ? await getSensibleIndexes(hostedConnection, tableName) : []

  const schema = {
    tableName,
    columns: columns.map(col => ({
      name: col.column_name,
      type: normalizeDataType(col),
      nullable: col.is_nullable === 'YES'
    })),
    primaryKey,
    indexes
  }

  if (!options.skipCache) {
    writeCache(cacheKey, schema)
  }

  return schema
}

function buildCreateTableSql (tableName, schema) {
  const columnDefs = schema.columns.map(col => `"${col.name}" ${col.type}`)

  let sql = `CREATE TABLE IF NOT EXISTS public."${tableName}" (\n  ${columnDefs.join(',\n  ')}`

  if (schema.primaryKey.length > 0) {
    sql += `,\n  CONSTRAINT "${tableName}_pkey" PRIMARY KEY (${schema.primaryKey.map(c => `"${c}"`).join(', ')})`
  }

  sql += '\n)'
  return sql
}

function buildCreateIndexSql (tableName, index, options = {}) {
  const columns = normalizeIndexColumns(index.columns)
  if (columns.length === 0) {
    return null
  }

  const indexName = options.prefix ? `${options.prefix}${index.index_name}` : index.index_name
  const unique = index.is_unique ? 'UNIQUE ' : ''
  const columnList = columns.map(c => `"${c}"`).join(', ')

  return `CREATE ${unique}INDEX IF NOT EXISTS "${indexName}" ON public."${tableName}" USING btree (${columnList})`
}

async function ensureLocalTable (localConnection, hostedConnection, localName, hostedName, options = {}) {
  const schema = await introspectTable(hostedConnection, hostedName, options)
  await localConnection.query(buildCreateTableSql(localName, schema))

  for (const index of schema.indexes) {
    const createIndexSql = buildCreateIndexSql(localName, index, { prefix: options.indexPrefix })
    if (createIndexSql) {
      await localConnection.query(createIndexSql)
    }
  }

  const localColumns = await getLocalTableColumns(localConnection, localName)
  const hostedColumnNames = schema.columns.map(col => col.name)
  return { ...schema, columns: localColumns, hostedColumns: hostedColumnNames, localColumns }
}

async function getLocalTableColumns (localConnection, tableName) {
  const { rows } = await localConnection.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  )

  if (rows.length === 0) {
    throw new Error(`Could not find columns for local table "${tableName}"`)
  }

  return rows.map(row => row.column_name)
}

module.exports = {
  introspectTable,
  ensureLocalTable,
  getLocalTableColumns,
  buildCreateTableSql,
  buildCreateIndexSql,
  normalizeDataType
}
