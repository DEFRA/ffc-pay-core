const { getSchemaInfo, validateAndTransformSqlStatement } = require('./schema-validator')
const { logInfo, logError } = require('../util/logger')

/**
 * Topologically sort tables by foreign key dependencies.
 * schemaInfo should include { table: { foreignKeys: [referencedTable, ...] } }
 */
function getTableLoadOrder (schemaInfo) {
  const graph = {}
  for (const table in schemaInfo) {
    graph[table] = schemaInfo[table].foreignKeys || []
  }
  const visited = new Set()
  const order = []

  function visit (table) {
    if (visited.has(table)) return
    visited.add(table)
    for (const dep of graph[table] || []) {
      visit(dep)
    }
    order.push(table)
  }

  for (const table in graph) visit(table)
  return order
}

async function loadInDependencyOrder (client, statements, dryRun = false, batchSize = 100) {
  let successCount = 0
  let errorCount = 0
  let rowsInserted = 0

  if (dryRun) {
    logInfo(`[DRY RUN] Would execute ${statements.length} SQL statements in dependency order`)
    return {
      success: statements.length,
      errors: 0,
      rowsInserted: 'Estimated: ' + statements.filter(stmt => stmt.trim().toUpperCase().startsWith('INSERT')).length * 5
    }
  }

  // 1. Group statements by table
  const tableGroups = {}
  for (const stmt of statements) {
    let tableName = null
    if (stmt.trim().toUpperCase().startsWith('INSERT INTO')) {
      const match = stmt.match(/INSERT INTO\s+["']?([a-zA-Z0-9_]+)["']?/i)
      if (match && match[1]) {
        tableName = match[1].toLowerCase()
      }
    }
    if (tableName) {
      if (!tableGroups[tableName]) tableGroups[tableName] = []
      tableGroups[tableName].push(stmt)
    } else {
      if (!tableGroups.__other) tableGroups.__other = []
      tableGroups.__other.push(stmt)
    }
  }

  // 2. Get table dependency order from schema
  const schemaInfo = await getSchemaInfo(client)
  const tableOrder = getTableLoadOrder(schemaInfo)

  // 3. Execute statements in dependency order
  for (const tableName of tableOrder) {
    const stmts = tableGroups[tableName] || []
    let batchSuccessCount = 0
    let batchErrorCount = 0
    let batchRowsInserted = 0

    try {
      for (let i = 0; i < stmts.length; i += batchSize) {
        const batch = stmts.slice(i, i + batchSize)

        for (const stmt of batch) {
          try {
            // Optional: validate statement before execution
            if (typeof validateAndTransformSqlStatement === 'function') {
              const validationResult = await validateAndTransformSqlStatement(stmt, client)
              if (validationResult && !validationResult.isValid) {
                logError(`Skipped statement: ${validationResult.reason}`)
                continue
              }
            }
            const result = await client.query(stmt)
            batchSuccessCount++
            if (stmt.trim().toUpperCase().startsWith('INSERT INTO')) {
              batchRowsInserted += (result.rowCount || 0)
            }
          } catch (err) {
            batchErrorCount++
            logError(`Error executing SQL: ${err.message}`)
            logError(`Problem statement: ${stmt.substring(0, 100)}...`)
          }
        }

        logInfo(`Processed ${i + batch.length} / ${stmts.length} statements for table ${tableName}`)
      }

      successCount += batchSuccessCount
      errorCount += batchErrorCount
      rowsInserted += batchRowsInserted

      logInfo(`Table ${tableName} complete: ${batchSuccessCount} successes, ${batchErrorCount} errors, ${batchRowsInserted} rows inserted`)
    } catch (err) {
      logError(`Error processing table ${tableName}: ${err.message}`)
      errorCount += stmts.length - batchSuccessCount
    }
  }

  // 4. Process any statements not associated with a table (e.g., DDL, other)
  if (tableGroups.__other) {
    for (const stmt of tableGroups.__other) {
      try {
        await client.query(stmt)
        successCount++
      } catch (err) {
        errorCount++
        logError(`Error executing non-table statement: ${err.message}`)
        logError(`Problem statement: ${stmt.substring(0, 100)}...`)
      }
    }
    logInfo(`Processed ${tableGroups.__other.length} non-table statements`)
  }

  return { success: successCount, errors: errorCount, rowsInserted }
}

module.exports = { loadInDependencyOrder }
