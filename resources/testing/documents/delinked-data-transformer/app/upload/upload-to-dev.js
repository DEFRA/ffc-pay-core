const { listDatabases } = require('../database/db-connection')
const { findSqlDumpFiles } = require('../util/file-utils')
const { logInfo, logError } = require('../util/logger')
const path = require('path')
const fs = require('fs')
const { backupDatabase, restoreDatabase, truncateTable } = require('../database/backup-and-restore')

// Utility to extract table names from COPY statements in a .sql file
function getTablesFromSqlDump(filePath) {
  const sql = fs.readFileSync(filePath, 'utf8')
  const regex = /^COPY\s+([^\s(]+)\s*\(/gm
  const tables = new Set()
  let match
  while ((match = regex.exec(sql)) !== null) {
    tables.add(match[1])
  }
  return Array.from(tables)
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
      // Automatically find all tables to truncate
      const tablesToTruncate = getTablesFromSqlDump(filePath)
      for (const tableName of tablesToTruncate) {
        await truncateTable(targetDbName, tableName)
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