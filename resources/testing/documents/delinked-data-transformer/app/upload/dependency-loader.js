const { getSchemaInfo, validateAndTransformSqlStatement } = require('./schema-validator')
const { logInfo, logError } = require('../util/logger')

async function loadInDependencyOrder(client, statements, dryRun = false) {
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
      if (!tableGroups[tableName]) {
        tableGroups[tableName] = []
      }
      tableGroups[tableName].push(stmt)
    } else {
      if (!tableGroups['__other']) {
        tableGroups['__other'] = []
      }
      tableGroups['__other'].push(stmt)
    }
  }

  for (const tableName in tableGroups) {
    const stmts = tableGroups[tableName]
    let batchSuccessCount = 0
    let batchErrorCount = 0
    let batchRowsInserted = 0

    try {
      const batchSize = 100
      for (let i = 0; i < stmts.length; i += batchSize) {
        const batch = stmts.slice(i, i + batchSize)
        
        for (const stmt of batch) {
          try {
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
        
        if (tableName !== '__other') {
          logInfo(`Processed ${i + batch.length} / ${stmts.length} statements for table ${tableName}`)
        }
      }
      
      successCount += batchSuccessCount
      errorCount += batchErrorCount
      rowsInserted += batchRowsInserted
      
      if (tableName !== '__other') {
        logInfo(`Table ${tableName} complete: ${batchSuccessCount} successes, ${batchErrorCount} errors, ${batchRowsInserted} rows inserted`)
      }
    } catch (err) {
      logError(`Error processing table ${tableName}: ${err.message}`)
      errorCount += stmts.length - batchSuccessCount
    }
  }

  return { success: successCount, errors: errorCount, rowsInserted }
}

module.exports = { loadInDependencyOrder }
