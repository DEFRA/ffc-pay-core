const fs = require('fs')
const readline = require('readline')
const os = require('os')
const path = require('path')
const { logInfo, logProgress } = require('../util/logger')
const EXCLUDE_ETL_TABLES = true // Flag to enable/disable ETL table protection
const ETL_DATABASE = 'ffc-doc-statement-data-test' // Database containing ETL tables to protect
const ETL_TABLE_PREFIX = 'etl' // Prefix of tables to protect

async function processForAzure(inputFile, sourceDb, targetDb) {
  const tempSqlFile = path.join(os.tmpdir(), `processed_${path.basename(inputFile)}`)
  const outputStream = fs.createWriteStream(tempSqlFile)

  logInfo(`Processing SQL file for Azure compatibility: ${inputFile}`)

  try {
    // Add SQL to disable constraints before and enable after the data import
    outputStream.write('-- Disable triggers and constraints for faster import\n')
    outputStream.write('SET session_replication_role = replica\n\n')
    outputStream.write('-- Processing dump file for better insertion\n\n')

    const stats = await processLargeFile(inputFile, outputStream, sourceDb, targetDb)

    // Add SQL to re-enable constraints after import
    outputStream.write('\n-- Re-enable triggers and constraints\n')
    outputStream.write('SET session_replication_role = DEFAULT\n')

    logInfo(`Processed SQL written to ${tempSqlFile}`)

      // Final verification - SAFEGUARD 4
  if (EXCLUDE_ETL_TABLES && sourceDb.toLowerCase() === ETL_DATABASE.toLowerCase()) {
    logInfo('Performing final ETL protection verification check...')
    const verificationResult = await verifyNoEtlOperations(tempSqlFile)
    if (!verificationResult.safe) {
      const errorMsg = `⚠️ CRITICAL SAFETY ERROR: Found ${verificationResult.count} unfiltered ETL operations in processed SQL!`
      logInfo(errorMsg)
      throw new Error(errorMsg)
    } else {
      logInfo('✅ Final ETL protection verification passed - No ETL table operations found.')
    }
  }
  
  return {
    processedFilePath: tempSqlFile,
    stats
    }
  } catch (error) {
    logInfo(`Error processing SQL file: ${error.message}`)
    throw error
  }
}

async function verifyNoEtlOperations(sqlFile) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(sqlFile, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    })
    
    let dangerous = false
    let count = 0
    let dangerousLines = []
    const etlPattern = /(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\s+(?:public\.)?("?etl[^"]*"?|etl[^\s(]*)/i
    
    rl.on('line', (line) => {
      if (!line.startsWith('--') && etlPattern.test(line)) {
        dangerous = true
        count++
        if (dangerousLines.length < 5) { // Limit to 5 examples
          dangerousLines.push(line)
        }
      }
    })
    
    rl.on('close', () => {
      if (dangerous) {
        logInfo('⚠️ Found potentially dangerous ETL operations:')
        dangerousLines.forEach(line => logInfo(`  ${line}`))
        if (count > dangerousLines.length) {
          logInfo(`  ...and ${count - dangerousLines.length} more`)
        }
      }
      resolve({ safe: !dangerous, count, examples: dangerousLines })
    })
    
    rl.on('error', (err) => {
      reject(err)
    })
  })
}

async function processLargeFile(inputFile, outputStream, sourceDb, targetDb) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(inputFile, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    })

    let inCopy = false
    let lineCount = 0
    let originalInsertCount = 0
    
    // Add ETL protection variables
    let etlTablesSkipped = 0
    const isEtlDatabase = sourceDb.toLowerCase() === ETL_DATABASE.toLowerCase()
    const etlTablePattern = /^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE)\s+(?:public\.)?("?etl[^"]*"?|etl[^\s(]*)/i

    let currentTable = null
    let currentColumns = []
    let copyData = []
    let copyBlocksConverted = 0
    let copyRowsConverted = 0
    const COPY_BATCH_SIZE = 1000 // Number of rows to include in a single INSERT statement

    const stats = {
      lineCount: 0,
      copyBlocksConverted: 0,
      copyRowsConverted: 0,
      dbCommandsSkipped: 0,
      constraintsSkipped: 0,
      originalInsertCount: 0,
      etlTablesSkipped: 0
    }

    outputStream.write('-- Processing dump file for better insertion\n\n')

        rl.on('line', (line) => {
      lineCount++
      stats.lineCount++

      if (lineCount % 100000 === 0) {
        logProgress('.')
      }

      const t = line.trim()

      if (t.startsWith('--')) {
        outputStream.write(line + '\n')
        return
      }
      
      // ETL protection - SAFEGUARD 3
      if (EXCLUDE_ETL_TABLES && isEtlDatabase) {
        // Check for ETL table operations
        if (etlTablePattern.test(t)) {
          etlTablesSkipped++
          outputStream.write(`-- ⚠️ ETL PROTECTION: EXCLUDED OPERATION: ${line}\n`)
          return
        }
        
        // Special check for COPY commands involving ETL tables
        if (/^\s*COPY\s+(?:public\.)?("?etl[^"]*"?|etl[^\s(]*)/i.test(t)) {
          etlTablesSkipped++
          outputStream.write(`-- ⚠️ ETL PROTECTION: EXCLUDED COPY OPERATION: ${line}\n`)
          inCopy = false // Prevent entering COPY mode for this table
          return
        }
      }

      if (/^\s*INSERT\s+INTO/i.test(t)) {
        originalInsertCount++
        stats.originalInsertCount++
        if (originalInsertCount % 10000 === 0) {
          logProgress('+')
        }
      }

      // Process COPY blocks by converting to INSERTs
      if (/^\s*COPY\s+.*FROM\s+stdin/i.test(t)) {
        // Extract table name and columns
        const copyMatch = t.match(/COPY\s+([\w."]+)(?:\s+\((.*?)\))?\s+FROM\s+stdin/i)
        if (copyMatch) {
          currentTable = copyMatch[1]
          currentColumns = copyMatch[2] ? copyMatch[2].split(/,\s*/) : []
          logInfo(`Converting COPY to INSERTs for table ${currentTable}`)
          stats.copyBlocksConverted++
          copyBlocksConverted++
        }
        inCopy = true
        return
      }

      if (inCopy && t === '\\.') {
        if (currentTable && copyData.length > 0) {
          // Process in batches to avoid memory issues
          for (let i = 0; i < copyData.length; i += COPY_BATCH_SIZE) {
            const batch = copyData.slice(i, i + COPY_BATCH_SIZE)
            const insertColumns = currentColumns.length > 0 ? `(${currentColumns.join(', ')})` : ''
            const values = batch.map(row => formatCopyRowAsValues(row)).join(',\n')
            const insertStmt = `INSERT INTO ${currentTable} ${insertColumns} VALUES\n${values}`

            outputStream.write(insertStmt + '\n')
            stats.copyRowsConverted += batch.length
            copyRowsConverted += batch.length
          }

          if (copyData.length >= 10000) {
            logInfo(`Converted ${copyData.length} COPY rows to INSERTs for ${currentTable}`)
          }
        }

        currentTable = null
        currentColumns = []
        copyData = []
        inCopy = false
        return
      }

      if (inCopy) {
        if (t) {
          copyData.push(t)

          if (copyData.length >= COPY_BATCH_SIZE * 10) {
            const insertColumns = currentColumns.length > 0 ? `(${currentColumns.join(', ')})` : ''
            const values = copyData.map(row => formatCopyRowAsValues(row)).join(',\n')
            const insertStmt = `INSERT INTO ${currentTable} ${insertColumns} VALUES\n${values}`

            outputStream.write(insertStmt + '\n')
            stats.copyRowsConverted += copyData.length
            copyRowsConverted += copyData.length

            logInfo(`Converted ${copyData.length} COPY rows for ${currentTable} (partial batch)`)
            copyData = []
          }
        }
        return
      }

      if (/^\s*(DROP|CREATE|ALTER)\s+DATABASE/i.test(t)) {
        stats.dbCommandsSkipped++
        return
      }
      if (/^\s*COMMENT\s+ON\s+DATABASE/i.test(t)) {
        stats.dbCommandsSkipped++
        return
      }

      let processedLine = line.replace(new RegExp(sourceDb, 'g'), targetDb)

      if (/^\s*CREATE\s+TABLE\s+/i.test(t)) {
        processedLine = processedLine.replace(/CREATE\s+TABLE\s+("?[\w\.]+"?)/i,
          'CREATE TABLE IF NOT EXISTS $1')
      }
      else if (/^\s*CREATE\s+INDEX\s+/i.test(t)) {
        processedLine = processedLine.replace(/CREATE\s+INDEX\s+("?[\w\.]+"?)/i,
          'CREATE INDEX IF NOT EXISTS $1')
      }
      else if (/^\s*CREATE\s+SEQUENCE\s+/i.test(t)) {
        processedLine = processedLine.replace(/CREATE\s+SEQUENCE\s+("?[\w\.]+"?)/i,
          'CREATE SEQUENCE IF NOT EXISTS $1')
      }

      if (/ALTER\s+TABLE\s+.*\s+ADD\s+CONSTRAINT/i.test(t)) {
        stats.constraintsSkipped++
        outputStream.write(`-- SKIPPED CONSTRAINT: ${line}\n`) // Comment it out instead of removing
        return
      }

      if (/CREATE\s+UNIQUE\s+INDEX/i.test(t)) {
        stats.constraintsSkipped++
        outputStream.write(`-- SKIPPED UNIQUE INDEX: ${line}\n`)
        return
      }

      if (/REFERENCES\s+/i.test(t) && /CREATE\s+TABLE/i.test(t)) {
        processedLine = processedLine.replace(/REFERENCES\s+[^,)]+/gi, '/* CONSTRAINT DISABLED */ ')
      }

      outputStream.write(processedLine + '\n')
    })

    rl.on('close', () => {
      if (EXCLUDE_ETL_TABLES && isEtlDatabase) {
        logInfo(`ETL Protection: Skipped ${etlTablesSkipped} operations on ETL tables`)
        stats.etlTablesSkipped = etlTablesSkipped
      }
      
      logInfo(`Processed ${lineCount} lines (${stats.originalInsertCount} original INSERTs, ${copyRowsConverted} rows from COPY converted)`)
      outputStream.end()
      resolve(stats)
    })

    rl.on('error', (err) => {
      reject(err)
    })

    outputStream.on('error', (err) => {
      reject(err)
    })
  })
}

function formatCopyRowAsValues(row) {
  const cells = row.split('\t')
  const formattedCells = cells.map(cell => {
    // Handle NULL values
    if (cell === '\\N' || cell.toLowerCase() === 'null') {
      return 'NULL'
    }

    if (cell.toLowerCase() === 'true' || cell === 't') {
      return 'true'
    }
    if (cell.toLowerCase() === 'false' || cell === 'f') {
      return 'false'
    }

    // Handle numeric values - leave them unquoted
    if (/^-?\d+(\.\d+)?$/.test(cell)) {
      return cell
    }
    // Also escape any backslashes in the data
    return `'${cell.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
  })

  return `(${formattedCells.join(', ')})`
}

function getProcessedSqlPath(sourceDbName) {
  const tempSqlFile = path.join(os.tmpdir(), `processed_${sourceDbName}_full.sql`)
  return fs.existsSync(tempSqlFile) ? tempSqlFile : null
}

module.exports = {
  processForAzure,
  getProcessedSqlPath
}