# Testing & Data Tools

This folder contains standalone helper tools used by the payments team to move, recover, transform and inspect data across environments. Each tool lives in its own directory and can be run independently.

There are **four tools** documented here:

| Tool | Purpose | Location |
|------|---------|----------|
| [Data Recovery](#data-recovery-toolkit) | Pull selected payment-request IDs from the hosted read-only recovery database into a local PostgreSQL instance. | [`data-recovery/`](data-recovery/) |
| [Source-to-Target Transformer](#source-to-target-transformer) | Copy whole service databases from one hosted environment to another (e.g. `prd → pre`, `recovery → test`). | [`delinked-data-transformer/`](delinked-data-transformer/) |
| [Test-to-Dev Pipeline](#test-to-dev-pipeline) | Generate dummy test data, transform SQL, and push it to the dev environment. | [`delinked-data-transformer/`](delinked-data-transformer/) |
| [Local Transfer Testing](#local-transfer-testing) | Test the transformer against a local PostgreSQL instance without touching hosted targets. | [`delinked-data-transformer/scripts/`](delinked-data-transformer/scripts/) |

All tools are command-line driven and use environment variables for credentials. No repo-local `.env` files are committed.

---

## Data Recovery Toolkit

[`data-recovery/`](data-recovery/) — recover specific payment requests from the hosted read-only recovery database to your own machine for safe inspection and staging dumps.

### What it does

1. Read a CSV of payment request IDs.
2. Start a local PostgreSQL container on port `5467` (if it is not already running).
3. Flag which IDs exist in the hosted recovery tables and store the results in per-service `manualVerificationQueue` tables.
4. Copy the matching rows — plus dependent rows — into your local database.
5. Create a compressed staging dump that can be restored elsewhere.

### Hidden details worth knowing

| Feature | Behaviour |
|---------|-----------|
| **Lenient CSV parsing** | Any run of digits anywhere in `app/pr-id.csv` is treated as a payment-request ID. Comments and formatting do not matter. Duplicates are removed while preserving first-occurrence order. |
| **Auto-start local DB** | `npm run recovery:flag` automatically creates/starts the Docker container and applies the base schema if the local database is not reachable. |
| **Schema introspection cache** | Local service tables are created by introspecting the hosted schema; column types, lengths and non-primary indexes are preserved. Introspection results are cached in `.schema-cache/<db>.<table>.json`. |
| **Per-service queues** | Each service has its own queue table (e.g. `manualVerificationQueue_processing`, `manualVerificationQueue_event_hub`) with `PENDING`/`VERIFIED`/`REJECTED`/`IN_PROGRESS` status tracking. pay-processing uses `paymentRequestId` as the key; other services use natural-key tuples such as `(frn, agreementNumber, schemeId)`. |
| **Re-flagging is safe** | Re-running a flag updates existing queue rows without losing a `VERIFIED` status. Tracking is the exception: its queue is truncated before re-loading. |
| **Idempotent inserts** | Pulled rows use `ON CONFLICT DO NOTHING`, so re-runs are safe. Use `--force` to re-fetch rows that already exist locally. Use `--limit N` for a small test run. |
| **Dependent tables** | pay-processing automatically pulls `completedInvoiceLines` and `outbox` after `completedPaymentRequests`. Other services pull their configured child tables. Dependent pulls are resume-aware and only fetch for parents that still need children. |
| **Event-hub JSON matching** | Event-hub pulls join against JSON columns (`data->>'fieldName'`) and create temporary tables on the hosted database to handle large tuple sets efficiently. |
| **Staging dump filtering** | The dump script currently exports payment-processing and event-hub tables only; tracking/injection/request-editor/submission tables are not included. |
| **Future write-back** | A `target-database.js` abstraction supports `RECOVERY_TARGET_MODE=hosted` and `RECOVERY_TARGET_SCHEMA`, but pulls currently always write to the local Docker database. |

### Quick start

```bash
cd resources/testing/documents/data-recovery
cp pr-id.example.csv app/pr-id.csv
# edit app/pr-id.csv with the IDs you need
npm install
npm run recovery:flag
npm run recovery:pull
npm run recovery:create-staging-dump
```

### Common commands

```bash
# Test the hosted recovery connection
npm run recovery:test-connection

# Pull only one service
node app/tools/pull/pull-pay-processing-data.js --limit 50

# Pull dependent tables later
npm run recovery:pull-dependent

# View a summary of what has been recovered
npm run recovery:summary
npm run recovery:summary:service ffc-pay-submission
```

See [`data-recovery/README.md`](data-recovery/README.md) for full configuration, per-service commands and troubleshooting.

---

## Source-to-Target Transformer

[`delinked-data-transformer/`](delinked-data-transformer/) — copy entire service databases from a supported source environment to a supported target environment.

### Supported environments

`dev`, `test`, `pre`, `prd`, `recovery`, `local`

### What it does

- Discovers source tables, primary keys and foreign-key dependencies.
- Caches that metadata on disk in `metadata/<database>-<environment>.json`; the next run reuses the cache automatically instead of re-querying the source catalog.
- Reports database size and switches to table-by-table copying for very large tables.
- Restores schema (primary keys, foreign keys, indexes, constraints, triggers) with `pg_dump --schema-only`.
- Orders tables by foreign-key dependencies so child tables are copied after parent tables.
- Copies data, validates row counts and distinct key counts.
- Re-applies managed identity grants discovered from the preserved Liquibase tables.
- Writes per-service checkpoints to `checkpoints/<service>-<source>-to-<target>.json`, so a failed run can be resumed with `--resume`.

### Hidden details worth knowing

| Feature | Behaviour |
|---------|-----------|
| **Metadata cache** | Saved under `metadata/` after the first discovery. Delete a file there to force re-discovery. |
| **Checkpoint retry** | `--resume` skips services marked `completed`. A failed service is restarted from the beginning; there is no mid-table resume. Checkpoints are not written during `--dry-run`. |
| **Large tables** | A table is treated as large when it has ≥ `LARGE_TABLE_ROW_THRESHOLD` rows (default 1,000,000) or is ≥ `LARGE_TABLE_SIZE_MB_THRESHOLD` MB (default 1,024). Large tables automatically trigger table-by-table mode. |
| **Foreign keys during copy** | In table-by-table mode, foreign-key checks are disabled for the import session only (`session_replication_role=replica`), so rows can be loaded in any order without violating constraints. |
| **Validation** | Compares source/target row counts and distinct primary-key counts. `schemes` and `contacts` are always excluded from validation. |
| **Transaction mode** | Restore runs inside a single transaction by default. Use `--no-single-transaction` to remove the wrapper (useful for very large restores, but a failure can leave partial data). |
| **ETL / Liquibase protection** | `databasechangelog*` and `etl*` tables are protected and never copied or modified. |
| **Managed identity grants** | The MID is discovered from the target `databasechangelog` owner/grantees (prefix `DEVFFCINFMID`) and re-applied after transfer. Use `--skip-grants` to disable. |

### Quick start

```bash
cd resources/testing/documents/delinked-data-transformer
npm install
```

### Examples

```bash
# Production to pre-production
DB_SOURCE_ENV=prd DB_TARGET_ENV=pre node app/index.js --scenario prd-to-pre --direct --dry-run
DB_SOURCE_ENV=prd DB_TARGET_ENV=pre node app/index.js --scenario prd-to-pre --direct

# Recovery to test
DB_SOURCE_ENV=recovery DB_TARGET_ENV=test node app/index.js --scenario prd-to-pre --direct --dry-run
DB_SOURCE_ENV=recovery DB_TARGET_ENV=test node app/index.js --scenario prd-to-pre --direct

# Test connectivity without copying
node app/index.js --scenario prd-to-pre --direct --test-connection --dry-run

# Continue past individual service failures
node app/index.js --scenario prd-to-pre --direct --continue-on-error

# Resume a previous run
node app/index.js --scenario prd-to-pre --direct --resume
```

See [`delinked-data-transformer/README.md`](delinked-data-transformer/README.md) for scenario configuration, command reference, checkpointing and operational notes.

---

## Test-to-Dev Pipeline

[`delinked-data-transformer/`](delinked-data-transformer/) — the original interactive workflow for generating dummy data and pushing it to dev.

### What it does

- Generates dummy data using faker.
- Dumps test tables.
- Transforms SQL (anonymises organisation data while keeping identifiers stable).
- Uploads the result to the dev environment.

### Hidden details worth knowing

| Feature | Behaviour |
|---------|-----------|
| **Idempotent fake data** | Faker is seeded from each row's `frn` or `sbi`, so the same source row always produces the same fake name, address and email. `sbi` and `frn` themselves are never changed. |
| **Dummy data sources** | `dummy-data-creation/create-dummy-file.js` writes batched `INSERT` files; `create-dummy-records.js` inserts directly into a local database via Sequelize. The interactive flow chooses one path. |
| **Transform in place** | `transformAll` locates `COPY` blocks for `organisations` in statement-data/statement-constructor dumps, runs them through the faker, and writes the transformed `COPY` block back to the same file. |
| **SQL processor** | Converts `COPY ... FROM stdin` blocks into batched `INSERT` statements and can strip schema DDL with `dataOnlyMode`. |
| **Safe upload** | The target dev database is backed up to `../dev-backups` before upload. Upload groups statements by table, executes in foreign-key order, and validates/truncates over-long strings or missing non-nullable values. |

### Quick start

```bash
cd resources/testing/documents/delinked-data-transformer
node app/index.js --scenario test-to-dev --dry-run
node app/index.js --scenario test-to-dev
```

Add `--dry-run` to preview what would happen before making any changes.

---

## Local Transfer Testing

[`delinked-data-transformer/scripts/`](delinked-data-transformer/scripts/) — verify transformer behaviour against a local PostgreSQL instance.

These scripts read from a configured source environment but write only to a local throwaway database. They are useful for confirming that schema restoration, data copy and managed-identity grant re-application work correctly without touching hosted targets.

### Scripts

| Script | Use when you want to... |
|--------|-------------------------|
| `transfer-single-table.js` | Copy one table from a source database to a local database. |
| `transfer-service-to-local.js` | Copy every table in a source service database to a local database. |
| `run-local-transfer-test.sh` | Orchestrate the full local test flow (setup, transfer, verification). |
| `prepare-local-test-db.js` | Add mock managed identity, Liquibase tables and test fixtures to a local database. |
| `inspect-local-db.js` | Inspect a local database's tables, keys, indexes and grants. |
| `transfer-health-check.js` | Verify a local transfer completed successfully. |

### Hidden details worth knowing

| Feature | Behaviour |
|---------|-----------|
| **Self-contained scripts** | `transfer-single-table.js` and `transfer-service-to-local.js` do not require `app/config/local.js` to be edited. They read source credentials from `RECOVERY_DB_*` / `POSTGRES_PRD_*` and target credentials from `LOCAL_POSTGRES_*`. |
| **Schema preservation** | Tables are dropped and recreated with `pg_dump --schema-only`, so primary keys, foreign keys, indexes, unique constraints and triggers survive. |
| **Sequence reset** | `transfer-service-to-local.js` resets sequences after the data copy so they match the imported data. Use `--skip-sequence-reset` to disable. |
| **Mock managed identity** | `prepare-local-test-db.js` creates a `devffcinfdmid01` role and grants it access to existing tables, mimicking the hosted environment so grant re-application can be tested. |
| **Service-to-local ordering** | Tables are copied smallest-first, then re-ordered by foreign-key dependencies so parent data is in place before child data. |
| **Continue on error** | `transfer-service-to-local.js` supports `--continue-on-error` to keep copying remaining tables if one fails. |

### Quick start

```bash
cd resources/testing/documents/delinked-data-transformer

# Start a local PostgreSQL container
docker run -d --name local-transformer-test \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -p 5438:5438 \
  postgres:16
```

### Examples

```bash
# Transfer a single table
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
DB_SOURCE_ENV=recovery \
node scripts/transfer-single-table.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission \
  --table schemes

# Transfer an entire service
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
DB_SOURCE_ENV=recovery \
node scripts/transfer-service-to-local.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission

# Use the helper shell script for a single table
export LOCAL_POSTGRES_PASSWORD=postgres
export LOCAL_POSTGRES_PORT=5438
export SERVICE_NAME=ffc-pay-submission
export TABLE_FILTER=schemes
./scripts/run-local-transfer-test.sh
```

See [`delinked-data-transformer/scripts/README.md`](delinked-data-transformer/scripts/README.md) for environment variables, verification details and preparing a local test database.

---

## Common conventions

- **Environment variables only** — no `.env` files are committed. Set variables in your shell profile or export them before running commands.
- **Azure AD for hosted environments** — `dev`, `test`, `pre` and `prd` use Azure AD tokens. You must be authenticated to Azure (for example `az login`).
- **Password auth for recovery** — the recovery database uses `RECOVERY_DB_USER` and `RECOVERY_DB_PASSWORD`.
- **Local is throwaway** — local databases are started in Docker and can be recreated at any time.
- **Dry-runs are safe** — every tool supports a `--dry-run` mode so you can preview work before copying or uploading data.
- **Protected tables** — `databasechangelog*`, `databasechangeloglock*` and `etl*` tables are protected across all tools; they are never copied, transformed, truncated or uploaded.
- **Identifiers are preserved** — tools that anonymise data (test-to-dev faker) keep business keys (`sbi`, `frn`, payment-request IDs) stable so references stay intact.

## Directory layout

```text
resources/testing/documents/
├── README.md                              # this file
├── data-recovery/                         # recovery toolkit
│   ├── README.md
│   ├── docker-compose.yaml
│   ├── package.json
│   └── app/
└── delinked-data-transformer/             # transformer & local testing
    ├── README.md
    ├── package.json
    ├── app/
    ├── scripts/
    │   └── README.md
    ├── dummy-data-creation/
    └── checkpoints/
```
