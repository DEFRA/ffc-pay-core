const { createConnection } = require('./db-connection')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

async function backupDatabase (dbName, backupDir, dryRun = false) {
  if (dryRun) {
    logInfo(`[DRY RUN] Would backup database ${dbName} to directory ${backupDir}`)
    return { success: true, backupPath: `${backupDir}/${dbName}_${new Date().toISOString().replace(/:/g, '-')}.sql` }
  }

  const resolvedBackupDir = path.resolve(__dirname, backupDir)
  if (!fs.existsSync(resolvedBackupDir)) fs.mkdirSync(resolvedBackupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(resolvedBackupDir, `${dbName}_backup_${timestamp}.dump`)

  const connection = await createConnection(dbName)
  const { host, port, username } = connection.config
  const env = { ...process.env, PGPASSWORD: connection.token }

  return new Promise((resolve, reject) => {
    const args = [
      '-h', host,
      '-p', port,
      '-U', username,
      '-Fc', // custom format
      '-Z', '9', // max compression
      '-f', backupFile,
      dbName
    ]
    console.log(`[${new Date().toISOString()}] Starting backup for database: ${dbName}`)
    const dump = spawn('pg_dump', args, { env })

    dump.stdout.on('data', data => process.stdout.write(`[pg_dump] ${data}`))
    dump.stderr.on('data', data => process.stderr.write(`[pg_dump] ${data}`))
    dump.on('close', code => {
      if (code === 0) {
        console.log(`[${new Date().toISOString()}] Backup complete: ${backupFile}`)
        resolve(backupFile)
      } else {
        reject(new Error(`pg_dump failed with code ${code}`))
      }
    })
  })
}

async function restoreDatabase (dbName, backupFile) {
  const connection = await createConnection(dbName)
  const { host, port, username } = connection.config
  const env = { ...process.env, PGPASSWORD: connection.token }

  return new Promise((resolve, reject) => {
    const args = [
      '-h', host,
      '-p', port,
      '-U', username,
      '-d', dbName,
      '--clean', // drop objects before recreating
      backupFile
    ]
    console.log(`[${new Date().toISOString()}] Starting restore for database: ${dbName} from file: ${backupFile}`)
    const restore = spawn('pg_restore', args, { env })

    restore.stdout.on('data', data => process.stdout.write(`[pg_restore] ${data}`))
    restore.stderr.on('data', data => process.stderr.write(`[pg_restore] ${data}`))
    restore.on('close', code => {
      if (code === 0) {
        console.log(`[${new Date().toISOString()}] Restore complete for ${dbName}`)
        resolve()
      } else {
        reject(new Error(`pg_restore failed with code ${code}`))
      }
    })
  })
}

// Example usage (run from CLI):
if (require.main === module) {
  const [,, action, dbName, backupFile] = process.argv
  if (action === 'backup' && dbName) {
    backupDatabase(dbName)
      .then(() => process.exit(0))
      .catch(err => { console.error(err); process.exit(1) })
  } else if (action === 'restore' && dbName && backupFile) {
    restoreDatabase(dbName, backupFile)
      .then(() => process.exit(0))
      .catch(err => { console.error(err); process.exit(1) })
  } else {
    console.log('Usage:')
    console.log('  node backup-restore.js backup <dbName>')
    console.log('  node backup-restore.js restore <dbName> <backupFile>')
    process.exit(1)
  }
}

module.exports = { backupDatabase, restoreDatabase }
