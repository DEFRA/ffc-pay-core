const DEFAULT_SOURCE_ENV = 'prd'
const DEFAULT_TARGET_ENV = 'local'

const resolveRefreshEnvironments = (environment = process.env) => {
  const sourceEnvironment = environment.DATABASE_REFRESH_SOURCE_ENV
  const targetEnvironment = environment.DATABASE_REFRESH_TARGET_ENV

  return {
    SOURCE_ENV: typeof sourceEnvironment === 'string' && sourceEnvironment.trim() ? sourceEnvironment.trim() : DEFAULT_SOURCE_ENV,
    TARGET_ENV: typeof targetEnvironment === 'string' && targetEnvironment.trim() ? targetEnvironment.trim() : DEFAULT_TARGET_ENV
  }
}

const { SOURCE_ENV, TARGET_ENV } = resolveRefreshEnvironments()
const DEFAULT_SOURCE_AUTH = 'entra'
const DEFAULT_HOSTED_TARGET_AUTH = 'entra'
const DATABASE_AUTH_OVERRIDES = {}

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
  'fcp-pds-data-retention',
  'ffc-doc-statement-data',
  'ffc-doc-statement-constructor',
  'ffc-doc-statement-generator',
  'ffc-doc-statement-publisher'
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
  },
  'ffc-doc-statement-data': {
    databaseName: 'ffc_doc_statement_data',
    port: 5482
  },
  'ffc-doc-statement-constructor': {
    databaseName: 'ffc_doc_statement_constructor',
    port: 5486
  },
  'ffc-doc-statement-generator': {
    databaseName: 'ffc_doc_statement_generator',
    port: 5488
  },
  'ffc-doc-statement-publisher': {
    databaseName: 'ffc_doc_statement_publisher',
    port: 5487
  }
}

module.exports = {
  resolveRefreshEnvironments,
  SOURCE_ENV,
  TARGET_ENV,
  DEFAULT_SOURCE_AUTH,
  DEFAULT_HOSTED_TARGET_AUTH,
  DATABASE_AUTH_OVERRIDES,
  DATABASE_NAMES,
  LOCAL_DATABASE_TARGETS
}
