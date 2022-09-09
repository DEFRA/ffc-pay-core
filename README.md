# FFC Pay Core
Local development support for orchestrating all FFC payment and statement microservices.

## Prerequisites

Ensure you have satisfied the prerequisites of all individual repositories.

## Repositories
### Payments
#### Processing
- [ffc-pay-batch-validator](https://github.com/defra/ffc-pay-batch-validator)
- [ffc-pay-batch-processor](https://github.com/defra/ffc-pay-batch-processor)
- [ffc-pay-enrichment](https://github.com/defra/ffc-pay-enrichment)
- [ffc-pay-processing](https://github.com/defra/ffc-pay-processing)
- [ffc-pay-submission](https://github.com/defra/ffc-pay-submission)
- [ffc-pay-responses](https://github.com/defra/ffc-pay-responses)
- [ffc-pay-request-editor](https://github.com/defra/ffc-pay-request-editor)
- [ffc-pay-web](https://github.com/defra/ffc-pay-web)
- [ffc-pay-file-sender](https://github.com/defra/ffc-pay-file-sender)
- [ffc-pay-file-consumer](https://github.com/defra/ffc-pay-file-consumer)

#### Monitoring
- [ffc-pay-event](https://github.com/defra/ffc-pay-event)
- [ffc-pay-event-projection](https://github.com/defra/ffc-pay-event-projection)
- [ffc-pay-alerts](https://github.com/defra/ffc-pay-alerts)
- [ffc-pay-mi-reporting](https://github.com/defra/ffc-pay-mi-reporting)

### Statements
- [ffc-pay-statement-data](https://github.com/defra/ffc-pay-statement-data)
- [ffc-pay-statement-constructor](https://github.com/defra/ffc-pay-statement-constructor)
- [ffc-pay-statement-generator](https://github.com/defra/ffc-pay-statement-generator)
- [ffc-pay-statement-publisher](https://github.com/defra/ffc-pay-statement-publisher)

## Sequence

```mermaid
flowchart LR
ffc-pay-batch-validator(Azure Function - ffc-pay-batch-validator)
ffc-pay-batch-processor(Kubernetes - ffc-pay-batch-processor)
ffc-pay-enrichment(Kubernetes - ffc-pay-enrichment)
ffc-pay-processing(Kubernetes - ffc-pay-processing)
ffc-pay-submission(Kubernetes - ffc-pay-submission)
ffc-pay-responses(Kubernetes - ffc-pay-responses)
ffc-pay-request-editor(Kubernetes - ffc-pay-request-editor)
ffc-pay-web(Kubernetes - ffc-pay-web)
ffc-pay-file-sender(Azure Function - ffc-pay-file-sender)
ffc-pay-file-consumer(Azure Function - ffc-pay-file-consumer)

ffc-pay-event(Azure Function - ffc-pay-event)
ffc-pay-event-projection(Azure Function - ffc-pay-event-projection)
ffc-pay-alerts(Azure Function - ffc-pay-alerts)
ffc-pay-mi-reporting(Azure Function - ffc-pay-mi-reporting)

ffc-pay-statement-data(Kubernetes - ffc-pay-statement-data)
ffc-pay-statement-constructor(Kubernetes - ffc-pay-statement-constructor)
ffc-pay-statement-generator(Kubernetes - ffc-pay-statement-generator)
ffc-pay-statement-publisher(Kubernetes - ffc-pay-statement-publisher)

storageBatch[Azure Blob Storage - Batch]
storageDAX[Azure Blob Storage - DAX]
storageTable[Azure Table Storage - Event Projection]
storageProjection[Azure Blob Storage - Event Projection]
storageReport[Azure Blob Storage - Reports]
storageStatements[Azure Blob Storage - Statements]

topicRequest[Azure Service Bus Topic - ffc-pay-request]
topicResponse[Azure Service Bus Topic - ffc-pay-request-response]
topicProcessing[Azure Service Bus Topic - ffc-pay-processing]
topicSubmit[Azure Service Bus Topic - ffc-pay-submit]
topicFileSend[Azure Service Bus Topic - ffc-pay-file-send]
topicFileConsume[Azure Service Bus Topic - ffc-pay-file-consume]
topicReturn[Azure Service Bus Topic - ffc-pay-return]
topicAck[Azure Service Bus Topic - ffc-pay-acknowledgement]
topicDebt[Azure Service Bus Topic - ffc-pay-debt-data]
topicDebtResponse[Azure Service Bus Topic - ffc-pay-debt-data-response]
topicLedger[Azure Service Bus Topic - ffc-pay-manual-ledger-check]
topicLedgerResponse[Azure Service Bus Topic - ffc-pay-manual-ledger-response]
topicEvent[Azure Service Bus Topic - ffc-pay-event]
topicEventProjection[Azure Service Bus Topic - ffc-pay-event-projection]
topicAlerts[Azure Service Bus Topic - ffc-pay-alerts]
topicStatementData[Azure Service Bus Topic - ffc-pay-statement-data]
topicStatements[Azure Service Bus Topic - ffc-pay-statements]
topicStatementPublish[Azure Service Bus Topic - ffc-pay-statement-publish]

subgraph Payments
storageBatch ==> ffc-pay-batch-validator
storageBatch ==> ffc-pay-batch-processor
ffc-pay-batch-processor ==> topicRequest
topicRequest ==> ffc-pay-enrichment
ffc-pay-enrichment ==> topicResponse
ffc-pay-enrichment ==> topicProcessing
topicProcessing ==> ffc-pay-processing
ffc-pay-processing ==> topicSubmit
topicSubmit ==> ffc-pay-submission
ffc-pay-submission ==> storageDAX
ffc-pay-submission ==> topicFileSend
topicFileSend ==> ffc-pay-file-sender
storageDAX ==> ffc-pay-file-sender

topicFileConsume ==> ffc-pay-file-consumer
ffc-pay-file-consumer ==> storageDAX
storageDAX ==> ffc-pay-responses
ffc-pay-responses ==> topicAck
ffc-pay-responses ==> topicReturn
topicAck ==> ffc-pay-processing
topicReturn ==> ffc-pay-processing

ffc-pay-processing ==> topicDebt
ffc-pay-processing ==> topicLedger
topicDebt ==> ffc-pay-request-editor
topicLedger ==> ffc-pay-request-editor
ffc-pay-request-editor ==> topicDebtResponse
ffc-pay-request-editor ==> topicLedgerResponse
topicDebtResponse ==> ffc-pay-processing
topicLedgerResponse ==> ffc-pay-processing

ffc-pay-web --> ffc-pay-processing
ffc-pay-web --> storageReport
ffc-pay-web --> storageProjection

end
subgraph Monitoring

ffc-pay-batch-processor --> topicEvent
ffc-pay-enrichment --> topicEvent
ffc-pay-processing --> topicEvent
ffc-pay-submission --> topicEvent
ffc-pay-responses --> topicEvent
ffc-pay-request-editor --> topicEvent
topicEvent --> ffc-pay-event
ffc-pay-event --> topicAlerts
ffc-pay-event --> topicEventProjection
ffc-pay-event --> storageTable
topicAlerts --> ffc-pay-alerts
topicEventProjection --> ffc-pay-event-projection
storageTable --> ffc-pay-event-projection
ffc-pay-event-projection --> storageProjection

storageTable --> ffc-pay-mi-reporting
ffc-pay-mi-reporting --> storageReports

end
subgraph Statements

ffc-pay-statement-data ==> topicStatementData
topicStatementData ==> ffc-pay-statement-constructor
topicProcessing ==> ffc-pay-statement-constructor
topicSubmit ==> ffc-pay-statement-constructor
topicReturn ==> ffc-pay-statement-constructor
ffc-pay-statement-constructor ==> topicStatements
topicStatements ==> ffc-pay-statement-generator
ffc-pay-statement-generator ==> topicStatementPublish
ffc-pay-statement-generator ==> storageStatements
topicStatementPublish ==> ffc-pay-statement-publisher
storageStatements ==> ffc-pay-statement-publisher

end

```

