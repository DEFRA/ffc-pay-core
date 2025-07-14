const { createConnection } = require('./db-connection')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

function logInfo(msg) { console.log(`[INFO] ${msg}`) }
function logError(msg) { console.error(`[ERROR] ${msg}`) }

async function backupDatabase(dbName, backupDir, dryRun = false) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resolvedBackupDir = path.resolve(backupDir)
  if (!fs.existsSync(resolvedBackupDir)) fs.mkdirSync(resolvedBackupDir, { recursive: true })
  const backupFile = path.join(resolvedBackupDir, `${dbName}_backup_${timestamp}.dump`)

  if (dryRun) {
    logInfo(`[DRY RUN] Would backup database ${dbName} to ${backupFile}`)
    return backupFile
  }

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
    logInfo(`Backing up ${dbName} to ${backupFile}`)
    const dump = spawn('pg_dump', args, { env })

    dump.stderr.on('data', data => process.stderr.write(`[pg_dump] ${data}`))
    dump.on('close', code => {
      if (code === 0) {
        logInfo(`✅ Backup complete: ${backupFile}`)
        resolve(backupFile)
      } else {
        logError(`❌ Backup failed for ${dbName} (exit code ${code})`)
        reject(new Error(`pg_dump failed with code ${code}`))
      }
    })
    dump.on('error', err => {
      logError(`❌ Error running pg_dump: ${err.message}`)
      reject(err)
    })
  })
}

async function restoreDatabase(dbName, backupFile, dryRun = false) {
  if (dryRun) {
    logInfo(`[DRY RUN] Would restore ${backupFile} to database ${dbName}`)
    return
  }

  const connection = await createConnection(dbName)
  const { host, port, username } = connection.config
  const env = { ...process.env, PGPASSWORD: connection.token }

  // Detect file format by extension
  const isSql = backupFile.endsWith('.sql')

  return new Promise((resolve, reject) => {
    let restore, args
    if (isSql) {
      args = [
        '-h', host,
        '-p', port,
        '-U', username,
        '-d', dbName,
        '-f', backupFile
      ]
      logInfo(`Restoring (psql) ${backupFile} to ${dbName}`)
      restore = spawn('psql', args, { env })
    } else {
      args = [
        '-h', host,
        '-p', port,
        '-U', username,
        '-d', dbName,
        '--clean',
        backupFile
      ]
      logInfo(`Restoring (pg_restore) ${backupFile} to ${dbName}`)
      restore = spawn('pg_restore', args, { env })
    }

    restore.stderr.on('data', data => process.stderr.write(`[restore] ${data}`))
    restore.on('close', code => {
      if (code === 0) {
        logInfo(`✅ Restore complete for ${dbName}`)
        resolve()
      } else {
        logError(`❌ Restore failed for ${dbName} (exit code ${code})`)
        reject(new Error(`${isSql ? 'psql' : 'pg_restore'} failed with code ${code}`))
      }
    })
    restore.on('error', err => {
      logError(`❌ Error running restore: ${err.message}`)
      reject(err)
    })
  })
}

async function truncateTable(dbName, tableName) {
  const connection = await createConnection(dbName)
  const { host, port, username } = connection.config
  const env = { ...process.env, PGPASSWORD: connection.token }
  return new Promise((resolve, reject) => {
    const args = [
      '-h', host,
      '-p', port,
      '-U', username,
      '-d', dbName,
      '-c', `TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE;`
    ]
    logInfo(`Truncating table ${tableName} in ${dbName}`)
    const psql = spawn('psql', args, { env })
    psql.stderr.on('data', data => process.stderr.write(`[psql] ${data}`))
    psql.on('close', code => {
      if (code === 0) {
        logInfo(`✅ Truncate complete for ${tableName} in ${dbName}`)
        resolve()
      } else {
        logError(`❌ Truncate failed for ${tableName} in ${dbName} (exit code ${code})`)
        reject(new Error(`psql truncate failed with code ${code}`))
      }
    })
    psql.on('error', err => {
      logError(`❌ Error running psql truncate: ${err.message}`)
      reject(err)
    })
  })
}

module.exports = { backupDatabase, restoreDatabase, truncateTable }