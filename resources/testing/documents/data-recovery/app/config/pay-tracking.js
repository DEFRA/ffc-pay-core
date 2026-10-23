const SERVICE_NAME = 'ffc-pay-tracking'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'tracking_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_tracking',
  primaryKey: ['frn', 'agreementNumber', 'schemeId'],
  keyColumns: {
    frn: 'bigint NOT NULL',
    agreementNumber: 'character varying(50) NOT NULL',
    schemeId: 'integer NOT NULL',
    sourceSystem: 'character varying(50) NOT NULL'
  },
  flagColumns: [
    'foundInReportData'
  ]
}

const SOURCE_SYSTEM_MAP = {
  1: 'SFI',
  2: 'SFIP',
  3: 'LSES',
  4: 'AHWR',
  5: 'SITI AGRI CS SYS',
  6: 'SITI AGRI SYS',
  8: 'Injection',
  9: 'Genesis',
  10: 'GLOS',
  11: 'IMPS',
  12: 'SFIA',
  13: 'DP',
  14: 'ESFIO',
  15: 'COHTR',
  16: 'COHTC',
  17: 'FPTT',
  18: 'WMP'
}

module.exports = {
  SERVICE_NAME,
  HOSTED_DATABASE,
  LOCAL_QUEUE_TABLE: QUEUE_TABLE.name,
  QUEUE_TABLE,
  LOCAL_TABLE_PREFIX,
  SOURCE_SYSTEM_MAP,

  SOURCE_TABLE: {
    connection: 'local',
    schema: 'public',
    table: 'processing_paymentRequests',
    keyColumns: {
      agreementNumber: 'agreementNumber',
      frn: 'frn',
      schemeId: 'schemeId'
    }
  },

  AGREEMENTS_TABLE: {
    connection: 'local',
    schema: 'public',
    table: 'agreements',
    keyColumns: {
      agreementNumber: 'agreementNumber',
      frn: 'frn',
      schemeId: 'schemeId'
    }
  },

  BATCH_SIZE: 5000,

  PARENT_TABLE: {
    name: 'reportData',
    localName: `${LOCAL_TABLE_PREFIX}reportData`,
    flagColumn: 'foundInReportData',
    primaryKey: 'reportDataId',
    matchColumns: ['sourceSystem', 'frn', 'agreementNumber']
  }
}
