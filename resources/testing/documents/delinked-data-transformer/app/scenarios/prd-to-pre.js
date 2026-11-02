const { streamPrdToPre } = require('../database/stream-prd-to-pre')
const { buildServiceManifest } = require('../database/service-manifest')

async function runScenario (options = {}) {
  const {
    dryRun = false,
    testConnection = false,
    sourceEnvironment = 'prd',
    targetEnvironment = 'pre',
    sourceDbName,
    targetDbName,
    includeLiquibaseTables = false
  } = options

  console.log('Running scenario: prd-to-pre')
  console.log({ sourceEnvironment, targetEnvironment, sourceDbName, targetDbName, dryRun, testConnection, includeLiquibaseTables })

  if (testConnection) {
    console.log('Connection-only test requested; skipping data copy.')
  }

  const serviceName = sourceDbName?.replace(/-(prd|pre|test|dev|recovery)$/i, '') || 'unknown'
  const manifest = buildServiceManifest(sourceEnvironment, targetEnvironment)
  const service = manifest.services.find(s => s.name === serviceName || s.baseDbName === serviceName)

  const resolvedSourceDbName = sourceDbName || service?.sourceDbName
  const resolvedTargetDbName = targetDbName || service?.targetDbName

  if (!resolvedSourceDbName) {
    throw new Error('sourceDbName is required for prd-to-pre flow; provide it explicitly or from the service manifest.')
  }

  const result = await streamPrdToPre({
    dryRun,
    sourceEnvironment,
    targetEnvironment,
    sourceDbName: resolvedSourceDbName,
    targetDbName: resolvedTargetDbName,
    includeLiquibaseTables
  })

  return {
    scenario: 'prd-to-pre',
    sourceEnvironment,
    targetEnvironment,
    sourceDbName: resolvedSourceDbName,
    targetDbName: result?.targetDbName || resolvedTargetDbName,
    dryRun,
    testConnection,
    result
  }
}

module.exports = {
  runScenario
}
