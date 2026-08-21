#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_RECOVERY_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DUMP_DIR="${DATA_RECOVERY_DIR}/dumps"

HOST="${LOCAL_DB_HOST:-localhost}"
PORT="${LOCAL_DB_PORT:-5467}"
USER="${LOCAL_DB_USER:-postgres}"
DATABASE="${LOCAL_DB_NAME:-ffc_pay_local_recovery}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

TABLES=(
  '"invoiceLines"'
  '"completedPaymentRequests"'
  '"schedule"'
  '"completedInvoiceLines"'
  '"outbox"'
)

mkdir -p "${DUMP_DIR}"

STAGING_DUMP="${DUMP_DIR}/recovery-staging-${TIMESTAMP}.dump"
DELTA_SQL="${DUMP_DIR}/recovery-delta-${TIMESTAMP}.sql"

echo "Creating staging restore dump: ${STAGING_DUMP}"

PGPASSWORD="${LOCAL_DB_PASSWORD:-ppp}" pg_dump \
  -h "${HOST}" \
  -p "${PORT}" \
  -U "${USER}" \
  -d "${DATABASE}" \
  -Fc \
  --no-owner \
  --no-privileges \
  $(for table in "${TABLES[@]}"; do echo "--table public.${table}"; done) \
  > "${STAGING_DUMP}"

echo "Creating delta insert script: ${DELTA_SQL}"

# Generate data-only INSERT statements for review. These are intended to be run
# against an empty staging schema or edited into a proper migration script.
PGPASSWORD="${LOCAL_DB_PASSWORD:-ppp}" pg_dump \
  -h "${HOST}" \
  -p "${PORT}" \
  -U "${USER}" \
  -d "${DATABASE}" \
  --data-only \
  --inserts \
  --no-owner \
  --no-privileges \
  $(for table in "${TABLES[@]}"; do echo "--table public.${table}"; done) \
  > "${DELTA_SQL}"

echo ""
echo "Staging dump files created in ${DUMP_DIR}:"
echo "  ${STAGING_DUMP}   (restore with pg_restore into empty staging DB)"
echo "  ${DELTA_SQL}      (apply as delta to existing staging DB)"
echo ""
echo "Restore example:"
echo "  PGPASSWORD=<staging-password> pg_restore -h <staging-host> -p 5432 -U <staging-user> -d ffc_pay_staging --clean ${STAGING_DUMP}"
