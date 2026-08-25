const SERVICE_NAME = 'ffc-pay-event-hub'
const HOSTED_DATABASE = `${SERVICE_NAME}-prd`
const LOCAL_TABLE_PREFIX = 'eventHub_'

const QUEUE_TABLE = {
  name: 'manualVerificationQueue_event_hub',
  primaryKey: ['frn', 'agreementNumber', 'schemeId'],
  keyColumns: {
    frn: 'bigint NOT NULL',
    agreementNumber: 'character varying(50) NOT NULL',
    schemeId: 'integer NOT NULL'
  },
  flagColumns: [
    'foundInWarnings',
    'foundInPayments',
    'foundInHolds',
    'foundInPaymentBatchEvents',
    'foundInPaymentFrnEvents'
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

  TABLES: [
    {
      name: 'warnings',
      localName: `${LOCAL_TABLE_PREFIX}warnings`,
      flagColumn: 'foundInWarnings',
      jsonColumn: 'data',
      matchFields: { agreementNumber: 'agreementNumber', frn: 'frn', schemeId: 'schemeId' }
    },
    {
      name: 'payments',
      localName: `${LOCAL_TABLE_PREFIX}payments`,
      flagColumn: 'foundInPayments',
      jsonColumn: 'data',
      matchFields: { agreementNumber: 'agreementNumber', frn: 'frn', schemeId: 'schemeId' }
    },
    {
      name: 'holds',
      localName: `${LOCAL_TABLE_PREFIX}holds`,
      flagColumn: 'foundInHolds',
      jsonColumn: 'data',
      matchFields: { frn: 'frn', schemeId: 'schemeId' }
    },
    {
      name: 'payment_batch_events',
      localName: `${LOCAL_TABLE_PREFIX}payment_batch_events`,
      flagColumn: 'foundInPaymentBatchEvents',
      matchType: 'direct-columns',
      matchFields: { agreementNumber: 'agreementNumber', frn: 'frn', schemeId: 'schemeId' }
    },
    {
      name: 'payment_frn_events',
      localName: `${LOCAL_TABLE_PREFIX}payment_frn_events`,
      flagColumn: 'foundInPaymentFrnEvents',
      matchType: 'direct-columns',
      matchFields: { agreementNumber: 'agreementNumber', frn: 'frn', schemeId: 'schemeId' }
    }
  ]
}
