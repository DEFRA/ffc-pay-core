# Statement service testing

These steps detail how the Future Farming Statement Service

## Setup for local development
1. Guarantee clean environment with [`./scripts/stop -v`](../../../stop)
2. Start all payment and statement services with [`./scripts/start -s`](../../../start).  Alternatively can be started individually with:
   1. Start all payment services with [`./scripts/start`](../../../start)
   2. Start all statement services [`./scripts/start -S`](../../../start)

## Process payments (non-Vet Visit schemes)
1. Open appropriate scheme folder
2. Review prepared scenarios
3. Open desired scenario folder
4. Upload payment batch file to blob storage - `batch/inbound`
5. Should see output appear in - `dax/outbound` 
   1. `dax/archive` if in environment with [`ffc-pay-file-sender-function`](https://github.com/DEFRA/ffc-pay-file-sender) running
6. Upload return file to blob storage - `dax/inbound`

## Process payments (Vet Visits)
1. Open Vet Visits folder
2. Review prepared scenarios
3. Open desired scenario folder
4. Send message to `ffc-pay-request-<environment>` Service Bus topic
5. Should see output appear in - `dax/outbound`
   1. `dax/archive` if in environment with [`ffc-pay-file-sender-function`](https://github.com/DEFRA/ffc-pay-file-sender) running
6. Upload return file to blob storage - `dax/inbound`

Through doing this for each desired scenario, the statement service will receive all the data it needs from payment service.

You can view this data in the [`ffc-pay-statement-constructor`](https://github.com/DEFRA/ffc-pay-statement-constructor) database.

> Note: Due to the asynchronous nature of messaging these data items can arrive in `ffc-pay-constructor` in any order.

## Upload Data Warehouse data
1. Open DWH folder
2. Open [`calculations.sql`](DWH/calculations.sql) file
3. Amend requirement email address in organisation table.  Must be an account setup in [Notify team](https://www.notifications.service.gov.uk/services/822632b6-1b07-44ef-9fe0-24dc9bb99272/users) to not cause publishing failure in [`ffc-pay-statement-publisher](https://github.com/DEFRA/ffc-pay-statement-publisher).
4. Run script against [`ffc-pay-statement-data`](https://github.com/DEFRA/ffc-pay-statement-data) database.

#### Local development
In Kubernetes environments, [`ffc-pay-statement-data`](https://github.com/DEFRA/ffc-pay-statement-data) runs as a Kubernetes `CronJob` so will periodically publish new datasets for [`ffc-pay-statement-constructor`](https://github.com/DEFRA/ffc-pay-statement-constructor) to consume.

However, locally when the container is started it will run the process once and then exit.  

To re-run the process within the re-running container to publish new datasets, run the [`execute`](https://github.com/DEFRA/ffc-pay-statement-data/blob/main/scripts/execute) script within that repository.

## Outcomes
The [`ffc-pay-statement-constructor`](https://github.com/DEFRA/ffc-pay-statement-constructor) will periodically output statement generation requests if the required data from all sources has been received.

These requests are consumed by [`ffc-pay-statement-generator`](https://github.com/DEFRA/ffc-pay-statement-generator) which will publish a PDF document and send a publishing request for [`ffc-pay-statement-publisher`](https://github.com/DEFRA/ffc-pay-statement-publisher) to send via Notify.

### Rules
1. Statements should only be produced for SFI payments
2. Statements should be produced for every SFI statement and content should match the scenario.
