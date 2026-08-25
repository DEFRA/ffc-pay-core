const SERVICE_NAME = 'ffc-pay-request-editor'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'requestEditor_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_request_editor',
  primaryKey: ['frn', 'agreementNumber', 'schemeId'],
  keyColumns: {
    frn: 'bigint NOT NULL',
    agreementNumber: 'character varying(50) NOT NULL',
    schemeId: 'integer NOT NULL'
  },
  flagColumns: [
    'foundInPaymentRequests',
    'foundInDebtData',
    'foundInQualityChecks',
    'foundInManualLedgerPaymentRequest',
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
      name: 'debtData',
      localName: `${LOCAL_TABLE_PREFIX}debtData`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInDebtData'
    },
    {
      name: 'qualityChecks',
      localName: `${LOCAL_TABLE_PREFIX}qualityChecks`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInQualityChecks'
    },
    {
      name: 'manualLedgerPaymentRequest',
      localName: `${LOCAL_TABLE_PREFIX}manualLedgerPaymentRequest`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInManualLedgerPaymentRequest'
    },
    {
      name: 'invoiceLines',
      localName: `${LOCAL_TABLE_PREFIX}invoiceLines`,
      foreignKey: 'paymentRequestId',
      flagColumn: 'foundInInvoiceLines'
    }
  ]
}
