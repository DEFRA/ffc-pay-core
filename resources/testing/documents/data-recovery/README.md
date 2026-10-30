# PostgreSQL Database Backup And Restore

This directory contains a PostgreSQL database refresh tool with two set workflows: archive backup/restore for a durable local copy, and direct streaming from source to target when no archive is needed. Both stage each database on the target and replace existing targets only after validation.

The workflow is database-wide; it does not require payment-request IDs, a queue, or a service-specific table list. It preserves database schemas, tables, data, sequences, constraints, indexes, triggers, views, routines, extensions, and large objects. An anonymization step is not included.

## Safety And Scope

- The source is read-only. Backup uses a repeatable-read snapshot and does not modify source data.
- Archive restore verifies the archive checksum and table of contents. Both workflows validate schema fingerprint, extensions, locale, relation inventory, and exact row counts before cutover.
- A live single-database restore requires `--wipe --confirm-target`; live set restore and streaming require `--wipe --confirm-target-set` with the token printed by dry-run.
- During cutover, the current target is renamed and kept offline as a rollback database. It is not dropped automatically.
- Source and target database major versions must match. The `pg_dump`/`pg_restore` tools must be compatible with the archive.
- Required extension names must be available on the target. PostgreSQL installs the target's default extension version; version differences are warned about because extension code may behave differently. Set `RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS=true` in `~/.bashrc` to reject version differences.
- Database encoding, collation, `LC_CTYPE`, locale provider, and ICU locale must match the source. A different libc/ICU collation library version is allowed with a warning: indexes are rebuilt using the target version, so verify collation-sensitive ordering and uniqueness behavior. A stale collation version within either database is rejected.
- Foreign tables are rejected because their external data is not part of a normal database archive. Tablespace placement, cluster roles, role memberships, source ownership, and source ACLs are not copied.
- Restored objects are owned by the configured target database user. Set `RECOVERY_TARGET_APP_ROLES` to grant target-specific application roles access; do not assume source grants are appropriate in another environment.
- The archive contains the source data as-is. It is not anonymized. Protect it as sensitive data and do not send production-derived data to a lower environment without an approved privacy policy.

## Prerequisites

- Node.js 18 or newer.
- PostgreSQL `pg_dump` and `pg_restore` client tools on `PATH`.
- Source credentials with permission to read the entire database and export a snapshot.
- Target credentials with permission to create databases, terminate connections to the selected target, and rename databases. Hosted restores generally require an administrative database role.
- Docker, if using the bundled local PostgreSQL target.

Run commands from this directory:

```bash
cd resources/testing/documents/data-recovery
npm install
```

## Configure Credentials In `~/.bashrc`

Put connection settings in your local `~/.bashrc`, not in the repository and not as one-off commands in the terminal. Add the source settings and whichever target settings you use, then load them into the current terminal with `source ~/.bashrc` or open a new terminal.

```bash
# Source server, shared by every database in the set
export RECOVERY_SOURCE_DB_HOST=source.postgres.example
export RECOVERY_SOURCE_DB_USER=readonly_user
export RECOVERY_SOURCE_DB_PASSWORD=source_password
export RECOVERY_SOURCE_DB_PORT=5432
export RECOVERY_SOURCE_DB_SSL=true
export RECOVERY_SOURCE_DB_SSL_MODE=require

# Local PostgreSQL target settings for TARGET_ENV = 'local'
export LOCAL_DB_HOST=localhost
export LOCAL_DB_PORT=5467
export LOCAL_DB_USER=postgres
export LOCAL_DB_PASSWORD=ppp

# Hosted PostgreSQL target settings for TARGET_ENV = 'test', 'dev', etc.
export RECOVERY_TARGET_DB_HOST=target.postgres.example
export RECOVERY_TARGET_DB_USER=target_admin
export RECOVERY_TARGET_DB_PASSWORD=target_password
export RECOVERY_TARGET_DB_PORT=5432
export RECOVERY_TARGET_DB_SSL=true
export RECOVERY_TARGET_DB_SSL_MODE=require
export RECOVERY_TARGET_ADMIN_DATABASE=postgres
# Optional roles that should receive full privileges on restored databases
export RECOVERY_TARGET_APP_ROLES=app_runtime_role,reporting_role
# Optional: fail restore if target extension versions differ from the source
export RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS=true
```

Keep this file private and out of source control. The set runner chooses local versus hosted from `TARGET_ENV` in `app/config/database-refresh.js`; do not set `RECOVERY_SOURCE_DATABASE`, `RECOVERY_TARGET_DATABASE`, or `RECOVERY_SERVICE_NAME` for set commands.

## Configure The Source

Choose database names and `SOURCE_ENV` in `app/config/database-refresh.js`. For example, `SOURCE_ENV = 'prd'` and base name `ffc-pay-processing` select `ffc-pay-processing-prd`. Source credentials come from `~/.bashrc`; `.env` files are not loaded.

## Configure The Database Set

Edit [app/config/database-refresh.js](app/config/database-refresh.js) to select the source environment, target environment, and base database names. Names in `DATABASE_NAMES` must not include environment suffixes:

```js
const SOURCE_ENV = 'prd'
const TARGET_ENV = 'local' // or 'dev', 'test', or another configured environment

const DATABASE_NAMES = [
	'ffc-pay-processing',
	'ffc-pay-submission'
]
```

The repository config contains the full database list. Each selected base name is suffixed independently, for example `ffc-pay-processing-prd` to `ffc-pay-processing-local`. All databases in one set use the same source host and the same target host. Do not export `RECOVERY_SOURCE_DATABASE`, `RECOVERY_TARGET_DATABASE`, or `RECOVERY_SERVICE_NAME` when using set commands; the runner supplies those per database.

Verify a resolved source connection with `psql` before starting a large set operation. This example matches `SOURCE_ENV = 'prd'` and base name `ffc-pay-processing`:

```bash
PGPASSWORD="$RECOVERY_SOURCE_DB_PASSWORD" \
PGSSLMODE=require \
psql -h "$RECOVERY_SOURCE_DB_HOST" \
	-p "${RECOVERY_SOURCE_DB_PORT:-5432}" \
	-U "$RECOVERY_SOURCE_DB_USER" \
	-d ffc-pay-processing-prd \
	-c 'SELECT current_database(), current_user, version();'
```

Change the database argument to the resolved name for another base database. This checks connectivity and identity; backup and streaming also verify that the source role can export a consistent snapshot and read all database objects and rows.

## Back Up The Configured Set

After configuring and loading `~/.bashrc`, the configured source environment and each base name select the databases:

```bash
npm run database:backup-set
```

The default output is a timestamped directory under `dumps/`. It contains one custom-format `.dump` archive and `.dump.json` metadata sidecar per database, plus `database-refresh-set.json`. Keep the entire directory together. Archives and metadata are created with owner-only permissions where supported and are ignored by Git.

To back up only selected databases from `DATABASE_NAMES`:

```bash
npm run database:backup-set -- \
	--database ffc-pay-processing \
	--database ffc-pay-submission
```

The command stops on the first failure and removes the incomplete output directory. It does not mark a partial set as complete.

## Stream The Configured Set

Streaming uses the same `DATABASE_NAMES`, `SOURCE_ENV`, and `TARGET_ENV` config but pipes each source `pg_dump` directly into `pg_restore` on its staging target. It creates no durable archive directory or local database copy. The source and target must be reachable at the same time; the target still needs enough space for each staging database.

Set source credentials as in **Back Up The Configured Set**, then configure the target server credentials. For local testing, keep `TARGET_ENV = 'local'`; for hosted refreshes, set it to `test`, `dev`, or another target suffix in [app/config/database-refresh.js](app/config/database-refresh.js).

Run the stream preflight first. It checks every source/target pair and prints a set confirmation token without creating staging databases:

```bash
npm run database:stream-set -- --dry-run
```

Review every endpoint, then run with the token printed by the dry run:

```bash
npm run database:stream-set -- --wipe --confirm-target-set <token-from-dry-run>
```

To stream only selected base names from `DATABASE_NAMES`, pass them to both commands:

```bash
npm run database:stream-set -- --dry-run \
	--database ffc-pay-processing \
	--database ffc-pay-submission

npm run database:stream-set -- --wipe \
	--confirm-target-set <token-from-dry-run> \
	--database ffc-pay-processing \
	--database ffc-pay-submission
```

The stream token is bound to the selected source names and target endpoints. The live operation holds a consistent snapshot per database while that database streams. All databases are staged and validated before the first cutover; cutovers are sequential, not atomic as a set. If a later cutover fails, the tool attempts to roll back earlier cutovers.

## Restore The Set To Local

Keep `TARGET_ENV = 'local'` in the config. The local server is a PostgreSQL host for the individually named targets, for example `ffc-pay-processing-local`; `LOCAL_DB_NAME` is not used as a shared data target when a base name is selected.

The bundled server uses PostgreSQL 16. If the existing Compose volume was created by PostgreSQL 11, it cannot be reused by PostgreSQL 16. To deliberately discard that old local volume and initialize the new server, run from this directory:

```bash
docker compose down -v
docker compose up -d --wait
```

The `down -v` command permanently deletes all data in this Compose volume. Check that the local server is available:

```bash
PGPASSWORD=ppp psql -h localhost -p 5467 -U postgres -d postgres \
  -c 'SELECT current_database(), version();'
```

The local server uses PostgreSQL 16. The source and target PostgreSQL major versions must match. The same local connection settings are used by archive restore and streaming.

Run the set restore dry-run first. It verifies every archive and target and prints all endpoints plus one set confirmation token:

```bash
npm run database:restore-set -- \
  --manifest dumps/<backup-set>/database-refresh-set.json \
  --dry-run
```

Review the listed databases and token, then run the live restore with that exact token:

```bash
npm run database:restore-set -- \
  --manifest dumps/<backup-set>/database-refresh-set.json \
  --wipe \
  --confirm-target-set <token-from-dry-run>
```

All databases are restored and validated in staging before any target is cut over. Cutovers are sequential, not atomic as a set; if a later cutover fails, the tool attempts to roll back databases already cut over. Previous targets remain offline for verification or manual recovery.

## Restore The Set To A Hosted Target

Set `TARGET_ENV` in `app/config/database-refresh.js` to `test`, `dev`, or another hosted environment. Put the matching target server credentials in `~/.bashrc` as shown in **Configure Credentials In `~/.bashrc`**. The set runner derives each target database name from `DATABASE_NAMES` and `TARGET_ENV`.

If applications use separate roles, list existing target roles with `RECOVERY_TARGET_APP_ROLES` in `~/.bashrc`. Run the set dry-run and confirmed restore commands; inspect every target before using the token.

## Choose Archive Or Stream

- **Archive set** (`database:backup-set`, then `database:restore-set`) writes one durable archive and JSON object per database under `dumps/`. Use it when you want to retain the backup, retry restore later, or move the set separately from the source.
- **Streaming set** (`database:stream-set`) pipes source `pg_dump` output directly into `pg_restore` on each target staging database. It creates no durable local archives, but source and target must be reachable at the same time. It still uses temporary staging databases on the target.

Both modes use a repeatable-read snapshot per database, verify schema and row counts, stage and validate the full set before cutover, require `--wipe` plus explicit set confirmation for live changes, and keep old targets offline for rollback. The set as a whole is not transactionally atomic, and data is not anonymized. Do not copy production data into a lower environment without approval.

## Single-Database Commands

The single-database archive commands remain available for ad-hoc databases outside `DATABASE_NAMES`:

```bash
npm run database:backup -- --output dumps/source-refresh.dump
npm run database:restore -- --archive dumps/source-refresh.dump --dry-run
npm run database:restore -- --archive dumps/source-refresh.dump --wipe \
  --confirm-target target.postgres.example:5432/target_database
```