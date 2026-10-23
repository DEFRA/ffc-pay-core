module.exports = {
  EXCLUDE_ETL_TABLES: true,
  ETL_DATABASES: [
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
    'ffc-pay-tracking'
  ],
  ETL_TABLE_PREFIX: 'etl',
  PROTECTED_TABLES: ['databasechangelog', 'databasechangeloglock'],
  READER_ONLY_EXCLUDED_TABLES: ['schemes', 'contacts']
}
