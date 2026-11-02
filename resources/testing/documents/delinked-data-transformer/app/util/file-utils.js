const fs = require('fs')
const path = require('path')
const { logInfo } = require('./logger')
const { getEnvironmentSuffix, normaliseEnvironmentName } = require('../database/db-connection')
const appConfig = require('../config')

function replaceEnvironmentSuffix (databaseName, sourceEnvironment, targetEnvironment) {
  const sourceSuffix = getEnvironmentSuffix(sourceEnvironment)
  const targetSuffix = getEnvironmentSuffix(targetEnvironment)

  if (!databaseName || !databaseName.endsWith(sourceSuffix)) {
    return databaseName
  }

  return databaseName.slice(0, -sourceSuffix.length) + targetSuffix
}

// Use the dump directory inside the app folder, consistent with other utilities
function findSqlDumpFiles (baseDir = path.resolve(__dirname, '../test-dumps'), pattern = '_full.sql', options = {}) {
  const sourceEnvironment = normaliseEnvironmentName(options.sourceEnvironment || process.env.DB_SOURCE_ENV || appConfig.sourceEnvironment || 'test')
  const targetEnvironment = normaliseEnvironmentName(options.targetEnvironment || process.env.DB_TARGET_ENV || appConfig.targetEnvironment || 'dev')
  const sourceSuffix = getEnvironmentSuffix(sourceEnvironment)
  const dumpsDir = baseDir

  logInfo(`Looking for SQL dump files in: ${dumpsDir} (source=${sourceEnvironment}, target=${targetEnvironment})`)

  if (!fs.existsSync(dumpsDir)) {
    logInfo(`SQL dump directory does not exist: ${dumpsDir}`)
    return []
  }

  const directories = fs.readdirSync(dumpsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  logInfo(`Found ${directories.length} database directories to process`)

  return directories
    .filter(dir => dir.endsWith(sourceSuffix))
    .map(sourceDbName => {
      const targetDbName = replaceEnvironmentSuffix(sourceDbName, sourceEnvironment, targetEnvironment)
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
