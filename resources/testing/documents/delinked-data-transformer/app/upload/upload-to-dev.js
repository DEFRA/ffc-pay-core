const { listDatabases } = require('../database/db-connection')
const { findSqlDumpFiles } = require('../util/file-utils')
const { logInfo, logError } = require('../util/logger')
const path = require('path')
const fs = require('fs')
const readline = require('readline')
const { backupDatabase, restoreDatabase, truncateTable } = require('../database/backup-and-restore')

// Utility to extract table names from COPY statements in a .sql file (streaming, memory-efficient)
async function getTablesFromSqlDump(filePath) {
  return new Promise((resolve, reject) => {
    const tables = new Set()
    const regex = /^COPY\s+([^\s(]+)\s*\(/i
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      const match = regex.exec(line)
      if (match) tables.add(match[1])
    })

    rl.on('error', reject)
    rl.on('close', () => resolve(Array.from(tables)))
  })
}

async function uploadToDev(type = 'all', dryRun = false) {
  logInfo(`Starting upload for type: ${type} (dryRun: ${dryRun})`)
  let dbPatterns = []
  if (type === 'ffc-pay') dbPatterns = ['ffc-pay-%-dev', 'ffc-pay-%-test']
  else if (type === 'ffc-doc') dbPatterns = ['ffc-doc-%-dev', 'ffc-doc-%-test']
  else dbPatterns = ['ffc-doc-%-dev', 'ffc-pay-%-dev', 'ffc-doc-%-test', 'ffc-pay-%-test']

  const targetDatabases = await listDatabases(dbPatterns)
  logInfo(`Found ${targetDatabases.length} target databases.`)

  const databaseFiles = findSqlDumpFiles().filter(({ sourceDbName }) => {
    if (type === 'ffc-pay') return sourceDbName.startsWith('ffc-pay')
    if (type === 'ffc-doc') return sourceDbName.startsWith('ffc-doc')
    return true
  })

  const backupDir = path.resolve(__dirname, '../../dev-backups')
  let successCount = 0
  let errorCount = 0

  for (const { targetDbName, filePath } of databaseFiles) {
    if (!targetDatabases.includes(targetDbName)) {
      logInfo(`Skipping ${targetDbName} (not in target list)`)
      continue
    }
    try {
      // Backup database (returns backup file path)
      await backupDatabase(targetDbName, backupDir, dryRun)
      // Efficiently find all tables to truncate
      const tablesToTruncate = await getTablesFromSqlDump(filePath)
      for (const tableName of tablesToTruncate) {
        try {
          await truncateTable(targetDbName, tableName)
        } catch (truncateErr) {
          logError(`❌ Truncate failed for ${tableName} in ${targetDbName}: ${truncateErr.message}`)
        }
      }
      // Restore anonymized dump file
      await restoreDatabase(targetDbName, filePath, dryRun)
      successCount++
    } catch (err) {
      logError(`❌ Error processing ${targetDbName}: ${err.message}`)
      errorCount++
    }
  }
  logInfo(`Upload process complete. Success: ${successCount}, Failures: ${errorCount}`)
}

module.exports = { uploadToDev }

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true'
  const type = process.argv[2] || 'all'
  uploadToDev(type, dryRun)
    .then(() => logInfo('All uploads finished'))
    .catch(err => {
      logError('Upload process failed:', err)
      process.exit(1)
    })
}
