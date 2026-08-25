module.exports = {
  services: [
    {
      name: 'ffc-pay-processing',
      flagCommand: 'node app/tools/flag/flag-pay-processing-matches.js',
      pullCommand: 'node app/tools/pull/pull-pay-processing-data.js',
      queueTable: 'manualVerificationQueue_processing',
      localPrefix: 'processing',
      pullAfterFlag: true
    },
    {
      name: 'ffc-pay-injection',
      flagCommand: 'node app/tools/flag/flag-pay-injection-matches.js',
      pullCommand: 'node app/tools/pull/pull-pay-injection-data.js',
      queueTable: 'manualVerificationQueue_injection',
      localPrefix: 'injection',
      flagPrerequisites: [
        {
          name: 'pay-processing data',
          command: 'node app/tools/pull/pull-pay-processing-data.js',
          checkTables: [
            'processing_paymentRequests'
          ]
        }
      ]
    },
    {
      name: 'ffc-pay-request-editor',
      flagCommand: 'node app/tools/flag/flag-pay-request-editor-matches.js',
      pullCommand: 'node app/tools/pull/pull-pay-request-editor-data.js',
      queueTable: 'manualVerificationQueue_request_editor',
      localPrefix: 'requestEditor',
      flagPrerequisites: [
        {
          name: 'pay-processing data',
          command: 'node app/tools/pull/pull-pay-processing-data.js',
          checkTables: [
            'processing_paymentRequests'
          ]
        }
      ]
    },
    {
      name: 'ffc-pay-submission',
      flagCommand: 'node app/tools/flag/flag-pay-submission-matches.js',
      pullCommand: 'node app/tools/pull/pull-pay-submission-data.js',
      queueTable: 'manualVerificationQueue_submission',
      localPrefix: 'submission',
      flagPrerequisites: [
        {
          name: 'pay-processing data',
          command: 'node app/tools/pull/pull-pay-processing-data.js',
          checkTables: [
            'processing_paymentRequests'
          ]
        }
      ]
    },
    {
      name: 'ffc-pay-tracking',
      flagCommand: 'node app/tools/flag/flag-pay-tracking-matches.js',
      pullCommand: 'node app/tools/pull/pull-pay-tracking-data.js',
      queueTable: 'manualVerificationQueue_tracking',
      localPrefix: 'tracking',
      flagPrerequisites: [
        {
          name: 'pay-processing data',
          command: 'node app/tools/pull/pull-pay-processing-data.js',
          checkTables: [
            'processing_paymentRequests'
          ]
        }
      ],
      note: 'Derives keys from local paymentRequests and matches against hosted reportData.'
    },
    // Event hub is intentionally last: it depends on the widest set of
    // pay-processing tables and is still being stabilised.
    {
      name: 'ffc-pay-event-hub',
      flagCommand: 'node app/tools/flag/flag-event-hub-matches.js',
      pullCommand: 'node app/tools/pull/pull-event-hub-data.js',
      queueTable: 'manualVerificationQueue_event_hub',
      localPrefix: 'eventHub',
      flagPrerequisites: [
        {
          name: 'pay-processing data',
          command: 'node app/tools/pull/pull-pay-processing-data.js',
          checkTables: [
            'processing_invoiceLines',
            'processing_completedPaymentRequests',
            'processing_paymentRequests',
            'processing_schedule',
            'processing_completedInvoiceLines',
            'processing_outbox'
          ]
        }
      ]
    }
  ]
}
