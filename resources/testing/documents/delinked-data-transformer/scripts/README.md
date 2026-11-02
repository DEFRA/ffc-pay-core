# Local integration testing

> Part of the [Testing & Data Tools](../..) collection.  
> This README covers the local transfer scripts; see the [transformer README](../README.md) for the related hosted workflows.

These scripts let you test the data transformer against a local PostgreSQL instance without touching hosted environments (except for the source database, which is read from whatever source environment is configured).

The `local` environment is defined centrally in [app/constants/environment-definitions.js](../app/constants/environment-definitions.js) alongside the hosted environments, so the local transfer scripts use the same connection-resolution code path and the same env var names everywhere.

The **single-table transfer** (`scripts/transfer-single-table.js`) and the **service-to-local transfer** (`scripts/transfer-service-to-local.js`) are fully self-contained and do not require `app/config/local.js` to be modified. The **full-database transfer** (`scripts/run-local-transfer-test.sh` without `TABLE_FILTER`) still requires the local-test scenario config because it uses the main sequential runner.

## Quick start

### 1. Start a local Postgres

Using Docker:

```bash
docker run -d --name local-transformer-test \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -p 5438:5438 \
  postgres:16
```

Or use any existing local Postgres.

### 2. Run a single-table transfer test

The simplest way uses the helper shell script, which creates the local database, runs the transfer and verifies the result:

```bash
export LOCAL_POSTGRES_PASSWORD=postgres
export LOCAL_POSTGRES_PORT=5438
export SERVICE_NAME=ffc-pay-submission
export TABLE_FILTER=schemes
./scripts/run-local-transfer-test.sh
```

This will:

- Create a target database `ffc_pay_submission`.
- Set up Liquibase tables and a mock managed identity role.
- Copy `schemes` from the configured source to the local target using the same `copyTableRows` code path as the full runner.
- Drop and recreate the target table with `pg_dump --schema-only`, preserving primary keys, foreign keys, indexes, unique constraints and triggers.
- Discover the mock managed identity from the Liquibase tables and apply/re-apply its grants on the copied table.
- Print verification queries showing primary keys, foreign keys, indexes, unique constraints and MID grants.

Use `--skip-grants` to copy the table without re-applying managed identity grants.

You can also run the transfer script directly if you already have a prepared local database:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
DB_SOURCE_ENV=recovery \
node scripts/transfer-single-table.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission \
  --table schemes
```

### 3. Transfer an entire service to local (all tables)

To copy every table in a service database without touching `app/config/local.js`, use the self-contained service transfer utility:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
DB_SOURCE_ENV=recovery \
node scripts/transfer-service-to-local.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission
```

This will:

- Discover every application table in the source database (smallest first).
- Drop and recreate each table on the local target using `pg_dump --schema-only`, preserving primary keys, foreign keys, indexes, unique constraints and triggers.
- Copy data from source to target for each table.
- Discover the mock managed identity from the local Liquibase tables and re-apply its grants on all copied tables.

Use `--continue-on-error` to keep copying remaining tables if one fails, and `--skip-grants` to disable the grant step.

### 4. Run a full-database transfer test

The full-database transfer still uses `sequential-transfer-runner.js`, which currently needs the local-test scenario config to be active:

```bash
cp scripts/local-test-scenario.js app/config/local.js
export LOCAL_POSTGRES_PASSWORD=postgres
export LOCAL_POSTGRES_PORT=5438
export SERVICE_NAME=ffc-pay-submission
./scripts/run-local-transfer-test.sh
```

This runs `sequential-transfer-runner.js` in table-by-table mode.

**Note:** this will overwrite `app/config/local.js`. If you want to keep your existing `prd-to-pre` config, back it up first or use the single-table/service-to-local transfer instead.

## Environment variables

### Source (remote)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_SOURCE_ENV` | `recovery` | Source environment suffix (recovery uses password auth and the `-prd` database suffix) |
| `RECOVERY_DB_HOST` | (none) | Remote source Postgres host |
| `RECOVERY_DB_USER` / `RECOVERY_DB_ADMIN` | (none) | Remote source username |
| `RECOVERY_DB_PASSWORD` | (none) | Remote source password |
| `POSTGRES_PRD_HOST` | (none) | Fallback remote source Postgres host |
| `POSTGRES_PRD_ADMIN` | (none) | Fallback remote source username |
| `PRD_DB_PASSWORD` | (none) | Fallback remote source password |

### Target (local)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_POSTGRES_HOST` | `127.0.0.1` | Local Postgres host |
| `LOCAL_POSTGRES_ADMIN` | `postgres` | Local Postgres admin user |
| `LOCAL_POSTGRES_PASSWORD` | `postgres` | Local Postgres password |
| `LOCAL_POSTGRES_PORT` | `5438` | Local Postgres port |
| `SERVICE_NAME` | `ffc-pay-submission` | Service base name (used to build source DB name) |

### Full-runner script only

| Variable | Default | Purpose |
| --- | --- | --- |
| `TABLE_FILTER` | (empty) | Copy only this table |
| `SEED_SOURCE` | `false` | If `true`, try to seed `parent_records`/`child_records` on the source |
| `CLEANUP` | `false` | If `true`, drop the local target DB after the test |

## What is preserved and verified

During a transfer the target table is dropped and recreated using `pg_dump --schema-only` for the selected table. This means:

- Primary keys survive.
- Foreign keys survive.
- Indexes survive.
- Unique constraints survive.
- Triggers survive.
- Managed identity grants are rediscovered from the local Liquibase tables and re-applied after the table is recreated.

The `verify-target.sql` script checks:

- Tables exist and contain rows.
- Primary keys are present.
- Foreign keys are present.
- Indexes are present.
- Unique constraints are present.
- The managed identity role has grants on the transferred tables.

## Notes

- The source database is read-only in this flow (`COPY ... TO STDOUT`). No source data is modified.
- The target is a throwaway local database. Hosted target databases are never touched.
- If the source is unreachable, the transfer will fail early with a connection error.
- Docker commands must be run from your normal VS Code terminal, not the Copilot sandbox.

## Inspecting and preparing an existing local database

These scripts are hard-coded for the **ffc-pay-submission** Docker Postgres container on **port 5438**. If you are testing a different service, change `LOCAL_POSTGRES_PORT` and the database name in the commands below.

### Inspect the current schema and grants

Run from your normal VS Code terminal:

```bash
cd resources/testing/documents/delinked-data-transformer
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
node scripts/inspect-local-db.js ffc_pay_submission
```

This prints:

- Tables
- Primary keys
- Foreign keys
- Unique constraints
- Indexes
- Grants (including managed identity grants)

### Add test fixtures and a mock managed identity

If the database is missing keys/indexes/MID grants, run:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
node scripts/prepare-local-test-db.js ffc_pay_submission
```

This creates or updates:

- `devffcinfdmid01` role (if missing)
- `public.databasechangelog` and `public.databasechangeloglock` tables (if missing), granted to the MID
- Grants the MID `ALL PRIVILEGES` on every existing non-Liquibase table in the database
- `public.test_parent` and `public.test_child` tables with PK, FK, unique constraint and index
- Seed rows in the test tables
- MID grants on the test tables

You can then transfer just these test tables to verify the schema-preservation logic works.

### Verify the MID grants were applied

After running `prepare-local-test-db.js`, inspect again to confirm grants are present:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
node scripts/inspect-local-db.js ffc_pay_submission
```

Look for `devffcinfdmid01` in the **Grants** section.

## Remote-to-local single-table transfer

Once the local target database has been prepared, you can transfer a single table from the configured remote source into it. This is useful for verifying that primary keys, foreign keys, indexes and managed identity grants survive the transfer.

### Basic transfer

Run:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
DB_SOURCE_ENV=recovery \
node scripts/transfer-single-table.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission \
  --table schemes
```

This will:

1. Connect to the remote `ffc-pay-submission-prd` using `RECOVERY_DB_USER` / `RECOVERY_DB_PASSWORD` (or `POSTGRES_PRD_*` as a fallback).
2. Connect to the local `ffc_pay_submission` on `127.0.0.1:5438` using `LOCAL_POSTGRES_ADMIN` / `LOCAL_POSTGRES_PASSWORD`.
3. Drop and recreate `public.schemes` on the local target using `pg_dump --schema-only` for that table, preserving PKs, FKs, indexes, unique constraints and triggers.
4. Copy the data from remote to local.
5. Discover the mock managed identity from the local Liquibase tables and re-apply its grants on `public.schemes`.

Use `--skip-grants` if you want to test the copy without reinstating managed identity grants.

This script is **self-contained** and does not require `app/config/local.js` to be modified. It reads source credentials from `RECOVERY_DB_*` (or `POSTGRES_PRD_*` as a fallback) and target credentials from `LOCAL_POSTGRES_*` environment variables.

### Override source credentials

If the remote source requires a different username or password than the one configured in your environment, pass:

```bash
node scripts/transfer-single-table.js \
  --source-db ffc-pay-submission-prd \
  --source-admin my-username \
  --source-password my-password \
  --target-db ffc_pay_submission \
  --table schemes
```

You can also override the target credentials with `--target-admin` and `--target-password` if needed.

If you have the credentials in environment variables but with different names, export them before running:

```bash
export RECOVERY_DB_HOST=my-host
export RECOVERY_DB_USER=my-username
export RECOVERY_DB_PASSWORD=my-password
node scripts/transfer-single-table.js \
  --source-db ffc-pay-submission-prd \
  --target-db ffc_pay_submission \
  --table schemes
```

### Verify the transfer

After the transfer, inspect the local target database again:

```bash
LOCAL_POSTGRES_HOST=127.0.0.1 \
LOCAL_POSTGRES_PORT=5438 \
LOCAL_POSTGRES_ADMIN=postgres \
LOCAL_POSTGRES_PASSWORD=postgres \
node scripts/inspect-local-db.js ffc_pay_submission
```

Confirm that:

- `public.schemes` exists and contains data.
- `public.schemes` still has its primary key.
- The managed identity `devffcinfdmid01` still has grants on `public.schemes`.

If you are testing a different service, replace `ffc_pay_submission` with your local database name.
