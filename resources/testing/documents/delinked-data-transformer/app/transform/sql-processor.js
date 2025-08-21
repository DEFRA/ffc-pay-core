const fs = require('fs')
const readline = require('readline')
const os = require('os')
const path = require('path')
const { logInfo, logProgress } = require('../util/logger')
const { EXCLUDE_ETL_TABLES, ETL_DATABASES, PROTECTED_TABLES } = require('../constants/etl-protection')

async function processForAzure (filePath, sourceDbName, targetDbName, dataOnlyMode = false, dryRun = false) {
  if (dryRun) {
    logInfo(`[DRY RUN] Would process SQL file ${filePath} for Azure compatibility`)

    return {
      processedFilePath: `${filePath}.processed.sql`,
      stats: {
        copyBlocksConverted: 'X (dry run)',
        copyRowsConverted: 'X (dry run)'
      }
    }
  }
  const tempSqlFile = path.join(os.tmpdir(), `processed_${path.basename(filePath)}`)
  const outputStream = fs.createWriteStream(tempSqlFile)

  logInfo(`Processing SQL file for Azure compatibility: ${filePath}`)
  if (dataOnlyMode) {
    logInfo('🔄 DATA-ONLY MODE: Schema statements will be filtered out')
  }

  try {
    outputStream.write('-- Disable triggers and constraints for faster import\n')
    outputStream.write('SET session_replication_role = replica;\n\n')
    outputStream.write('-- Processing dump file for better insertion\n\n')

    const stats = await processLargeFile(filePath, outputStream, sourceDbName, targetDbName, dataOnlyMode)

    outputStream.write('\n-- Re-enable triggers and constraints\n')
    outputStream.write('SET session_replication_role = DEFAULT\n')

    logInfo(`Processed SQL written to ${tempSqlFile}`)

    if (EXCLUDE_ETL_TABLES && ETL_DATABASES.some(db => sourceDbName.toLowerCase() === db.toLowerCase())) {
      logInfo('🔍 ETL VERIFICATION: Performing final ETL protection verification...')
      const etlVerification = await verifyNoOperationsOnProtectedTables(tempSqlFile, 'etl')
      if (!etlVerification.safe) {
        throw new Error(`⚠️ CRITICAL SAFETY ERROR: Found ${etlVerification.count} unfiltered ETL operations!`)
      }
      logInfo('✅ ETL VERIFICATION: No ETL operations found in processed SQL')
    }

    logInfo('🔍 LIQUIBASE VERIFICATION: Performing final Liquibase protection verification...')
    const liquibaseVerification = await verifyNoOperationsOnProtectedTables(tempSqlFile, 'liquibase')
    if (!liquibaseVerification.safe) {
      throw new Error(`⚠️ CRITICAL SAFETY ERROR: Found ${liquibaseVerification.count} unfiltered Liquibase operations!`)
    }
    logInfo('✅ LIQUIBASE VERIFICATION: No Liquibase operations found in processed SQL')

    return {
      processedFilePath: tempSqlFile,
      stats
    }
  } catch (error) {
    logInfo(`Error processing SQL file: ${error.message}`)
    throw error
  }
}

async function verifyNoOperationsOnProtectedTables (sqlFile, protectionType) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(sqlFile, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    })

    let dangerous = false
    let count = 0
    const dangerousLines = []

    let pattern
    if (protectionType === 'etl') {
      pattern = /(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\s+(?:public\.)?("?etl[^"]*"?|etl[^\s(]*)/i
    } else if (protectionType === 'liquibase') {
      const liquibaseTables = PROTECTED_TABLES.join('|')
      pattern = new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)\\s+(?:public\\.)?("?(${liquibaseTables})"?|(${liquibaseTables})[\\s,);])`, 'i')
    }

    rl.on('line', (line) => {
      if (pattern && pattern.test(line)) {
        dangerous = true
        count++
        dangerousLines.push(line)
      }
    })

    rl.on('close', () => {
      if (dangerous) {
        logInfo(`⚠️ ${protectionType.toUpperCase()} PROTECTION VIOLATION: Found ${count} operations on protected tables!`)
        dangerousLines.forEach((line, i) => {
          if (i < 5) logInfo(`  ${i + 1}: ${line.substring(0, 100)}...`)
        })
        if (dangerousLines.length > 5) {
          logInfo(`  ... and ${dangerousLines.length - 5} more violations`)
        }
      }
      resolve({
        safe: !dangerous,
        count,
        lines: dangerous ? dangerousLines : []
      })
    })

    rl.on('error', (err) => {
      reject(err)
    })
  })
}

async function processLargeFile (inputFile, outputStream, sourceDb, targetDb, dataOnlyMode = false) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(inputFile, { encoding: 'utf8' })
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    })

    const stats = {
      lines: 0,
      originalInserts: 0,
      copyRowsConverted: 0,
      copyBlocksConverted: 0,
      commentLines: 0,
      schemaStatementsSkipped: 0,
      liquibaseStatementsSkipped: 0
    }

    let inCopy = false
    let currentCopyTable = ''
    let currentCopyColumns = []
    let copyBuffer = []
    let skipLine = false
    let collectingCopyData = false
    const lineBuffer = ''
    let skipCurrentStatement = false
    let currentStatement = ''

    const isEtlDatabase = ETL_DATABASES.some(db => sourceDb.toLowerCase() === db.toLowerCase())
    const etlTablePattern = /^(?:public\.)?(["']?etl[^"']*["']?|etl[^\s(]*)/i

    const liquibaseTablePattern = new RegExp(`^(?:public\\.)?(?:["']?(${PROTECTED_TABLES.join('|')})["']?|(${PROTECTED_TABLES.join('|')})[\\s,);])`, 'i')

    rl.on('line', (line) => {
      stats.lines++

      if (line.trim().startsWith('--')) {
        stats.commentLines++
        outputStream.write(line + '\n')
        return
      }

      if (dataOnlyMode && !inCopy) {
        if (!skipCurrentStatement) {
          if (line.trim().match(/^(CREATE|ALTER|DROP|COMMENT ON)/i)) {
            skipCurrentStatement = true
            currentStatement = line
            stats.schemaStatementsSkipped++
            return
          }
        } else {
          currentStatement += line

          if (line.trim().endsWith(';')) {
            skipCurrentStatement = false
            outputStream.write(`-- DATA-ONLY MODE: Skipped schema statement: ${currentStatement.substring(0, 50)}...\n`)
          }
          return
        }
      }

      if (EXCLUDE_ETL_TABLES && isEtlDatabase) {
        const match = line.match(etlTablePattern)
        if (match && !line.trim().startsWith('--')) {
          const t = match[1]
          if (line.match(/(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)/i)) {
            skipLine = true
            outputStream.write(`-- ⚠️ ETL PROTECTION: EXCLUDED OPERATION: ${line}\n`)
            return
          }
        }
      }

      const liquibaseMatch = line.match(liquibaseTablePattern)
      if (liquibaseMatch && !line.trim().startsWith('--')) {
        if (line.match(/(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|COPY)/i)) {
          skipLine = true
          stats.liquibaseStatementsSkipped++
          outputStream.write(`-- ⚠️ LIQUIBASE PROTECTION: EXCLUDED OPERATION: ${line}\n`)
          return
        }
      }

      if (line.startsWith('COPY ') && line.includes(' FROM stdin;')) {
        inCopy = true
        collectingCopyData = true
        copyBuffer = []

        const copyMatch = line.match(/COPY\s+([\w."]+)\s*\((.*?)\)\s+FROM\s+stdin;/)
        if (copyMatch) {
          currentCopyTable = copyMatch[1]
          currentCopyColumns = copyMatch[2].split(',').map(col => col.trim())

          const tableName = currentCopyTable.replace(/^public\./, '').replace(/"/g, '')
          if (PROTECTED_TABLES.some(t => t.toLowerCase() === tableName.toLowerCase())) {
            logInfo(`⚠️ LIQUIBASE PROTECTION: Skipping COPY block for ${currentCopyTable}`)
            skipLine = true
            return
          }

          outputStream.write(`-- Converting COPY to INSERTs for table ${currentCopyTable}\n`)
          stats.copyBlocksConverted++
        } else {
          logInfo(`Warning: Could not parse COPY statement: ${line}`)
          outputStream.write(line + '\n')
        }
        return
      }

      if (inCopy) {
        if (line === '\\.') {
          inCopy = false

          if (skipLine) {
            skipLine = false
            return
          }

          let currentInsert = `INSERT INTO ${currentCopyTable} (${currentCopyColumns.join(', ')}) VALUES\n`
          const VALUES_PER_INSERT = 500 // Adjust based on performance needs
          let valueCount = 0

          copyBuffer.forEach((row, index) => {
            const formattedRow = formatCopyRowAsValues(row)

            if (valueCount > 0) {
              currentInsert += ',\n'
            }

            currentInsert += formattedRow
            valueCount++

            if (valueCount >= VALUES_PER_INSERT && index < copyBuffer.length - 1) {
              currentInsert += ';\n'
              outputStream.write(currentInsert)
              currentInsert = `INSERT INTO ${currentCopyTable} (${currentCopyColumns.join(', ')}) VALUES\n`
              valueCount = 0

              if (copyBuffer.length >= 10000 && index % 10000 === 0) {
                logInfo(`Converted ${index} COPY rows for ${currentCopyTable} (partial batch)`)
              }
            }
          })

          if (valueCount > 0) {
            currentInsert += ';'
            outputStream.write(currentInsert + '\n')
          }

          stats.copyRowsConverted += copyBuffer.length
          collectingCopyData = false
          return
        }

        if (collectingCopyData && line.trim() !== '' && !skipLine) {
          copyBuffer.push(line)
        }
        return
      }

      if (!skipLine) {
        outputStream.write(line + '\n')

        if (line.trim().startsWith('INSERT INTO')) {
          stats.originalInserts++
        }
      } else {
        skipLine = false
      }
    })

    rl.on('close', () => {
      logInfo(`Processed ${stats.lines} lines (${stats.originalInserts} original INSERTs, ${stats.copyRowsConverted} rows from COPY converted)`)
      if (dataOnlyMode) {
        logInfo(`Skipped ${stats.schemaStatementsSkipped} schema statements in data-only mode`)
      }
      if (stats.liquibaseStatementsSkipped > 0) {
        logInfo(`Protected ${stats.liquibaseStatementsSkipped} Liquibase statements`)
      }
      resolve(stats)
    })

    rl.on('error', (err) => {
      reject(err)
    })
  })
}

function formatCopyRowAsValues (row) {
  const cells = row.split('\t')
  const formattedCells = cells.map(cell => {
    if (cell === '\\N') {
      return 'NULL'
    }

    const needsQuoting = !/^-?\d+(\.\d+)?$/.test(cell) &&
                       cell !== 'true' &&
                       cell !== 'false' &&
                       cell !== 'NULL' &&
                       !cell.startsWith('\'') &&
                       !cell.endsWith('\'')

    if (needsQuoting) {
      const escaped = cell.replace(/'/g, "''")
      return `'${escaped}'`
    }

    return cell
  })

  return `(${formattedCells.join(', ')})`
}

function getProcessedSqlPath (sourceDbName) {
  const tempSqlFile = path.join(os.tmpdir(), `processed_${sourceDbName}_full.sql`)
  return fs.existsSync(tempSqlFile) ? tempSqlFile : null
}

module.exports = {
  processForAzure,
  getProcessedSqlPath
}
