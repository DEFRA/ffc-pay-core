module.exports = {
  EXCLUDE_ETL_TABLES: true,
  ETL_DATABASES: ['ffc-doc-statement-data-test', 'ffc-doc-statement-data-dev'],
  ETL_TABLE_PREFIX: 'etl',
  PROTECTED_TABLES: ['databasechangelog', 'databasechangeloglock']
}
