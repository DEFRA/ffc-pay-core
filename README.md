# FFC Pay Core
Local development support for orchestrating all FFC payment microservices with Docker Compose.

## Prerequisites

Ensure you have satisfied the prerequisites of all individual repositories.

## Payment microservices
### Payment batch processor

Validate and process payment batch files from Siti Agri.

- https://github.com/DEFRA/ffc-pay-batch-processor

### Payment enrichment

Validation and mapping of payment requests.

- https://github.com/DEFRA/ffc-pay-enrichment

### Payment processing

Processing of payment requests including post payment adjustment and ledger splitting.

- https://github.com/DEFRA/ffc-pay-processing

### Payment submission

Publish payment requests to Dynamics 365.

- https://github.com/DEFRA/ffc-pay-submission

### Payment responses

Process payment responses from Dynamics 365.

- https://github.com/DEFRA/ffc-pay-responses

### Payment management

Internal user admin web application to manage payment holds and processing.

- https://github.com/DEFRA/ffc-pay-web

### Payment Request Editor

Edit payment requests.

- https://github.com/DEFRA/ffc-pay-request-editor
