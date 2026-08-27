const { createConnection } = require('./db-connection')

function quoteIdentifier (value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function normaliseTransferTable (table) {
  if (typeof table === 'string') {
    return { name: table }
  }

  return {
    name: table.name,
    keyColumn: table.keyColumn || table.key || null,
    allowZeroRows: Boolean(table.allowZeroRows),
    excludeFromValidation: Boolean(table.excludeFromValidation)
  }
}

function mergeDiscoveredMetadata (serviceSpec = {}, discoveredTables = []) {
  const configuredTables = Array.isArray(serviceSpec.tables) ? serviceSpec.tables : []
  const hintedTables = Array.isArray(serviceSpec.tableHints) ? serviceSpec.tableHints : []

  const explicitEntries = [...configuredTables, ...hintedTables].map(normaliseTransferTable)
  const explicitMap = new Map(explicitEntries.filter(entry => entry.name).map(entry => [String(entry.name).toLowerCase(), entry]))

  const merged = (discoveredTables || [])
    .filter(tableName => !/^databasechangelog|^databasechangeloglock/i.test(String(tableName)))
    .map(tableName => ({
      name: tableName,
      keyColumn: null
    }))
    .map(entry => {
      const explicitEntry = explicitMap.get(String(entry.name).toLowerCase())
      if (!explicitEntry) return entry
      return {
        ...entry,
        ...explicitEntry,
        name: entry.name
      }
    })

  for (const explicitEntry of explicitEntries) {
    const key = String(explicitEntry.name).toLowerCase()
    if (!merged.some(entry => String(entry.name).toLowerCase() === key)) {
      merged.push(explicitEntry)
    }
  }

  return merged
}

function resolveTransferTableList (serviceSpec = {}, discoveredTables = []) {
  const baseTables = mergeDiscoveredMetadata(serviceSpec, discoveredTables)
  const excludedNames = new Set(['schemes', 'contacts'])

  return baseTables.filter(table => {
    const tableName = String(table.name || '').toLowerCase()
    if (!tableName) return false
    return !excludedNames.has(tableName)
  })
}

async function discoverTargetTables (databaseName, environment = 'pre', options = {}) {
  const connection = await createConnection(databaseName, { environment, ...options })

  try {
    const result = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )
    return result.rows.map(row => row.table_name)
  } finally {
    await connection?.pool?.end()
  }
}

async function getTableRowCount (connection, tableName) {
  const result = await connection.query(
    `SELECT COUNT(*)::int AS row_count FROM public.${quoteIdentifier(tableName)}`
  )
  return Number(result.rows[0]?.row_count || 0)
}

async function getTablePkCount (connection, tableName, keyColumn = null) {
  if (!keyColumn) {
    return getTableRowCount(connection, tableName)
  }

  const result = await connection.query(
    `SELECT COUNT(*)::int AS row_count FROM (SELECT DISTINCT ${quoteIdentifier(keyColumn)} FROM public.${quoteIdentifier(tableName)}) AS distinct_rows`
  )

  return Number(result.rows[0]?.row_count || 0)
}

async function validateTransferTables (serviceSpec = {}, sourceConnection, targetConnection, options = {}) {
  const tableList = resolveTransferTableList(serviceSpec, options.discoveredTables || [])
  const results = []
  const validationErrors = []

  for (const table of tableList) {
    const tableName = table.name
    if (!tableName || table.excludeFromValidation) continue

    try {
      const sourceCount = await getTableRowCount(sourceConnection, tableName)
      const targetCount = await getTableRowCount(targetConnection, tableName)
      const keyColumn = table.keyColumn || options.keyColumn || null
      const sourcePkCount = await getTablePkCount(sourceConnection, tableName, keyColumn)
      const targetPkCount = await getTablePkCount(targetConnection, tableName, keyColumn)

      const rowCountMatches = sourceCount === targetCount
      const pkMatches = sourcePkCount === targetPkCount

      const summary = {
        table: tableName,
        sourceRows: sourceCount,
        targetRows: targetCount,
        sourceDistinctKeyCount: sourcePkCount,
        targetDistinctKeyCount: targetPkCount,
        rowCountMatches,
        keyCountMatches: pkMatches
      }

      results.push(summary)

      if (!rowCountMatches || !pkMatches) {
        validationErrors.push(`${tableName}: rowCountMatches=${rowCountMatches}, keyCountMatches=${pkMatches}, sourceRows=${sourceCount}, targetRows=${targetCount}, sourceDistinctKeys=${sourcePkCount}, targetDistinctKeys=${targetPkCount}`)
      }
    } catch (error) {
      validationErrors.push(`${tableName}: validation failed - ${error.message}`)
    }
  }

  return {
    passed: validationErrors.length === 0,
    results,
    validationErrors
  }
}

module.exports = {
  quoteIdentifier,
  resolveTransferTableList,
  discoverTargetTables,
  getTableRowCount,
  getTablePkCount,
  validateTransferTables,
  normaliseTransferTable
}
