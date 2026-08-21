# ffc-pay-data-recovery

A small local toolkit that helps developers and testers safely pull payment-request data from the **hosted read-only recovery database** into a **local PostgreSQL database** so it can be inspected, verified, and packaged into dumps for further investigation.

> **What problem does this solve?**  
> Sometimes a payment run needs to be re-investigated. The recovery database holds the historical truth, but it is read-only and shared. This tool copies only the payment request IDs you care about onto your own machine, where you can query freely and generate staging dumps without affecting anyone else.

---

## What the tool does

The recovery workflow is made up of four small steps:

1. **Prepare a CSV** of payment request IDs you want to investigate.
2. **Create a local recovery database** from scratch (Docker PostgreSQL).
3. **Flag** which IDs exist in the hosted recovery tables.
4. **Pull** the matching rows into your local database.
5. **Create a staging dump** that can be restored elsewhere for analysis.

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

### 2. Create the local recovery database

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

### 4. Pull the matched rows into your local database

```bash
npm run recovery:pull
```

This copies the rows that were flagged in step 3 from the hosted database into your local database. It also pulls dependent rows for `completedInvoiceLines` and `outbox` automatically.

If you only want to pull one table, you can run:

```bash
node app/tools/pull-recovery-data.js --table invoiceLines
```

Allowed tables: `invoiceLines`, `completedPaymentRequests`, `schedule`.

To see what would be copied without actually copying, add `--dry-run`:

```bash
node app/tools/pull-recovery-data.js --dry-run
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

These files are ignored by Git because they can be very large.

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

> **Warning:** the `-v` flag deletes the local database permanently. You can recreate it by running `npm run recovery:create-local-db` again.

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
│   ├── schemas/                           # SQL that creates local tables
│   │   ├── completedPaymentRequests.sql
│   │   ├── invoiceLines.sql
│   │   ├── manualVerificationQueue.sql
│   │   ├── paymentRequestIds.sql
│   │   └── schedule.sql
│   ├── tools/
│   │   ├── create-staging-dump.sh         # creates dump files from local DB
│   │   ├── flag-csv-matches-for-verification.js
│   │   ├── pull-dependent-recovery-data.js
│   │   ├── pull-recovery-data.js
│   │   └── test-recovery-connection.js
│   └── util/
│       └── parse-csv-ids.js               # reads payment request IDs from CSV
```

---

## Troubleshooting

### `Missing recovery database environment variables`

You have not set the `RECOVERY_DB_*` environment variables. Create a `.env` file or export them in your terminal before running the scripts.

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
