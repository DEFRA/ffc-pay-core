const fs = require('fs')
const path = require('path')
const { logInfo } = require('./logger')

function findSqlDumpFiles (baseDir = '../../test-dumps/', pattern = '_full.sql') {
  const dumpsDir = path.resolve(__dirname, baseDir)
  logInfo(`Looking for SQL dump files in: ${dumpsDir}`)

  if (!fs.existsSync(dumpsDir)) {
    logInfo(`SQL dump directory does not exist: ${dumpsDir}`)
    return []
  }

  const directories = fs.readdirSync(dumpsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  logInfo(`Found ${directories.length} database directories to process`)

  return directories
    .filter(dir => dir.endsWith('-test')) // only handle names ending in -test
    .map(sourceDbName => {
      const targetDbName = sourceDbName.replace(/-test$/, '-dev')
      const filePath = path.join(dumpsDir, sourceDbName, `${sourceDbName}${pattern}`)

      return {
        sourceDbName,
        targetDbName,
        filePath,
        exists: fs.existsSync(filePath)
      }
    })
    .filter(item => item.exists)
}

function safeRemoveFile (filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
    logInfo(`Removed file: ${filePath}`)
  }
}

module.exports = {
  findSqlDumpFiles,
  safeRemoveFile
}