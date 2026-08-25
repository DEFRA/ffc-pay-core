# ffc-pay-data-recovery

A small local toolkit that helps developers and testers safely pull payment-request data from the **hosted read-only recovery database** into a **local PostgreSQL database** so it can be inspected, verified, and packaged into dumps for further investigation.

> **What problem does this solve?**  
> In the event that data is removed from a table or tables. The recovery database holds the historical truth, but it is read-only and shared. This tool copies only the payment request IDs you care about onto your own machine, where you can query freely and generate staging dumps without affecting anyone else.

---

## What the tool does

The recovery workflow is made up of five small steps:

1. **Prepare a CSV** of payment request IDs you want to investigate.
2. **Create a local recovery database** from scratch (Docker PostgreSQL).
3. **Flag** which IDs exist in the hosted recovery tables.
4. **Pull** the matching rows into your local database.
5. **Create a staging dump** that can be restored elsewhere for analysis.

Steps 2 and 3 are now orchestrated: the flag script will start the local database automatically if it is not already running. If you prefer, you can still run each step manually.

The local database is entirely separate from the hosted environment, so you cannot accidentally change production or recovery data.

---

## Prerequisites

- **Docker** (or Docker Desktop) — to run the local PostgreSQL container.
- **Node.js** — to run the helper scripts.
- Access details for the **hosted recovery database** (host, database name, username, password). Ask a team member if you do not have them.

---

## Quick start

Open a terminal in this folder:

```bash
cd resources/testing/documents/data-recovery
```

Install the dependencies:

```bash
npm install
```

Create a file named `app/pr-id.csv` containing the payment request IDs you want to recover. Use the example file as a template:

```bash
cp pr-id.example.csv app/pr-id.csv
```

Then edit `app/pr-id.csv` and replace the example IDs with the real IDs. Any format with numbers in it works (one per line is easiest).

---

## Simple orchestrated run

Once `app/pr-id.csv` and `.env` are in place, the whole process is just three commands:

```bash
npm run recovery:flag
npm run recovery:pull
npm run recovery:create-staging-dump
```

The `recovery:flag` script will:

- start the local PostgreSQL container if it is not running;
- create the local database and apply the schema files;
- import the payment request IDs from `app/pr-id.csv`;
- compare the IDs against the hosted recovery tables;
- store the results in the local `manualVerificationQueue` table.

The `recovery:pull` script copies the matched rows into your local database. The optional `recovery:create-staging-dump` step produces dump files in `dumps/`.

If you want to inspect or rerun individual steps, see the sections below.

---

## Configuration

All settings are provided through environment variables. The easiest way is to create a `.env` file in this folder:

```bash
# Hosted recovery database (read-only)
RECOVERY_DB_HOST=your-recovery-host.postgres.database.azure.com
RECOVERY_DB_NAME=ffc_pay_recovery
RECOVERY_DB_USER=your-readonly-user
RECOVERY_DB_PASSWORD=your-readonly-password
RECOVERY_DB_PORT=5432
RECOVERY_DB_SSL=true
RECOVERY_DB_SSL_MODE=require

# Local database (started automatically by Docker)
LOCAL_DB_HOST=localhost
LOCAL_DB_NAME=ffc_pay_local_recovery
LOCAL_DB_USER=postgres
LOCAL_DB_PASSWORD=ppp

# Target destination for recovered data (optional, defaults to local/public)
RECOVERY_TARGET_MODE=local        # 'local' or 'hosted'
RECOVERY_TARGET_SCHEMA=public     # schema to write recovered data into
RECOVERY_TARGET_DATABASE=         # hosted database name when RECOVERY_TARGET_MODE=hosted
LOCAL_DB_PORT=5467
```

> **Security note:** never commit `.env` or `app/pr-id.csv`. They are already ignored by `.gitignore`.

---

## Typical workflow

Run the steps below in order. Each step prints progress to the terminal.

### 1. Test the hosted recovery connection

```bash
npm run recovery:test-connection
```

You should see a list of public tables from the recovery database. If this fails, check your `.env` values and network access.

### 2. Create the local recovery database (individual step)

You normally do not need to run this on its own because `npm run recovery:flag` will do it automatically. Use this step if you want to set up the local database manually before flagging.

```bash
npm run recovery:create-local-db
```

This command:

- starts a PostgreSQL container on port `5467` using `docker-compose.yaml`;
- creates the local database `ffc_pay_local_recovery`;
- applies the schema files in `app/schemas/`;
- imports the payment request IDs from `app/pr-id.csv`.

> If you already have the container running, the script reuses it.

### 3. Flag which IDs exist in the hosted tables

```bash
npm run recovery:flag
```

This compares your CSV against the hosted `invoiceLines`, `completedPaymentRequests`, and `schedule` tables. It stores the results in a local `manualVerificationQueue` table and prints a summary.

> If the local database is not running, this script starts it automatically by calling `create-local-db.js` first.

### 4. Pull the matched rows into your local database

```bash
npm run recovery:pull
```

This copies the rows that were flagged in step 3 from the hosted database into your local database. It also pulls dependent rows for `completedInvoiceLines` and `outbox` automatically.

If you only want to pull one table, you can run:

```bash
node app/tools/pull/pull-pay-processing-data.js --table invoiceLines
```

Allowed tables: `invoiceLines`, `completedPaymentRequests`, `schedule`.

To see what would be copied without actually copying, add `--dry-run`:

```bash
node app/tools/pull/pull-pay-processing-data.js --dry-run
```

### 5. (Optional) Pull dependent tables separately

If you already have `completedPaymentRequests` locally but later need to add `completedInvoiceLines` and `outbox`, run:

```bash
npm run recovery:pull-dependent
```

### 6. Create a staging dump

```bash
npm run recovery:create-staging-dump
```

This creates two files in the `dumps/` folder:

- `recovery-staging-<timestamp>.dump` — a compressed PostgreSQL custom-format dump that can be restored with `pg_restore`.
- `recovery-delta-<timestamp>.sql` — plain `INSERT` statements for the same data.

These files are ignored by Git because they can be very large and we do not want this data to be publicy viewable.

---

## Connecting to the local database

You can connect with any PostgreSQL client using these defaults:

| Setting   | Value                    |
|-----------|--------------------------|
| Host      | `localhost`              |
| Port      | `5467`                   |
| Database  | `ffc_pay_local_recovery` |
| User      | `postgres`               |
| Password  | `ppp`                    |

Command-line example:

```bash
PGPASSWORD=ppp psql -h localhost -p 5467 -U postgres -d ffc_pay_local_recovery
```

---

## Stopping and cleaning up

To stop the local PostgreSQL container:

```bash
docker compose -f docker-compose.yaml down
```

To remove the container **and** its data volume:

```bash
docker compose -f docker-compose.yaml down -v
```

> **Warning:** the `-v` flag deletes the local database permanently. You can recreate it by running `npm run recovery:create-local-db`, or simply run `npm run recovery:flag` and the database will be created automatically.

---

## File structure

```text
resources/testing/documents/data-recovery/
├── README.md                              # this file
├── docker-compose.yaml                    # local PostgreSQL container
├── package.json                           # Node scripts and dependencies
├── pr-id.example.csv                      # example CSV of payment request IDs
├── app/
│   ├── create-local-db.js                 # sets up the local database
│   ├── database/
│   │   ├── local-db-connection.js         # connects to the local Docker DB
│   │   └── recovery-db-connection.js      # connects to the hosted recovery DB
│   ├── services/                          # shared pull/batch/schema helpers
│   │   ├── batch-service.js               # PostgreSQL parameter-limit batching
│   │   ├── pull-service.js                # fetch/insert/filter operations
│   │   └── schema-service.js              # schema introspection and local table creation
│   ├── tools/                             # orchestrators and utility scripts
│   │   ├── create-staging-dump.sh         # creates dump files from local DB
│   │   ├── flag-all-services.js           # orchestrates flagging across services
│   │   ├── pull-all-services.js           # orchestrates pulling across services
│   │   └── test-recovery-connection.js    # tests hosted recovery DB connectivity
│   ├── tools/flag/                        # per-service flag scripts
│   │   ├── flag-pay-processing-matches.js
│   │   ├── flag-pay-injection-matches.js
│   │   ├── flag-pay-request-editor-matches.js
│   │   ├── flag-pay-submission-matches.js
│   │   ├── flag-pay-tracking-matches.js
│   │   └── flag-event-hub-matches.js
│   ├── tools/pull/                        # per-service pull scripts
│   │   ├── pull-pay-processing-data.js
│   │   ├── pull-pay-processing-dependent-data.js
│   │   ├── pull-pay-injection-data.js
│   │   ├── pull-pay-request-editor-data.js
│   │   ├── pull-pay-submission-data.js
│   │   ├── pull-pay-tracking-data.js
│   │   └── pull-event-hub-data.js
│   ├── config/                            # per-service source/destination config
│   │   ├── event-hub.js
│   │   ├── pay-processing.js
│   │   ├── pay-injection.js
│   │   ├── pay-request-editor.js
│   │   ├── pay-submission.js
│   │   ├── pay-tracking.js
│   │   └── services.js
│   └── util/
│       └── parse-csv-ids.js               # reads payment request IDs from CSV
```

---

## Quick verification summary

To get the queue flags and local recovered row counts without running the full flag or pull workflows, use the summary script:

```bash
npm run recovery:summary
```

This prints:

- Local queue totals and per-table `foundIn*` flags (counts of payment request IDs).
- Local recovered row counts for each service table that has been pulled.

To restrict the report to one service:

```bash
npm run recovery:summary:service ffc-pay-submission
```

The script is read-only against the local recovery database and safe to run at any time.

## Future: writing back to a hosted recovery area

Today the toolkit writes all recovered data to the **local** Docker database. The code is structured so that the destination can later be switched to a **hosted recovery area** without overwriting existing data.

Proposed approach:

1. **Target mode toggle** — set `RECOVERY_TARGET_MODE=hosted` to write to the hosted recovery database instead of the local one. The default remains `local`.
2. **Dedicated staging schema** — recovered data should land in a separate schema, e.g. `recovery_staging`, rather than `public` where the real source data lives. Configure the schema with `RECOVERY_TARGET_SCHEMA=recovery_staging`.
3. **Non-destructive writes** — the tooling creates tables in the configured target schema only. It never drops, truncates, or writes to `public` or any other existing schema.
4. **Validation workflow** — data can be staged in `recovery_staging`, verified, and only copied/promoted to `public` (or consumed by downstream processes) after human or automated approval.

A small abstraction is provided in [`app/config/target-database.js`](app/config/target-database.js). Individual tools can adopt it when the hosted write-back workflow is implemented.

## Current work in progress (as of 2026-08-21)

We are extending the recovery utility from a single pay-processing service to multiple services. Event-hub support was added and a shared-service refactor (`app/services/batch-service.js`, `app/services/pull-service.js`, `app/services/schema-service.js`) was completed. The code is on branch `recovery/delinked-transformer-legacy`.

### Known outstanding bug: `flag-all` / `pull-pay-processing-data` appears to freeze

**Symptom:** Running `npm run recovery:flag-all` starts the pay-processing pull, reports a large number of flagged IDs (e.g. `invoiceLines: 410794 payment request IDs flagged in queue`), and then appears to hang.

**What has already been fixed:**

1. **Parameter-limit assertion bug in `app/services/batch-service.js`** — `runBatched` was asserting the total item count against `maxParams` before splitting into batches. It now only checks per-batch limits.
2. **Invalid `WHERE` tuple SQL in `app/services/pull-service.js`** — `filterExistingKeys` was using the same comma-separated list for `SELECT` and `WHERE (...)`; the `WHERE` list now uses bare column expressions without `AS` aliases.
3. **Column-object bug in `app/services/schema-service.js`** — `ensureLocalTable` returned introspection objects for `hostedColumns`; it now returns plain column-name strings so they interpolate correctly into SQL.
4. **Missing dependent-table bug in `app/tools/pull/pull-pay-processing-data.js`** — `copyDependentTables` now calls `ensureLocalTable` for `completedInvoiceLines` and `outbox` before trying to filter parent IDs against them.
5. **Progress logging added** — `filterExistingKeys` now emits `checking <table>: <done>/<total>` progress when given an `onProgress` callback.

### Still to verify on Monday

- [ ] Run a small limited pull end-to-end:
  ```bash
  cd resources/testing/documents/data-recovery
  node app/tools/pull/pull-pay-processing-data.js --limit 50
  ```
  This should complete quickly and prove the dependent-table fix.
- [ ] If the limited run works, restart the full run:
  ```bash
  npm run recovery:flag-all
  ```
  It is expected to take a long time with 410k+ IDs because each ID batch requires a round-trip to Azure. Do not assume it is frozen unless there is no progress output for several minutes.
- [ ] If it really is frozen, i'll try replacing the ID-list existence check with a single temp staging table so filtering and fetching become set-based SQL operations instead of thousands of parameterised `IN` queries.
- [ ] Check whether `--force` re-fetches behave correctly when tables already have data.
- [ ] Validate event-hub flag/pull still works after the shared-service refactor:
  ```bash
  node app/tools/flag/flag-event-hub-matches.js
  node app/tools/pull/pull-event-hub-data.js --limit 50
  ```

### Quick diagnostic commands

Check whether the local database is running:

```bash
docker compose -f resources/testing/documents/data-recovery/docker-compose.yaml ps
```

Watch live logs from a long-running script:

```bash
cd resources/testing/documents/data-recovery
node app/tools/pull/pull-pay-processing-data.js --limit 1000 2>&1 | tee logs/pull-$(date +%Y%m%d-%H%M%S).log
```

Connect to the local database and inspect counts:

```bash
PGPASSWORD=ppp psql -h localhost -p 5467 -U postgres -d ffc_pay_local_recovery
```

Useful query:

```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE "foundInInvoiceLines") AS invoice_lines,
  COUNT(*) FILTER (WHERE "foundInCompletedPaymentRequests") AS completed_pr,
  COUNT(*) FILTER (WHERE "foundInPaymentRequests") AS pr,
  COUNT(*) FILTER (WHERE "foundInSchedule") AS schedule
FROM public."manualVerificationQueue";
```

---

## Troubleshooting

### `Missing recovery database environment variables`

You have not set the `RECOVERY_DB_*` environment variables. Create a `.env` file (bashrc) or export them in your terminal before running the scripts.

### Docker container does not start

- Make sure Docker is running.
- Check that port `5467` is not already in use: `lsof -i :5467` or `netstat -an | grep 5467`.
- If a previous container exists with a different name, remove it: `docker compose -f docker-compose.yaml down`.

### `paymentRequestIds` table is empty

- Check that `app/pr-id.csv` exists and contains numeric IDs.
- The parser extracts any numbers it finds, so comments without numbers are fine.

### `No payment request IDs flagged`

The IDs in your CSV may not exist in the hosted recovery tables. Double-check the IDs and the `RECOVERY_DB_NAME` setting.

### Staging dump files are huge

That is expected for large recovery sets. The `dumps/` and `logs/` folders are ignored by Git so they will not be committed.

---

## Important rules

- **Never commit `app/pr-id.csv`, `.env`, or anything in `dumps/` or `logs/`.** They are already ignored.
- **The hosted recovery connection is read-only.** These scripts do not write to it, but still keep credentials secure.
- **The local database is yours.** You can experiment, delete it, and recreate it at any time.
