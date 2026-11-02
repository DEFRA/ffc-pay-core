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

const LOCAL_DATABASE_TARGETS = {
  'ffc-pay-event-hub': {
    databaseName: 'ffc_pay_event_hub',
    port: 5443
  },
  'ffc-pay-alerting': {
    databaseName: 'ffc_pay_alerting',
    port: 5492
  },
  'ffc-pay-batch-processor': {
    databaseName: 'ffc_pay_batch_processor',
    port: 5436
  },
  'ffc-pay-demographics': {
    databaseName: 'ffc_pay_demographics',
    port: 5423
  },
  'ffc-pay-dps': {
    databaseName: 'ffc_pay_dps',
    port: 5442
  },
  'ffc-pay-enrichment': {
    databaseName: 'ffc_pay_enrichment',
    port: 5441
  },
  'ffc-pay-injection': {
    databaseName: 'ffc_pay_injection',
    port: 5422
  },
  'ffc-pay-processing': {
    databaseName: 'ffc_pay_processing',
    port: 5490
  },
  'ffc-pay-request-editor': {
    databaseName: 'ffc_pay_request_editor',
    port: 5425
  },
  'ffc-pay-responses': {
    databaseName: 'ffc_pay_responses',
    port: 5420
  },
  'ffc-pay-submission': {
    databaseName: 'ffc_pay_submission',
    port: 5438
  },
  'ffc-pay-tracking': {
    databaseName: 'ffc_pay_tracking',
    port: 5440
  },
  'fcp-pds-data-retention': {
    databaseName: 'fcp_pds_data_retention',
    port: 5462
  }
}

module.exports = {
  SOURCE_ENV,
  TARGET_ENV,
  DATABASE_NAMES,
  LOCAL_DATABASE_TARGETS
}
