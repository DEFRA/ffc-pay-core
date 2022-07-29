# FFC Pay Core
Local development support for orchestrating all FFC payment microservices with Docker Compose.

## Prerequisites

Ensure you have satisfied the prerequisites of all individual repositories.

## Payment delivery
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

## Payment statements
### Payment Statement Data

Support Data Warehouse integration for statement data

- https://github.com/DEFRA/ffc-pay-statement-data

### Payment Statement Constructor

Build datasets for statement generation

- https://github.com/DEFRA/ffc-pay-statement-constructor

### Payment Statement Generator

Generate PDF statements

- https://github.com/DEFRA/ffc-pay-statement-generator
