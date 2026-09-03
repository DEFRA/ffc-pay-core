#!/usr/bin/env bash
set -euo pipefail

# Local integration test for the delinked data transformer.
# This transfers a single specified table from the configured source environment
# to a local PostgreSQL instance and verifies that keys, indexes and grants survive.

# -----------------------------------------------------------------------------
# Configuration: override these with environment variables as needed.
# -----------------------------------------------------------------------------
export DB_SCENARIO="local-test"
export DB_SOURCE_ENV="${DB_SOURCE_ENV:-recovery}"
export DB_TARGET_ENV="${DB_TARGET_ENV:-local}"

# Source credentials come from the existing config/env vars for the source environment.
# Local target credentials must be provided.
# Defaults to 127.0.0.1 because Docker on some setups does not resolve localhost
# correctly from the host terminal.
export LOCAL_POSTGRES_HOST="${LOCAL_POSTGRES_HOST:-127.0.0.1}"
export LOCAL_POSTGRES_ADMIN="${LOCAL_POSTGRES_ADMIN:-postgres}"
export LOCAL_POSTGRES_PASSWORD="${LOCAL_POSTGRES_PASSWORD:-postgres}"
export POSTGRES_PORT="${LOCAL_POSTGRES_PORT:-5438}"

# Which service database to copy. This should match the source database name
# without the environment suffix, e.g. ffc-pay-submission.
SERVICE_NAME="${SERVICE_NAME:-ffc-pay-submission}"
SOURCE_DB_NAME="${SOURCE_DB_NAME:-${SERVICE_NAME}-prd}"
TARGET_DB_NAME="${TARGET_DB_NAME:-ffc_pay_submission}"

# Tables to copy. Override with TABLE_FILTER to copy one table.
# By default the full sequential runner is used, which requires the local-test
# scenario config to be active (see README).
TABLE_FILTER="${TABLE_FILTER:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

echo "=== Local transfer test ==="
echo "Source: ${DB_SOURCE_ENV}/${SOURCE_DB_NAME}"
echo "Target: ${TARGET_DB_NAME}"
echo "Local Postgres: ${LOCAL_POSTGRES_HOST}:${POSTGRES_PORT}"
echo ""

# -----------------------------------------------------------------------------
# 1. Ensure local target database exists.
# -----------------------------------------------------------------------------
echo "[1/5] Ensuring local target database exists..."
PGPASSWORD="${LOCAL_POSTGRES_PASSWORD}" psql \
  -h "${LOCAL_POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${LOCAL_POSTGRES_ADMIN}" \
  -d postgres \
  -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${TARGET_DB_NAME}\"; CREATE DATABASE \"${TARGET_DB_NAME}\";" || true

PGPASSWORD="${LOCAL_POSTGRES_PASSWORD}" psql \
  -h "${LOCAL_POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${LOCAL_POSTGRES_ADMIN}" \
  -d "${TARGET_DB_NAME}" \
  -v ON_ERROR_STOP=1 \
  -f "${SCRIPT_DIR}/setup-local-postgres.sql"

# -----------------------------------------------------------------------------
# 2. Optionally seed the source table(s) for a controlled test.
#    Skip this if you want to test against real source data.
# -----------------------------------------------------------------------------
if [ "${SEED_SOURCE:-false}" = "true" ]; then
  echo "[2/5] Seeding source tables (parent_records, child_records)..."
  PGPASSWORD="${SOURCE_POSTGRES_PASSWORD:-}" psql \
    -h "${SOURCE_POSTGRES_HOST:-}" \
    -p "${POSTGRES_PORT}" \
    -U "${SOURCE_POSTGRES_ADMIN:-}" \
    -d "${SOURCE_DB_NAME}" \
    -v ON_ERROR_STOP=1 \
    -f "${SCRIPT_DIR}/setup-source-table.sql" || echo "Source seed failed (expected if source is not reachable or read-only). Continuing..."
else
  echo "[2/5] Skipping source seed. Using real source data."
fi

# -----------------------------------------------------------------------------
# 3. Run the transfer for a single table or the whole database.
# -----------------------------------------------------------------------------
echo "[3/5] Running data transfer..."
if [ -n "${TABLE_FILTER}" ]; then
  echo "Filtering to table: ${TABLE_FILTER}"
  # transfer-single-table.js is self-contained and does not require
  # app/config/local.js to be modified.
  node "${SCRIPT_DIR}/transfer-single-table.js" \
    --source-db "${SOURCE_DB_NAME}" \
    --target-db "${TARGET_DB_NAME}" \
    --table "${TABLE_FILTER}"
else
  # Full-database transfer uses the main runner, which currently requires the
  # local-test scenario config to be active.
  if [ ! -f app/config/local.js ] || ! grep -q "local-test" app/config/local.js; then
    echo "ERROR: Full-database transfer requires the local-test scenario config."
    echo "Run: cp scripts/local-test-scenario.js app/config/local.js"
    exit 1
  fi
  node app/database/sequential-transfer-runner.js \
    --service "{\"name\":\"${SERVICE_NAME}\",\"sourceDbName\":\"${SOURCE_DB_NAME}\",\"targetDbName\":\"${TARGET_DB_NAME}\"}" \
    --source-environment "${DB_SOURCE_ENV}" \
    --target-environment "${DB_TARGET_ENV}" \
    --table-by-table
fi

# -----------------------------------------------------------------------------
# 4. Verify the target schema.
# -----------------------------------------------------------------------------
echo "[4/5] Verifying target schema..."
PGPASSWORD="${LOCAL_POSTGRES_PASSWORD}" psql \
  -h "${LOCAL_POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${LOCAL_POSTGRES_ADMIN}" \
  -d "${TARGET_DB_NAME}" \
  -f "${SCRIPT_DIR}/verify-target.sql"

# -----------------------------------------------------------------------------
# 5. Optional: clean up the local database.
# -----------------------------------------------------------------------------
if [ "${CLEANUP:-false}" = "true" ]; then
  echo "[5/5] Cleaning up local target database..."
  PGPASSWORD="${LOCAL_POSTGRES_PASSWORD}" psql \
    -h "${LOCAL_POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -U "${LOCAL_POSTGRES_ADMIN}" \
    -d postgres \
    -c "DROP DATABASE IF EXISTS \"${TARGET_DB_NAME}\";"
else
  echo "[5/5] Leaving local target database in place for inspection."
  echo "      Connect with: PGPASSWORD=${LOCAL_POSTGRES_PASSWORD} psql -h ${LOCAL_POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${LOCAL_POSTGRES_ADMIN} -d ${TARGET_DB_NAME}"
fi

echo ""
echo "=== Local transfer test complete ==="
