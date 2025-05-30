const { createConnection, listDatabases } = require('../database/db-connection')
const { findSqlDumpFiles, safeRemoveFile } = require('../util/file-utils')
const { logInfo, logError } = require('../util/logger')
const { processForAzure } = require('../transform/sql-processor')
const { loadDataInBatchesWithErrorTracking } = require('./execute-sql')
const fs = require('fs')

async function uploadToDev () {
  logInfo('Starting database restoration process (data-only approach)...')

  // Database discovery section with proper import
  try {
    logInfo('--- Database Discovery ---')
    // Look for both test and dev databases
    const targetDatabases = await listDatabases(['ffc-doc-%-dev', 'ffc-pay-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-test'])
    logInfo(`Found ${targetDatabases.length} available target databases:`)
    logInfo(targetDatabases)
    logInfo('------------------------')
  } catch (err) {
    logError(`Database discovery failed: ${err.message}`)
  }

  const databaseFiles = findSqlDumpFiles()

  let successCount = 0
  let errorCount = 0

  for (const { sourceDbName, targetDbName, filePath } of databaseFiles) {
    logInfo(`\n📦 Processing database: ${sourceDbName}`)
    logInfo(`File: ${filePath}`)
    logInfo(`Target DB: ${targetDbName}`)

    let client
    try {
      // Step 1: Connect to database
      logInfo(`Connecting to ${targetDbName}...`)
      client = await createConnection(targetDbName)

      const { rows } = await client.query(
        'SELECT current_database(), current_user, version(), current_timestamp'
      )

      logInfo('=== Connection Details ===')
      logInfo(`Database: ${rows[0].current_database}`)
      logInfo(`User: ${rows[0].current_user}`)
      logInfo(`PostgreSQL: ${rows[0].version.split(',')[0]}`)
      logInfo(`Connection time: ${rows[0].current_timestamp}`)
      logInfo('========================')

      // Step 2: Schema verification
      const schemaExists = await verifySchema(client, targetDbName)
      if (!schemaExists) {
        logInfo('Schema missing in target database - extracting and applying schema first')
        const schemaFile = await extractSchemaOnly(filePath, targetDbName)
        await applySchema(client, schemaFile)
        safeRemoveFile(schemaFile)
      }

      // Step 3: Clear existing data
      await clearDatabaseSimple(client)

      // Step 4: Process SQL file with Azure optimizations using processForAzure
      logInfo(`Processing SQL dump file for Azure compatibility: ${filePath}`)
      const { processedFilePath, stats } = await processForAzure(filePath, sourceDbName, targetDbName)
      logInfo(`SQL file processed for Azure: ${stats.copyBlocksConverted} COPY blocks converted, ${stats.copyRowsConverted} rows processed`)

      // Step 5: Execute SQL with enhanced error tracking
      const insertCount = await loadDataInBatchesWithErrorTracking(client, processedFilePath)

      if (insertCount > 0) {
        logInfo(`✅ Success: Imported ${insertCount} rows into ${targetDbName}`)
        successCount++
      } else {
        logInfo(`⚠️ Warning: No data was imported into ${targetDbName}`)
        errorCount++
      }

      // Clean up
      safeRemoveFile(processedFilePath)
    } catch (e) {
      logError(`Error on ${targetDbName}: ${e.message}`)
      errorCount++
    } finally {
      if (client?.pool) await client.pool.end().catch(() => { })
      logInfo(`Disconnected from ${targetDbName}`)
    }
  }

  logInfo('\nDatabase restoration finished')
  logInfo(`✔️ Success: ${successCount}`)
  if (errorCount) logInfo(`❌ Failures: ${errorCount}`)
  return errorCount === 0
}

/**
 * Verifies if the schema exists in the target database
 * @param {Object} client - Database client
 * @param {string} dbName - Database name
 * @returns {boolean} Whether schema exists
 */
async function verifySchema (client, dbName) {
  // Check if essential tables exist
  const { rows } = await client.query(`
    SELECT COUNT(*) as table_count
    FROM pg_tables
    WHERE schemaname = 'public'
  `)

  const tableCount = parseInt(rows[0].table_count)
  logInfo(`Found ${tableCount} tables in target database`)

  return tableCount > 0
}

// Update the extractSchemaOnly function
async function extractSchemaOnly (sqlFile, targetDb) {
  const outputFile = `/tmp/schema_only_${targetDb}_${Date.now()}.sql`
  const writeStream = fs.createWriteStream(outputFile)

  return new Promise((resolve, reject) => {
    const lineReader = require('readline').createInterface({
      input: fs.createReadStream(sqlFile, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    let statement = ''
    let inCopy = false
    let statementCount = 0

    writeStream.write('-- SCHEMA ONLY IMPORT\n\n')

    lineReader.on('line', (line) => {
      const trimmed = line.trim()

      // Skip COPY blocks
      if (/^\s*COPY\s+.*FROM\s+stdin;/i.test(trimmed)) {
        inCopy = true
        return
      }

      if (inCopy) {
        if (trimmed === '\\.') {
          inCopy = false
        }
        return
      }

      // Skip any "ALTER TABLE ... ADD PRIMARY KEY" statements to avoid
      // multiple primary key errors later
      if (/ALTER\s+TABLE.*ADD\s+PRIMARY\s+KEY/i.test(trimmed)) {
        return
      }

      // Keep only CREATE TABLE, CREATE SEQUENCE, etc.
      if (/^\s*CREATE\s+TABLE/i.test(trimmed) ||
        /^\s*CREATE\s+SEQUENCE/i.test(trimmed) ||
        /^\s*CREATE\s+TYPE/i.test(trimmed) ||
        /^\s*CREATE\s+INDEX/i.test(trimmed)) {
        statement += line + '\n'

        if (line.endsWith(';')) {
          // Clean up constraints from CREATE TABLE statements
          if (/CREATE\s+TABLE/i.test(statement)) {
            // Remove foreign key constraints
            statement = statement.replace(/,\s*CONSTRAINT\s+[\w"]+"?\s+FOREIGN\s+KEY[^,)]+/gi, '')

            // Remove primary key inline definitions
            statement = statement.replace(/\s+PRIMARY\s+KEY/gi, '')

            // Remove unique constraints
            statement = statement.replace(/,\s*CONSTRAINT\s+[\w"]+"?\s+UNIQUE[^,)]+/gi, '')

            // Clean up any trailing/duplicate commas
            statement = statement.replace(/,\s*,/g, ',')
            statement = statement.replace(/,\s*\)/g, '\n)')
          }

          // Add IF NOT EXISTS for Azure compatibility
          statement = statement
            .replace(/CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
            .replace(/CREATE\s+SEQUENCE\s+/i, 'CREATE SEQUENCE IF NOT EXISTS ')
            .replace(/CREATE\s+INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ')

          writeStream.write(statement)
          statement = ''
          statementCount++
        }
      } else if (/^\s*ALTER\s+TABLE/i.test(trimmed) &&
        !/ADD\s+CONSTRAINT/i.test(trimmed) &&
        !/PRIMARY\s+KEY/i.test(trimmed)) {
        statement += line + '\n'

        if (line.endsWith(';')) {
          // Add IF EXISTS clause
          statement = statement.replace(/ALTER\s+TABLE\s+/i, 'ALTER TABLE IF EXISTS ')

          writeStream.write(statement)
          statement = ''
          statementCount++
        }
      }
    })

    lineReader.on('close', () => {
      writeStream.end()
      logInfo(`Extracted ${statementCount} schema statements to ${outputFile}`)
      resolve(outputFile)
    })

    lineReader.on('error', reject)
    writeStream.on('error', reject)
  })
}

/**
 * Applies schema to target database
 * @param {Object} client - Database client
 * @param {string} schemaFile - Path to schema file
 */
async function applySchema (client, schemaFile) {
  logInfo('Applying schema to target database')

  const lineReader = require('readline').createInterface({
    input: fs.createReadStream(schemaFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let statement = ''
  let successCount = 0
  let errorCount = 0

  await client.query('BEGIN')

  for await (const line of lineReader) {
    // Skip comments
    if (line.trim().startsWith('--')) continue

    statement += line + '\n'

    if (line.trim().endsWith(';')) {
      try {
        await client.query(statement)
        successCount++

        // Log every 10 statements
        if (successCount % 10 === 0) {
          logInfo(`Schema creation progress: ${successCount} statements executed`)
        }
      } catch (err) {
        errorCount++
        logInfo(`Schema warning: ${err.message}`)
        // Continue despite errors - we want to create as much schema as possible
      }
      statement = ''
    }
  }

  await client.query('COMMIT')
  logInfo(`Schema applied: ${successCount} statements executed, ${errorCount} errors (warnings)`)
}

async function clearDatabaseSimple (client) {
  try {
    // Step 1: Get all tables
    const { rows } = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
    `)

    if (rows.length === 0) {
      logInfo('No tables found to clear')
      return
    }

    logInfo(`Found ${rows.length} tables to clear`)

    // Step 2: Begin transaction
    await client.query('BEGIN')

    // Step 3: Get table relationships to determine proper deletion order
    const { rows: tableRelationships } = await client.query(`
      SELECT 
        tc.table_name, 
        ccu.table_name AS referenced_table
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
      WHERE 
        tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_schema = 'public'
    `)

    // Simple topological sort to determine deletion order
    // This ensures we delete dependent tables first
    const dependencyGraph = {}
    for (const { tablename } of rows) {
      dependencyGraph[tablename] = []
    }

    for (const rel of tableRelationships) {
      if (dependencyGraph[rel.table_name]) {
        dependencyGraph[rel.table_name].push(rel.referenced_table)
      }
    }

    // Find tables with no dependencies first
    const processOrder = []
    const visited = new Set()

    const visit = (table) => {
      if (visited.has(table)) return
      visited.add(table)

      if (dependencyGraph[table]) {
        for (const dependency of dependencyGraph[table]) {
          visit(dependency)
        }
      }

      processOrder.push(table)
    }

    for (const table in dependencyGraph) {
      visit(table)
    }

    // Now process in reverse order (leaf nodes first)
    for (const tablename of processOrder.reverse()) {
      try {
        // First try CASCADE which should work despite constraints
        await client.query(`TRUNCATE TABLE public."${tablename}" CASCADE`)
        logInfo(`Cleared table: ${tablename}`)
      } catch (err) {
        logInfo(`Note: Could not truncate ${tablename}: ${err.message}`)
        try {
          // Fallback to DELETE
          await client.query(`DELETE FROM public."${tablename}"`)
          logInfo(`Deleted data from: ${tablename}`)
        } catch (deleteErr) {
          logInfo(`Skip clearing ${tablename}: ${deleteErr.message}`)
        }
      }
    }

    await client.query('COMMIT')
    logInfo('Tables cleared successfully')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function extractDataOnly (sqlFile, targetDb) {
  logInfo('WARNING: extractDataOnly is deprecated. Use processForAzure instead.')
  // Process with Azure-specific optimizations
  const { processedFilePath } = await processForAzure(sqlFile, targetDb, targetDb)
  return processedFilePath
}

module.exports = {
  uploadToDev,
  extractDataOnly
}

// Allow direct execution
if (require.main === module) {
  uploadToDev()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      logError(`Upload process failed: ${error}`)
      process.exit(1)
    })
}
