const SERVICE_NAME = 'ffc-pay-submission'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'submission_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_submission',
  primaryKey: ['frn', 'agreementNumber', 'schemeId'],
  keyColumns: {
    frn: 'bigint NOT NULL',
    agreementNumber: 'character varying(50) NOT NULL',
    schemeId: 'integer NOT NULL'
  },
  flagColumns: [
    'foundInPaymentRequests',
    'foundInQueues',
    'foundInInvoiceLines'
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
    name: 'paymentRequests',
    localName: `${LOCAL_TABLE_PREFIX}paymentRequests`,
    flagColumn: 'foundInPaymentRequests',
    primaryKey: 'paymentRequestId',
    matchColumns: ['agreementNumber', 'frn', 'schemeId']
  },

  DEPENDENT_TABLES: [
    {
      name: 'queue',
      localName: `${LOCAL_TABLE_PREFIX}queue`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInQueues'
    },
    {
      name: 'invoiceLines',
      localName: `${LOCAL_TABLE_PREFIX}invoiceLines`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInInvoiceLines'
    }
  ]
}
