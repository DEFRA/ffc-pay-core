# PostgreSQL Database Refresh

Copy whole PostgreSQL databases from a source server to local or hosted targets. The source is read-only. The tool restores into separate staging databases, checks the copy, and replaces the targets only after validation.

The configured set includes `ffc-pay`, `fcp-pds` and `ffc-doc` databases. Optional Faker masking currently applies **only to the two configured document organisation tables**, not to payment/PDS databases or every document service.

## Choose A Workflow

| Workflow | Commands | Use when |
| --- | --- | --- |
| Direct streaming | `database:stream-set` | Copy source to target without saving a data dump. Both servers must be reachable together. |
| Backup and restore | `database:backup-set`, then `database:restore-set` | Keep a reusable local archive, retry a restore, or transfer it to another machine. |
| One database | `database:backup`, `database:restore` | Work outside the configured database set. |
| Mask an existing target | `database:anonymise` | Apply an existing mapping to an offline target without copying again. |

Both copy workflows preserve schema, data, sequences, constraints, indexes, triggers, views, routines, extensions and large objects, subject to the safety checks below. They do not generate dummy records or require payment IDs, messages or queues.

## Before You Start

1. Use a supported Node.js release; Node.js 22 LTS or newer is recommended. Install PostgreSQL `pg_dump` and `pg_restore` client tools on `PATH`. `psql` is useful for manual checks.
2. Obtain source access to read every database object and export a consistent snapshot. The target user needs permission to create/rename databases, disconnect clients and restore objects.
3. Connect the required VPN/private network. Source and target PostgreSQL major versions must match; client tools must be compatible with them. The bundled local server uses PostgreSQL 16.
4. Allow storage for staging and any retained previous targets. Stop target applications/workers during the refresh so they do not write data that will be replaced. Do not refresh a target without approval.
5. Install dependencies and run all commands below from this directory:

```bash
cd resources/testing/documents/data-recovery
npm install
```

## Configure The Database Set

[app/config/database-refresh.js](app/config/database-refresh.js) defines:

| Setting | Purpose |
| --- | --- |
| `DATABASE_NAMES` | Base service names to copy. No environment suffixes. Includes payment, PDS and document services. |
| `LOCAL_DATABASE_TARGETS` | Local database names and host-mapped ports, keyed by base service name. |
| `DEFAULT_SOURCE_ENV`, `DEFAULT_TARGET_ENV` | Naming defaults, currently `prd` and `local`. Shell settings override them. |
| `DEFAULT_SOURCE_AUTH`, `DEFAULT_HOSTED_TARGET_AUTH` | Default authentication modes, currently `entra`. Local targets always use password auth. |
| `DATABASE_AUTH_OVERRIDES` | Optional per-service source/hosted-target authentication and tenant overrides. No passwords belong here. |

This example shows entries to retain or add, not a replacement for the complete database list:

```js
const DATABASE_NAMES = [
	'ffc-pay-processing',
	'fcp-pds-data-retention',
	'ffc-doc-statement-data',
	'ffc-doc-statement-constructor'
]

const LOCAL_DATABASE_TARGETS = {
	'ffc-doc-statement-data': { databaseName: 'ffc_doc_statement_data', port: 5482 },
	'ffc-doc-statement-constructor': { databaseName: 'ffc_doc_statement_constructor', port: 5486 }
}
```

For `local`, a missing database-name override becomes the base name with hyphens replaced by underscores. A configured per-service port takes precedence over `LOCAL_DB_PORT`, whose fallback is `5467`. All local targets use `LOCAL_DB_HOST`, but can use different ports. Remote targets use `<base-name>-<target-suffix>` on the shared hosted target server.

### Database Suffix Is Not Server Location

`DATABASE_REFRESH_SOURCE_ENV` selects a **database-name suffix**, not an Azure hosting environment. The hostname independently selects the server:

| Example setting | Result |
| --- | --- |
| `RECOVERY_SOURCE_DB_HOST=source-postgres.example.invalid` | Connect to that server; replace this deliberately non-resolving example. |
| `DATABASE_REFRESH_SOURCE_ENV=prd` | Request names such as `ffc-doc-statement-data-prd` on that server. |
| `DATABASE_REFRESH_SOURCE_ENV=test` | Request names such as `ffc-doc-statement-data-test` on the same server. |
| `DATABASE_REFRESH_TARGET_ENV=local` | Use local names/ports rather than hosted target settings. |

A production-derived test copy hosted in PRE can correctly use a PRE-hosted server **and** `DATABASE_REFRESH_SOURCE_ENV=prd` if its databases retain their `-prd` names. Setting the suffix to `pre` would request `-pre` databases, not move the connection to PRE.

Exported values override the file defaults. Changing a default or a comment does not replace a value already exported in a terminal.

## Environment Variables In ~/.bashrc

Put your chosen settings in your private `~/.bashrc`, not in the repository. The tool does not load `.env` files. Reload with `source ~/.bashrc` after changes; commenting out an export does not unset an existing value in the current terminal.

**All remote hostnames below end in `.invalid` and cannot be real endpoints. All `<EXAMPLE_...>` values are placeholders, not credentials or tenant IDs. Replace them before use. `localhost` refers only to your own machine.** Never commit real passwords, client secrets or certificate passwords.

### Source And Local Target

This is the common password-source to local setup. Source settings are shared by all selected services:

```bash
# Naming only: match the actual database suffix on the source server.
# Use test/pre/dev instead of prd if the database names have that suffix.
export DATABASE_REFRESH_SOURCE_ENV=prd
# local uses LOCAL_DB_* and per-service ports; test/dev/pre use hosted target settings.
export DATABASE_REFRESH_TARGET_ENV=local

# Source server: host only, with no URL scheme, port or database path.
export RECOVERY_SOURCE_DB_HOST='source-postgres.example.invalid'
export RECOVERY_SOURCE_DB_PORT=5432                  # Default: 5432.
export RECOVERY_SOURCE_DB_USER='<EXAMPLE_SOURCE_USER>'
export RECOVERY_SOURCE_DB_AUTH=password             # Alternative: entra; tool default: entra.
export RECOVERY_SOURCE_DB_PASSWORD='<EXAMPLE_SOURCE_PASSWORD>' # Required for password auth only.
export RECOVERY_SOURCE_DB_SSL=true                  # Default: enabled. false disables TLS.
export RECOVERY_SOURCE_DB_SSL_MODE=require          # Default: require; see TLS choices below.

# Local targets: these are also the defaults used by the bundled Compose server.
export LOCAL_DB_HOST=localhost
export LOCAL_DB_PORT=5467                           # Fallback only; per-service ports take precedence.
export LOCAL_DB_USER=postgres
export LOCAL_DB_PASSWORD=ppp                        # Bundled local development password only.
```

Do not use the bundled local password for hosted databases. `LOCAL_DB_*` is used for local targets, not source connections. Local targets do not use the hosted-target TLS or authentication settings.

### Hosted Target Alternative

For a remote target, change the target suffix and add the settings below. Keep the source configuration above. Archive restore does not need source credentials because it reads the saved archive.

```bash
export DATABASE_REFRESH_TARGET_ENV=test             # Example suffix: targets become <service>-test.
export RECOVERY_TARGET_DB_HOST='target-postgres.example.invalid'
export RECOVERY_TARGET_DB_PORT=5432                 # Default: 5432.
export RECOVERY_TARGET_DB_USER='<EXAMPLE_TARGET_ADMIN>'
export RECOVERY_TARGET_DB_AUTH=password             # Alternative: entra; tool default: entra.
export RECOVERY_TARGET_DB_PASSWORD='<EXAMPLE_TARGET_PASSWORD>' # Password mode only.
export RECOVERY_TARGET_DB_SSL=true                 # Default: enabled.
export RECOVERY_TARGET_DB_SSL_MODE=require          # Same TLS choices as the source.
export RECOVERY_TARGET_ADMIN_DATABASE=postgres      # Maintenance DB for CREATE/ALTER DATABASE; default: postgres.

# Optional: comma-separated EXISTING target roles to grant application access.
# Omit for local targets unless those roles exist there too. No automatic MID discovery.
# export RECOVERY_TARGET_APP_ROLES='<EXAMPLE_APP_ROLE>,<EXAMPLE_REPORTING_ROLE>'

# Optional: reject extension-version differences instead of warning (default: false).
# Extension names must be available on the target regardless of this setting.
# export RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS=true
```

`RECOVERY_TARGET_ADMIN_DATABASE`, `RECOVERY_TARGET_APP_ROLES` and `RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS` can also apply to local restores. Omit optional settings you do not need. There is no need to change hosted-target values when selecting a different source suffix.

### Entra Authentication Alternative

Use this only for a side that authenticates with Entra. No tenant or token is needed for password authentication. The database user must already exist and have permission to connect; Azure login alone does not grant database access.

```bash
# Choose entra instead of password for the relevant side; the other side can stay password.
# export RECOVERY_SOURCE_DB_AUTH=entra
# export RECOVERY_TARGET_DB_AUTH=entra

# Tenant selection: side-specific value > shared RECOVERY_DB_TENANT_ID > AZURE_TENANT_ID.
# Per-service tenant overrides in database-refresh.js take precedence over these.
# Set only the values needed for your chosen authentication flow.
# export RECOVERY_SOURCE_DB_TENANT_ID='<EXAMPLE_SOURCE_TENANT_ID>'
# export RECOVERY_TARGET_DB_TENANT_ID='<EXAMPLE_TARGET_TENANT_ID>'
# export RECOVERY_DB_TENANT_ID='<EXAMPLE_SHARED_DATABASE_TENANT_ID>'
# export AZURE_TENANT_ID='<EXAMPLE_AZURE_TENANT_ID>'

# Optional unattended service principal: use AZURE_TENANT_ID plus client ID and secret.
# These identify an Azure application; they are not PostgreSQL usernames/passwords.
# export AZURE_CLIENT_ID='<EXAMPLE_CLIENT_ID>'
# export AZURE_CLIENT_SECRET='<EXAMPLE_CLIENT_SECRET>'

# Optional certificate credential instead of AZURE_CLIENT_SECRET; use a PEM certificate/key.
# export AZURE_CLIENT_CERTIFICATE_PATH='/EXAMPLE/PRIVATE/PATH/client-certificate.pem'
# export AZURE_CLIENT_CERTIFICATE_PASSWORD='<EXAMPLE_CERTIFICATE_PASSWORD>'
# export AZURE_CLIENT_SEND_CERTIFICATE_CHAIN=true    # Only for a certificate flow that requires it.

# Optional workload identity: AZURE_TENANT_ID and AZURE_CLIENT_ID plus an injected token file.
# export AZURE_FEDERATED_TOKEN_FILE='/EXAMPLE/PRIVATE/PATH/federated-token'
# Optional sovereign-cloud authority; use the documented authority for your cloud.
# export AZURE_AUTHORITY_HOST='https://authority.example.invalid'
```

The tool uses `DefaultAzureCredential`. For interactive local use, sign in with Azure CLI after configuring an actual tenant:

```bash
source ~/.bashrc
az login --tenant "$RECOVERY_SOURCE_DB_TENANT_ID"
```

That example assumes `RECOVERY_SOURCE_DB_TENANT_ID` was chosen. Use your selected shared/target tenant variable instead when appropriate. For an Azure-hosted managed identity, ambient identity can be used; `AZURE_CLIENT_ID` selects a user-assigned managed identity when needed. Do not leave unused service-principal secret/certificate settings exported when using another flow.

Tokens are obtained automatically for PostgreSQL connections and `pg_dump`/`pg_restore`. Do not manually export access tokens. An Azure Data Studio session is not reused.

### TLS And Per-Service Overrides

The source and hosted target each accept `RECOVERY_SOURCE_DB_SSL_MODE` or `RECOVERY_TARGET_DB_SSL_MODE`:

| Value | Meaning |
| --- | --- |
| `require` | Default TLS mode. |
| `verify-ca` | Certificate-verification mode for PostgreSQL tools; requires a trusted certificate chain. |
| `verify-full` | Strict PostgreSQL-tool certificate and hostname verification. |
| `no-verify` | Accept an unverified certificate; use only for an explicitly approved diagnostic/development case. |

The Node client also uses these settings to select certificate-verifying or unverified TLS. Setting the side's `*_DB_SSL=false` disables TLS regardless of its mode; do not disable TLS merely to work around DNS or login errors. There is no tool-specific CA-file setting; use the platform trust setup when needed.

For a service-specific auth exception, edit `DATABASE_AUTH_OVERRIDES` in [app/config/database-refresh.js](app/config/database-refresh.js):

```js
const DATABASE_AUTH_OVERRIDES = {
	'ffc-doc-statement-data': {
		source: { mode: 'password' },
		target: { mode: 'entra', tenantId: '<EXAMPLE_TARGET_TENANT_ID>' }
	}
}
```

Authentication precedence is per-service override, then the side's exported `*_DB_AUTH`, then the file default. Local set targets always use password auth. Passwords still come from the side's password variable; they are not stored per service in this file.

### Single-Database Settings Only

These are advanced alternatives for `database:backup` / `database:restore`. **Do not export them for set commands**: set commands resolve the service/name/mode themselves, and the standalone Faker runner uses the set-style target configuration.

```bash
# Single backup: exact database name; avoids suffix generation.
# export RECOVERY_SOURCE_DATABASE='ffc-doc-statement-data-prd'
# Optional service identity: required to select the right Faker mapping on restore.
# export RECOVERY_SERVICE_NAME='ffc-doc-statement-data'
# Alternative to an exact source name: service name + source suffix (both required).
# export RECOVERY_SOURCE_ENV=prd

# Single restore: explicit destination, or service name + RECOVERY_TARGET_ENV.
# export RECOVERY_TARGET_DATABASE='ffc_doc_statement_data'
# export RECOVERY_TARGET_MODE=local                  # local or hosted; default: hosted unless target env is local.
# export RECOVERY_TARGET_ENV=local                   # local, or hosted naming suffix such as test.
# Optional local fallback ONLY when no service-derived/explicit target name is available.
# export LOCAL_DB_NAME=ffc_pay_local_recovery         # Default fallback name.
```

`DATABASE_REFRESH_*` controls set workflows and the standalone Faker runner. `RECOVERY_SOURCE_ENV` / `RECOVERY_TARGET_ENV` controls suffix generation for the single-database commands. `RECOVERY_TARGET_DATABASE` overrides an inferred target name. A single restore can use the service identity stored in its archive instead of exporting `RECOVERY_SERVICE_NAME`.

## Prepare Local Targets

Load the chosen settings and start every PostgreSQL server referenced by `LOCAL_DATABASE_TARGETS`:

```bash
source ~/.bashrc
docker compose up -d --wait
```

The Compose file starts **only the bundled PostgreSQL 16 server on port 5467**. It does not start the service-specific containers on ports such as 5482/5486. Either start those service databases, or explicitly point their local mappings at the bundled server. Do not remove per-service mappings unintentionally: they override the fallback port.

Check the bundled server using its local defaults:

```bash
PGPASSWORD=ppp psql -h localhost -p 5467 -U postgres -d postgres \
	-c 'SELECT current_database(), version();'
```

A volume created by an older PostgreSQL major cannot be reused directly. Do not run `docker compose down -v` as routine setup: it permanently deletes the bundled database volume. Plan a backup or deliberate reset separately.

## Stream Source To Target

This is the shortest path when you do not need a saved dump. Set the source host/auth/suffix and target settings above first. For example, a test source normally uses `DATABASE_REFRESH_SOURCE_ENV=test`; a restored `-prd` database hosted in PRE still uses `prd`.

1. Start with one mapped document database. Dry-run checks connectivity and compatibility without creating staging databases or changing data:

```bash
npm run database:stream-set -- \
	--database ffc-doc-statement-data --dry-run --anonymise
```

2. Review the printed source and target endpoints. Run with the exact confirmation token:

```bash
npm run database:stream-set -- \
	--database ffc-doc-statement-data \
	--wipe --confirm-target-set '<EXAMPLE_TOKEN_FROM_DRY_RUN>' --anonymise
```

3. Check the completion message and masking counts described below, then reconnect/start target applications.

Use the **same database selection, order, target settings and masking option** for dry-run and live execution. A fresh dry-run is required after changes that affect the confirmation token.

To copy the entire configured payment/PDS/document set, omit `--database` from both commands:

```bash
npm run database:stream-set -- --dry-run --anonymise
npm run database:stream-set -- \
	--wipe --confirm-target-set '<EXAMPLE_TOKEN_FROM_DRY_RUN>' --anonymise
```

In that mixed set, only registered document mappings are masked; everything else is copied unchanged. Omit `--anonymise` from both commands to copy all data as-is. Repeat `--database` to select several services. Streaming creates no durable data dump; temporary schema-verification files and target staging databases are still used. All target maintenance connections are checked before transfers begin.

## Back Up And Restore

1. Configure the source and selected database list, then save an archive set:

```bash
npm run database:backup-set
```

The tool prints the manifest path. The default is a timestamped directory under `dumps/`, containing a custom-format `.dump` and `.dump.json` sidecar per database plus `database-refresh-set.json`. Keep the entire directory together. It is private where filesystem permissions allow and ignored by Git. Backups are **never masked**. An incomplete backup set is removed on failure.

Optional example: select services and choose the parent output directory:

```bash
npm run database:backup-set -- --output-dir dumps \
	--database ffc-pay-processing --database fcp-pds-data-retention \
	--database ffc-doc-statement-data --database ffc-doc-statement-constructor
```

2. Configure/start the target. Use the actual manifest path printed by backup:

```bash
MANIFEST='dumps/<EXAMPLE_BACKUP_SET>/database-refresh-set.json'
npm run database:restore-set -- --manifest "$MANIFEST" --dry-run --anonymise
```

3. Review every endpoint, then restore and mask with that dry-run's token:

```bash
npm run database:restore-set -- --manifest "$MANIFEST" \
	--wipe --confirm-target-set '<EXAMPLE_TOKEN_FROM_DRY_RUN>' --anonymise
```

The manifest selects the databases; `--database` is not accepted on `database:restore-set`. Its base names must still be in `DATABASE_NAMES`. Omit `--anonymise` from both restore commands to retain source values. Source access is not needed for archive restore. The same commands work for hosted targets after setting `DATABASE_REFRESH_TARGET_ENV` and `RECOVERY_TARGET_DB_*`; do not change the source suffix just because the target changes.

## What Happens Before Cutover

1. Each database is restored into a separate database on its target server, not a temporary table. Names contain `_stream_` or `_restore_`.
2. The tool checks schema fingerprint, relation inventory, exact row counts, extensions, encoding and locale against its source snapshot/archive metadata.
3. With `--anonymise`, registered fields are updated in staging, protected data is checked, and restore validation runs again. Target application-role grants are then applied if configured.
4. Only when every database is ready does cutover begin. Existing target connections are blocked/disconnected; the old target is renamed to `<target>_previous_<token>` and kept offline.
5. Staging is renamed to the target's normal name. There is no second data transfer. Applications can reconnect to the same database name.

Failure during staging leaves existing targets unchanged and cleanup attempts to remove incomplete staging databases. Cutovers are sequential, **not atomic across the set**; a later cutover failure triggers attempts to roll back completed cutovers. A snapshot is consistent per database, not across the whole service set.

Previous targets are retained and consume storage. There is no CLI for post-success manual rollback or deletion of previous databases. Verify the refresh and plan approved retention/cleanup separately.

## Faker: Configured Document Services Only

Faker replaces customer details with a deterministic fictional profile; it does not create records or discover sensitive fields automatically. **Current coverage is exactly:**

| Base service | Table |
| --- | --- |
| `ffc-doc-statement-data` | `public.organisations` |
| `ffc-doc-statement-constructor` | `public.organisations` |

Mapped columns are `name`, `addressLine1`, `addressLine2`, `addressLine3`, `city`, `county`, `postcode` and `emailAddress`. Null, empty and whitespace-only fields remain unchanged. FRN/SBI, other keys, timestamps, payment values, phone numbers and all unlisted columns are preserved. Other document services, including generator/publisher, are **not** masked. Neither `ffc-pay` nor `fcp-pds` has a registered Faker mapping currently.

`--anonymise` must be supplied for both dry-run and live commands. In a mixed set, unconfigured databases are reported as unchanged. If no selected service has a mapping, the operation fails before transfer. A single-database masked restore also requires a registered mapping. The presence of `--anonymise` alone does not make an entire set anonymous.

### How Profiles Stay Consistent

[app/faker/organisation-profile.js](app/faker/organisation-profile.js) generates the complete profile using Faker `9.8.0`, British locale and an FRN-first seed, falling back to SBI. The same chosen identifier gives the same values regardless of row order or table-specific field selection. Emails use `example.com`. Missing identifiers are rejected rather than giving every customer one default profile.

A row seeded from FRN does not automatically match another row that only has its SBI: there is no cross-database FRN/SBI reconciliation. Keep identifier selection consistent across mappings. Changing generation behaviour requires a `PROFILE_VERSION` change; generated values need not match the retired transformer's output.

FRN/SBI remain identifying references, so this is **pseudonymisation**, not complete anonymisation. Raw data reaches staging first; archives and retained previous databases remain sensitive. If policy forbids raw data reaching a lower environment at all, use a trusted intermediate host to mask before exporting a clean archive.

### Confirm Masking Ran

Look for this message for each masked database:

```text
Staging anonymisation and post-mask validation passed (organisation-v1).
```

The final JSON contains `anonymisation.tables`: `processedRows` is rows examined and `updatedRows` is rows with at least one changed mapped field. Zero updates can be valid for already-masked or empty-valued data. Unmapped databases have `status: "not-configured"`; an ordinary refresh completion message alone does not confirm masking.

Automatic checks verify update counts, protected-column fingerprints, row counts and schema, not whether all sensitive fields were configured. For a first real dataset, compare a few source/target rows by FRN/SBI: populated mapped details should be replaced, while identifiers, timestamps and unlisted values remain unchanged. No customer values are printed by the masking summaries.

### Mask An Existing Offline Target

This is a target-only alternative, with no source connection, dump or cutover. Stop applications and disconnect all other clients first. The runner uses `DATABASE_REFRESH_TARGET_ENV`, `LOCAL_DATABASE_TARGETS` and the normal target credentials; membership in `DATABASE_NAMES` is not required, but a Faker mapping is.

```bash
npm run database:anonymise -- --database ffc-doc-statement-data --dry-run
npm run database:anonymise -- --database ffc-doc-statement-data \
	--confirm-target '<EXAMPLE_CONFIRMATION_FROM_DRY_RUN>'
```

Dry-run reads schema and counts only. Live execution updates the existing target directly in one transaction. Keep it offline throughout; the runner checks for other client connections but does not stop applications for you. Masking rejects production targets and permits only explicitly named `local`, `dev`, `test`, `pre` or `recovery` target environments. Production-looking destination database names are also rejected.

### Add A Future Payment Mapping

Payment/PDS masking is **not enabled by adding a service to `DATABASE_NAMES`**. A correct table/field mapping must be created and registered first:

1. Identify the actual table, stable primary key, FRN/SBI columns and sensitive text fields. Do not map identifiers, relationships or timestamps.
2. Populate the currently empty [app/faker/map-payment-org-faker.js](app/faker/map-payment-org-faker.js). Left-hand names are actual database columns; right-hand names are shared profile fields. This is a fictitious schema example, not a ready-made payment mapping:

```js
const FIELD_MAP = Object.freeze({
	organisationName: 'name',
	address1: 'addressLine1',
	town: 'city',
	postcode: 'postcode',
	email: 'emailAddress'
})
```

3. Register the mapper alongside the existing document entries in [app/config/database-anonymisation.js](app/config/database-anonymisation.js). Replace all example service/table/column names with verified ones:

```js
const paymentMapper = require('../faker/map-payment-org-faker')

module.exports['ffc-pay-example-service'] = [{
	schema: 'public',
	table: 'example_customer_organisations',
	identifiers: { frn: 'example_frn', sbi: 'example_sbi' },
	fieldMap: paymentMapper.FIELD_MAP,
	transform: paymentMapper.anonymizeOrganisation
}]
```

4. Test determinism, cross-service consistency and preservation of unlisted data on synthetic/local data. Run a dry-run and small live test before using the new mapping on a full set. If service schemas differ, create separate mapper modules rather than applying one guessed field map everywhere.

Empty mappings are rejected. This first version supports explicitly mapped text columns on regular tables with primary keys. It rejects missing columns/seeds, key-column changes, row-level security, partitioned/inherited tables, enabled user triggers and UPDATE rules. It does not disable constraints or hooks, and does not inspect/rewrite JSON automatically. Batches default to 500 inside one transaction; there is no batch-size CLI/env option. Mapping and execution remain separate in [app/faker/map-document-org-faker.js](app/faker/map-document-org-faker.js) and [app/services/database-anonymisation-service.js](app/services/database-anonymisation-service.js).

## Single-Database Archive Example

Use the single-database environment settings above, separately from set commands. For a document database, `RECOVERY_SERVICE_NAME=ffc-doc-statement-data` identifies its mapping; the exact source name may be `ffc-doc-statement-data-prd` even on a PRE-hosted restore.

```bash
npm run database:backup -- --output dumps/example-document.dump
npm run database:restore -- --archive dumps/example-document.dump --dry-run --anonymise
npm run database:restore -- --archive dumps/example-document.dump \
	--wipe --confirm-target '<EXAMPLE_CONFIRMATION_FROM_DRY_RUN>' --anonymise
```

Use the complete printed confirmation, including the `#anonymise=...` suffix for masked runs. Omit `--anonymise` from both restore commands to copy as-is. These commands do not use the set manifest and do not require membership in `DATABASE_NAMES`.

## Command Options

Use `npm run <script> -- <options>`. `--help` or `-h` prints help for every runner. Backup operations have no dry-run or masking mode.

| Script | Accepted options |
| --- | --- |
| `database:backup-set` | `--output-dir <directory>` (default: `dumps/` parent), repeatable `--database <base-name>` (default: all configured). |
| `database:restore-set` | Required `--manifest <file>`; `--dry-run`, or live `--wipe --confirm-target-set <token>`; optional `--anonymise`. Uses the manifest list, not `--database`. |
| `database:stream-set` | Repeatable `--database <base-name>` (default: all configured); `--dry-run`, or live `--wipe --confirm-target-set <token>`; optional `--anonymise`. No archive/manifest/output directory. |
| `database:backup` | `--output <file>` (default: timestamped `.dump` under `dumps/`). |
| `database:restore` | Required `--archive <file>`; `--dry-run`, or live `--wipe --confirm-target <confirmation>`; optional `--anonymise`. |
| `database:anonymise` | Required single `--database <base-name>`; `--dry-run`, or live `--confirm-target <confirmation>`. No `--wipe`: this updates rows rather than replacing a database. |

For set commands and the standalone masking runner, do not combine dry-run with live confirmation flags. Always run a fresh preflight before a live restore. Set tokens bind the target/database selection and, for archive restore, archive checksums; masking changes also affect confirmation. Unknown options are rejected.

## Safety And Troubleshooting

- The source is read-only and backups use a repeatable-read snapshot. Raw archives, staging and retained previous targets remain sensitive even when the new target has been masked. Follow your data-handling policy.
- Archive restore verifies archive checksums and table of contents. Both workflows verify schema, inventory, exact counts, extension availability, encoding and locale. A stale database collation version is rejected; different source/target collation-library versions are warned about because indexes are rebuilt on the target.
- Extension-version differences warn by default; `RECOVERY_REQUIRE_EXACT_EXTENSION_VERSIONS=true` rejects them. Foreign tables are rejected because their external data is not included. Cluster roles/memberships, source ownership/ACLs and tablespace placement are not copied. Restored objects belong to the target user; configure existing application roles explicitly if needed.
- `getaddrinfo ENOTFOUND` is DNS resolution, before database authentication. From the same terminal, run `getent ahostsv4 "$RECOVERY_SOURCE_DB_HOST"`. Verify the hostname, VPN/private DNS and any WSL DNS forwarding. A public alias can resolve while its private IP lookup fails. Changing suffix, password or TLS mode does not fix DNS.
- A wrong database suffix selects the wrong database, not the wrong host. Check the printed `host`, `port` and `database`, and remember exported values override file defaults. Reload `~/.bashrc`; unset obsolete exports or open a fresh terminal when switching workflows.
- Connection refused/timeouts on local ports usually require starting the corresponding service database or correcting its port mapping. The bundled Compose server does not satisfy every per-service port. Match PostgreSQL majors before restoring.
- Missing Faker columns, keys, seeds or unsafe hooks fail staging, not silently skip masking. Fix/review the mapping or table behaviour; do not bypass protections merely to complete the copy.
- This utility replaces the old tool's database-copy/document-masking workflow, not all its features. Dummy-data generation, interactive test-to-dev uploads, checkpoint/resume, continue-on-error, table-by-table controls, saved metadata and automatic managed-identity discovery were not migrated.

## Tests

Unit tests do not need configured databases:

```bash
npm test
npm run lint
```

For just the seeded mappers and masking service:

```bash
node --test test/faker.test.js test/database-anonymisation.test.js
```

An optional end-to-end test creates/removes its own Docker container with 502 synthetic organisations and checks archive/stream masking, repeatability, preserved data and trigger rejection. It does not use configured source/target credentials:

```bash
RECOVERY_TEST_POSTGRES_IMAGE=postgres:16 node --test test/database-anonymisation-postgres.test.js
```

The image must already exist locally (`--pull=never`), Docker must be accessible, and client tools must match the image's PostgreSQL major. Without `RECOVERY_TEST_POSTGRES_IMAGE`, `npm test` skips this Docker test.