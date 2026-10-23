const SERVICE_NAME = 'ffc-pay-processing'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'processing_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_processing',
  primaryKey: ['paymentRequestId'],
  keyColumns: {
    paymentRequestId: 'integer NOT NULL'
  },
  flagColumns: [
    'foundInInvoiceLines',
    'foundInCompletedPaymentRequests',
    'foundInPaymentRequests',
    'foundInSchedule',
    'foundInCompletedInvoiceLines',
    'foundInOutbox'
  ]
}

module.exports = {
  SERVICE_NAME,
  HOSTED_DATABASE,
  LOCAL_TABLE_PREFIX,
  LOCAL_QUEUE_TABLE: QUEUE_TABLE.name,
  QUEUE_TABLE,
  BATCH_SIZE: 5000,
  CSV_FILE: 'pr-id.csv',

  TABLES: [
    {
      name: 'invoiceLines',
      localName: `${LOCAL_TABLE_PREFIX}invoiceLines`,
      flagColumn: 'foundInInvoiceLines',
      primaryKey: 'invoiceLineId'
    },
    {
      name: 'completedPaymentRequests',
      localName: `${LOCAL_TABLE_PREFIX}completedPaymentRequests`,
      flagColumn: 'foundInCompletedPaymentRequests',
      primaryKey: 'completedPaymentRequestId'
    },
    {
      name: 'paymentRequests',
      localName: `${LOCAL_TABLE_PREFIX}paymentRequests`,
      flagColumn: 'foundInPaymentRequests',
      primaryKey: 'paymentRequestId'
    },
    {
      name: 'schedule',
      localName: `${LOCAL_TABLE_PREFIX}schedule`,
      flagColumn: 'foundInSchedule',
      primaryKey: 'scheduleId'
    }
  ],

  DEPENDENT_TABLES: [
    {
      name: 'completedInvoiceLines',
      localName: `${LOCAL_TABLE_PREFIX}completedInvoiceLines`,
      foreignKey: 'completedPaymentRequestId',
      flagColumn: 'foundInCompletedInvoiceLines'
    },
    {
      name: 'outbox',
      localName: `${LOCAL_TABLE_PREFIX}outbox`,
      foreignKey: 'completedPaymentRequestId',
      flagColumn: 'foundInOutbox'
    }
  ]
}
