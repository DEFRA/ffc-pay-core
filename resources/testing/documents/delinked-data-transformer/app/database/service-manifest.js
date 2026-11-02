const { getEnvironmentSuffix } = require('./db-connection')

const services = [
  'ffc-pay-alerting',
  'ffc-pay-batch-processor',
  'ffc-pay-demographics',
  'ffc-pay-dps',
  'ffc-pay-enrichment',
  'ffc-pay-event-hub',
  'ffc-pay-injection',
  'ffc-pay-processing',
  'ffc-pay-request-editor',
  'ffc-pay-responses',
  'ffc-pay-submission',
  'ffc-pay-tracking',
  'fcp-pds-data-retention'
]

function buildServiceManifest (sourceEnvironment = 'prd', targetEnvironment = 'pre') {
  const sourceSuffix = getEnvironmentSuffix(sourceEnvironment)
  const targetSuffix = getEnvironmentSuffix(targetEnvironment)

  return {
    services: services.map(baseDbName => ({
      name: baseDbName,
      baseDbName,
      sourceDbName: `${baseDbName}${sourceSuffix}`,
      targetDbName: `${baseDbName}${targetSuffix}`
    }))
  }
}

module.exports = {
  services,
  buildServiceManifest,
  ...buildServiceManifest()
}
