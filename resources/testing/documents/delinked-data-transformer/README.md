# Delinked Data Transformer

> Part of the [Testing & Data Tools](..) collection.  
> This README covers the transformer and local-test workflows; see the index for the other tools.

Two database copy workflows live in this repo:

1. **`test-to-dev`** — the original interactive pipeline for generating dummy data, dumping test tables, transforming SQL, and uploading to dev.
2. **source-to-target** — a configurable, command-driven pipeline for copying any supported source environment to any supported target environment. It was originally built for `prd -> pre` but now handles combinations such as `recovery -> pre`, `prd -> test`, etc.

Both use the same database tooling and shared environment definitions.

## What it does

- Streams a service database from a source environment to a target environment.
- Discovers and saves source table metadata and primary-key information.
- Validates row counts and distinct key counts after transfer.
- Supports dry-run mode so you can check connectivity, service selection, and sizes before copying data.
- Continues past individual service failures when `--continue-on-error` is set.
- Reports database/table sizes and switches to table-by-table copying for large tables.
- Supports password authentication for recovery databases and Azure AD authentication for Azure-hosted environments.
- Reinstates managed identity (MID) grants after transfer by discovering the MID from the preserved Liquibase tables on the target.
- Preserves primary keys, foreign keys, indexes, unique constraints and triggers through `pg_dump` schema restoration.

## Prerequisites

- Node.js installed
- Access to the Azure-hosted or recovery PostgreSQL servers
- Required environment variables loaded in your shell (`.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, etc.)
- No repo-local `.env` file is used

Typical environment variables:

- `POSTGRES_DEV_HOST`, `POSTGRES_TEST_HOST`, `POSTGRES_PRE_HOST`, `POSTGRES_PRD_HOST`, `RECOVERY_DB_HOST`
- `POSTGRES_DEV_ADMIN`, `POSTGRES_TEST_ADMIN`, `POSTGRES_PRE_ADMIN`, `POSTGRES_PRD_ADMIN`, `RECOVERY_DB_ADMIN`
- `RECOVERY_DB_USER`, `RECOVERY_DB_PASSWORD`
- `DEV_TENANT_ID`, `TEST_TENANT_ID`, `PRE_TENANT_ID`, `PRD_TENANT_ID`

## Configuration

Active settings live in [app/config/local.js](app/config/local.js):

```js
module.exports = {
  scenario: 'prd-to-pre',
  sourceEnvironment: 'recovery',
  targetEnvironment: 'pre'
}
```

Supported environments: `dev`, `test`, `pre`, `prd`, `recovery`, `local`. The environment definitions (host/admin/password env vars, suffix and auth mode) are the single source of truth in [app/constants/environment-definitions.js](app/constants/environment-definitions.js).

The scenario name remains `prd-to-pre` for historical reasons, but the actual source and target environments are controlled by `sourceEnvironment` and `targetEnvironment` (or by `DB_SOURCE_ENV` / `DB_TARGET_ENV`).

## Authentication

- Azure-hosted environments (`dev`, `test`, `pre`, `prd`) use Azure AD authentication. The utility obtains an access token automatically from your logged-in Azure credentials and passes it to PostgreSQL as the password. You do not need a password environment variable for these environments, but you must be authenticated to Azure (for example via `az login` or service-principal env vars).
- Recovery databases use password authentication via `RECOVERY_DB_USER` and `RECOVERY_DB_PASSWORD`.
- The utility invokes `psql` and `pg_dump` non-interactively; they will never prompt for a password. If authentication fails, the command exits with an error instead of hanging.

Override source/target at runtime:

```bash
DB_SOURCE_ENV=prd DB_TARGET_ENV=pre node app/index.js --scenario prd-to-pre --direct
DB_SOURCE_ENV=recovery DB_TARGET_ENV=test node app/index.js --scenario prd-to-pre --direct
```

## Current usage

All commands are run from the transformer directory:

```bash
cd /home/bunglehaze/defra/ffc-pay-core/resources/testing/documents/delinked-data-transformer
```

### Source-to-target pipeline (hosted)

The actual source and target are controlled by `sourceEnvironment` and `targetEnvironment` in [app/config/local.js](app/config/local.js) or by `DB_SOURCE_ENV` / `DB_TARGET_ENV`.

#### Examples

Transfer from production to pre-production:

```bash
DB_SOURCE_ENV=prd DB_TARGET_ENV=pre node app/index.js --scenario prd-to-pre --direct --dry-run
DB_SOURCE_ENV=prd DB_TARGET_ENV=pre node app/index.js --scenario prd-to-pre --direct
```

Transfer from recovery to test:

```bash
DB_SOURCE_ENV=recovery DB_TARGET_ENV=test node app/index.js --scenario prd-to-pre --direct --dry-run
DB_SOURCE_ENV=recovery DB_TARGET_ENV=test node app/index.js --scenario prd-to-pre --direct
```

Transfer from test to dev:

```bash
DB_SOURCE_ENV=test DB_TARGET_ENV=dev node app/index.js --scenario prd-to-pre --direct --dry-run
DB_SOURCE_ENV=test DB_TARGET_ENV=dev node app/index.js --scenario prd-to-pre --direct
```

Check connectivity and configuration:

```bash
node app/index.js --scenario prd-to-pre --direct --test-connection --dry-run
```

Run the live transfer:

```bash
node app/index.js --scenario prd-to-pre --direct
```

Add `--dry-run` to any of the commands above to preview what would happen without copying data.

Continue past individual service failures:

```bash
node app/index.js --scenario prd-to-pre --direct --continue-on-error
```

Copy large services table-by-table and without a single transaction:

```bash
node app/index.js --scenario prd-to-pre --direct --table-by-table --no-single-transaction
```

Override the large-table thresholds:

```bash
LARGE_TABLE_ROW_THRESHOLD=500000 LARGE_TABLE_SIZE_MB_THRESHOLD=512 node app/index.js --scenario prd-to-pre --direct
```

A table is considered large when it has at least `LARGE_TABLE_ROW_THRESHOLD` rows (default 1,000,000) or is at least `LARGE_TABLE_SIZE_MB_THRESHOLD` MB (default 1,024 MB). When large tables are detected, the runner automatically switches to table-by-table mode unless you already requested it.

Resume a previous run, skipping services already marked completed:

```bash
node app/index.js --scenario prd-to-pre --direct --resume
```

Start fresh and ignore existing checkpoints:

```bash
node app/index.js --scenario prd-to-pre --direct --reset-checkpoints
```

### `test-to-dev` pipeline

Run interactively with prompts:

```bash
node app/index.js --scenario test-to-dev --dry-run
node app/index.js --scenario test-to-dev
```

This steps through dummy-data creation, dumps, transforms, and uploads. Add `--dry-run` to preview.

### Refresh metadata for a service

```bash
node app/database/discover-service-metadata.js --database <service-source-db> --environment <source-env> --save
```

Example:

```bash
node app/database/discover-service-metadata.js --database ffc-pay-alerting-prd --environment prd --save
```

Saved metadata is written under `metadata/`, e.g. `metadata/ffc-pay-alerting-prd-prd.json`. The runner uses saved metadata automatically when available, or discovers and saves it if missing.

### Run the sequential runner directly

The direct command delegates to the sequential runner. You can also call it directly with a custom service list:

```bash
node app/database/sequential-transfer-runner.js --services-file ./app/database/service-manifest.js --dry-run
node app/database/sequential-transfer-runner.js --services-file ./app/database/service-manifest.js
```

It supports the same flags:

```bash
node app/database/sequential-transfer-runner.js --services-file ./app/database/service-manifest.js --table-by-table --no-single-transaction --continue-on-error
```

## Command reference

### `node app/index.js`

```
--scenario <name>          test-to-dev | prd-to-pre
--direct                   Run source-to-target non-interactively
--dry-run                  Simulate; do not copy data
--test-connection          Test source and target connectivity
--continue-on-error        Skip failed services and report them at the end
--table-by-table           Copy tables individually for progress and memory safety
--no-single-transaction    Restore without wrapping in a single transaction
--resume                   Skip services already marked completed in checkpoints
--reset-checkpoints        Delete existing checkpoints before running
```

### `node app/database/sequential-transfer-runner.js`

```
--services-file <path>     Load a custom service manifest
--source-environment <env> Default: prd
--target-environment <env> Default: pre
--dry-run                  Simulate
--continue-on-error        Skip failed services
--table-by-table           Copy tables individually
--no-single-transaction    Non-transactional restore
--resume                   Skip services already marked completed in checkpoints
--reset-checkpoints        Delete existing checkpoints before running
```

## Checkpoints

Service-level checkpoints are written to the `checkpoints/` directory after a service completes and validates successfully. If a run fails part-way through, rerun with `--resume` and any service already marked `completed` will be skipped.

Checkpoint files are named like:

```
checkpoints/ffc-pay-alerting-prd-to-pre.json
```

Use `--reset-checkpoints` to delete them and start from scratch. Checkpoints are not written during dry-runs.

## How a transfer runs

For each service in the manifest:

1. Load saved metadata or discover and save it from the source database.
2. Report source database size and large tables.
3. Truncate target tables while preserving Liquibase metadata.
4. Copy data and schema:
   - Default: `pg_dump | psql` with `--single-transaction`.
   - Large tables or `--table-by-table`: copy each table individually with per-table progress.
   - Schema objects (primary keys, foreign keys, indexes, unique constraints and triggers) are restored through `pg_dump --schema-only`.
5. Re-apply managed identity grants by discovering the MID from the preserved Liquibase tables on the target (`databasechangelog` owner/grantees).
6. Validate row counts and distinct key counts (skipped in dry-run).
7. Print a final summary of succeeded and failed services.

### Local testing equivalent

To verify the same copy/grant behaviour against a local PostgreSQL instance, see [scripts/README.md](scripts/README.md). In particular:

- [scripts/transfer-single-table.js](scripts/transfer-single-table.js) copies one table from a configured source to a local database, preserving its schema and reinstating MID grants.
- [scripts/run-local-transfer-test.sh](scripts/run-local-transfer-test.sh) orchestrates the full local test flow including setup, transfer and verification.

## Important operational notes

- Liquibase metadata tables are preserved on the target and excluded from the copy; this is what allows the grant step to discover the correct managed identity per database.
- The source role must be able to read all application tables needed for the copy.
- By default the runner stops at the first failure. Use `--continue-on-error` only when you accept that failed services will leave the target in a partial state.
- `--no-single-transaction` can help with very large restores but also means a failed restore can leave partially copied data.
- Managed identity grants are reinstated automatically after transfer by the sequential runner and by `scripts/transfer-single-table.js`; use `--skip-grants` to disable this.

## File layout

- `app/index.js` — main entry point
- `app/config/local.js` — active source/target configuration
- `app/config/index.js` — config merging
- `app/constants/environment-definitions.js` — shared environment definitions
- `app/database/service-manifest.js` — ordered services and manifest builder
- `app/database/discover-service-metadata.js` — inspect and persist schema metadata
- `app/database/sequential-transfer-runner.js` — run copy and validation per service
- `app/database/stream-prd-to-pre.js` — copy logic and target cleanup
- `app/database/transfer-validation.js` — row-count and PK-count validation
- `app/database/metadata-storage.js` — persisted metadata snapshots
- `app/scenarios/prd-to-pre.js` — single-service scenario helper
- `app/scenarios/test-to-dev.js` — original interactive scenario
- `dummy-data-creation/` — dummy-data helpers
- `app/transform/` — SQL transformation utilities
- `app/upload/` — upload utilities

