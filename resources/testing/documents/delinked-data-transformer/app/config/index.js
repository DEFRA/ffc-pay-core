const fs = require('fs')
const path = require('path')

const defaultConfig = require('./default')
const scenarios = require('./scenarios')

const projectRootConfigPath = path.resolve(process.cwd(), 'app/config/local.js')
const moduleRelativeConfigPath = path.resolve(__dirname, 'local.js')
const configPath = fs.existsSync(projectRootConfigPath) ? projectRootConfigPath : moduleRelativeConfigPath

function getScenarioConfig (scenarioName) {
  if (!scenarioName) return {}
  return scenarios[scenarioName] || {}
}

function loadConfig () {
  const runtimeConfig = fs.existsSync(configPath) ? require(configPath) : {}
  const requestedScenario = process.env.DB_SCENARIO || runtimeConfig.scenario || defaultConfig.scenario || 'test-to-dev'
  const scenarioConfig = getScenarioConfig(requestedScenario)

  const merged = {
    ...defaultConfig,
    ...scenarioConfig,
    ...runtimeConfig,
    dump: {
      ...defaultConfig.dump,
      ...(scenarioConfig.dump || {}),
      ...(runtimeConfig.dump || {})
    },
    database: {
      ...defaultConfig.database,
      ...(scenarioConfig.database || {}),
      ...(runtimeConfig.database || {}),
      environments: {
        ...(defaultConfig.database?.environments || {}),
        ...(scenarioConfig.database?.environments || {}),
        ...(runtimeConfig.database?.environments || {})
      }
    }
  }

  const sourceEnvironment = process.env.DB_SOURCE_ENV || merged.sourceEnvironment || defaultConfig.sourceEnvironment
  const targetEnvironment = process.env.DB_TARGET_ENV || merged.targetEnvironment || defaultConfig.targetEnvironment

  return {
    ...merged,
    scenario: requestedScenario,
    sourceEnvironment,
    targetEnvironment,
    database: {
      ...merged.database,
      port: Number(process.env.POSTGRES_PORT || merged.database.port || defaultConfig.database.port),
      ssl: process.env.POSTGRES_SSL !== undefined ? process.env.POSTGRES_SSL === 'true' : merged.database.ssl
    }
  }
}

module.exports = loadConfig()
