# FFC Pay Core
Local development support for orchestrating all FFC payment and statement microservices.

## Prerequisites

Ensure you have satisfied the prerequisites of all individual repositories.

## Repositories
### Payments
#### Processing
- [ffc-pay-batch-verifier](https://github.com/defra/ffc-pay-batch-verifier)
- [ffc-pay-batch-processor](https://github.com/defra/ffc-pay-batch-processor)
- [ffc-pay-enrichment](https://github.com/defra/ffc-pay-enrichment)
- [ffc-pay-processing](https://github.com/defra/ffc-pay-processing)
- [ffc-pay-submission](https://github.com/defra/ffc-pay-submission)
- [ffc-pay-responses](https://github.com/defra/ffc-pay-responses)
- [ffc-pay-request-editor](https://github.com/defra/ffc-pay-request-editor)
- [ffc-pay-web](https://github.com/defra/ffc-pay-web)
- [ffc-pay-file-publisher](https://github.com/defra/ffc-pay-file-publisher)
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
- [ffc-pay-statement-receiver](https://github.com/defra/ffc-pay-statement-receiver)

## Sequence

### Payments
```mermaid
flowchart LR
ffc-pay-batch-verifier(Kubernetes - ffc-pay-batch-verifier)
ffc-pay-batch-processor(Kubernetes - ffc-pay-batch-processor)
ffc-pay-enrichment(Kubernetes - ffc-pay-enrichment)
ffc-pay-processing(Kubernetes - ffc-pay-processing)
ffc-pay-submission(Kubernetes - ffc-pay-submission)
ffc-pay-responses(Kubernetes - ffc-pay-responses)
ffc-pay-request-editor(Kubernetes - ffc-pay-request-editor)
ffc-pay-web(Kubernetes - ffc-pay-web)
ffc-pay-file-publisher(Kubernetes - ffc-pay-file-publisher)
ffc-pay-file-consumer(Azure Function - ffc-pay-file-consumer)

storageBatch[Azure Blob Storage - Batch]
storageDAX[Azure Blob Storage - DAX]

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

storageBatch ==> ffc-pay-batch-verifier
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
topicFileSend ==> ffc-pay-file-publisher
storageDAX ==> ffc-pay-file-publisher

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
```

### Monitoring
```mermaid
flowchart LR
ffc-pay-batch-processor(Kubernetes - ffc-pay-batch-processor)
ffc-pay-enrichment(Kubernetes - ffc-pay-enrichment)
ffc-pay-processing(Kubernetes - ffc-pay-processing)
ffc-pay-submission(Kubernetes - ffc-pay-submission)
ffc-pay-responses(Kubernetes - ffc-pay-responses)
ffc-pay-request-editor(Kubernetes - ffc-pay-request-editor)
ffc-pay-web(Kubernetes - ffc-pay-web)

ffc-pay-event(Azure Function - ffc-pay-event)
ffc-pay-event-projection(Azure Function - ffc-pay-event-projection)
ffc-pay-alerts(Azure Function - ffc-pay-alerts)
ffc-pay-mi-reporting(Azure Function - ffc-pay-mi-reporting)

storageTable[Azure Table Storage - Event Projection]
storageProjection[Azure Blob Storage - Event Projection]
storageReport[Azure Blob Storage - Reports]

topicEvent[Azure Service Bus Topic - ffc-pay-event]
topicEventProjection[Azure Service Bus Topic - ffc-pay-event-projection]
topicAlerts[Azure Service Bus Topic - ffc-pay-alerts]

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

ffc-pay-web --> storageReport
ffc-pay-web --> storageProjection
```

### Statements
```mermaid
flowchart LR

ffc-pay-statement-data(Kubernetes - ffc-pay-statement-data)
ffc-pay-statement-constructor(Kubernetes - ffc-pay-statement-constructor)
ffc-pay-statement-generator(Kubernetes - ffc-pay-statement-generator)
ffc-pay-statement-publisher(Kubernetes - ffc-pay-statement-publisher)
ffc-pay-statement-receiver(Kubernetes - ffc-pay-statement-receiver)

storageStatements[Azure Blob Storage - Statements]

topicProcessing[Azure Service Bus Topic - ffc-pay-processing]
topicSubmit[Azure Service Bus Topic - ffc-pay-submit]
topicReturn[Azure Service Bus Topic - ffc-pay-return]
topicStatementData[Azure Service Bus Topic - ffc-pay-statement-data]
topicStatements[Azure Service Bus Topic - ffc-pay-statements]
topicStatementPublish[Azure Service Bus Topic - ffc-pay-statement-publish]

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
storageStatements ==> ffc-pay-statement-receiver
```

## Scripts

### Clone

Clone all repositories from GitHub.  Repositories will cloned in the parent directory of this repository.

[`./clone`](clone)

### Update

Switch to `main` branch in every repository and pull latest changes with `git pull`.

[`./update`](update)

### Build

Build/rebuild Docker container for all microservices.

[`./build`](build)

### Start

Run all payment services.

[`./start`](start)

#### Optional arguments
- `-f` - include Azure Functions
- `-s` - include Statement services
- `-S` - only statement services

### Stop

Run all payment services.

[`./stop`](stop)

#### Optional arguments

Any valid `docker-compose down` argument.

### Open

Open all payment services in Visual Studio Code.

[`./open`](open)

#### Optional arguments
- `-f` - include Azure Functions
- `-s` - include Statement services
- `-S` - only statement services

### Latest versions

List latest GitHub release version for each microservice.

[`./latest-versions`](latest-versions)

### Environment versions

List current environment version for each microservice hosted in Kubernetes.

[`./environment-versions`](environment-versions)

#### Options
- `-c | --cluster` - Kubernetes cluster context name
- `-n | --namespace` - Kubernetes namespace

## Resources
### Payments

A set of test datasets and scripts to support testing of payments.

### Statements

A set of test datasets and scripts to support testing of statements.

Instructions for use can be read [here](resources/testing/statements/Instructions.md).
