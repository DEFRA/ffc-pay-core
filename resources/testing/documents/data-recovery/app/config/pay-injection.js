const SERVICE_NAME = 'ffc-pay-injection'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'injection_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_injection',
  primaryKey: ['frn', 'agreementNumber', 'schemeId'],
  keyColumns: {
    frn: 'bigint NOT NULL',
    agreementNumber: 'character varying(50) NOT NULL',
    schemeId: 'integer NOT NULL'
  },
  flagColumns: [
    'foundInInvoiceNumbers'
  ]
}

module.exports = {
  SERVICE_NAME,
  HOSTED_DATABASE,
  LOCAL_QUEUE_TABLE: QUEUE_TABLE.name,
  QUEUE_TABLE,
  LOCAL_TABLE_PREFIX,

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
    name: 'invoiceNumbers',
    localName: `${LOCAL_TABLE_PREFIX}invoiceNumbers`,
    flagColumn: 'foundInInvoiceNumbers',
    primaryKey: 'invoiceId',
    matchColumns: ['agreementNumber', 'frn', 'schemeId']
  }
}
