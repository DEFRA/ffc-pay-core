const SOURCE_ENV = 'prd'
const TARGET_ENV = 'local'

// Base database names only; the selected environments are appended by the profile resolver.
const DATABASE_NAMES = [
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

module.exports = {
  SOURCE_ENV,
  TARGET_ENV,
  DATABASE_NAMES
}
