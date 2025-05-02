# Delinked Performance Test Tools

This package contains two different approaches for generating test data for performance testing:

1. Direct database insertion using Sequelize ORM
2. SQL file generation for manual execution

## Prerequisites

- Node.js installed
- PostgreSQL database
- Access to the target database (default config: localhost:5482)

## Installation

````sh
npm install

# Usage
1. Direct Database Insertion (create-dummy-records.js)

This script uses Sequelize to directly insert records into the database.

node create-dummy-records.js [number_of_records]
Options
number_of_records: Optional. Number of records to generate (default: 250,000)

2. SQL File Generator (create-dummy-file.js)

This script generates SQL insert statements in files rather than executing them directly.

node create-dummy-file.js [number_of_records] [separate_files]

Options
number_of_records: Optional. Number of records to generate (default: 250,000)
separate_files: Optional boolean. If "true", creates separate files for each table (default: false)
Output Files
When separate_files is false:

combined_inserts.sql: Contains all INSERT statements


When separate_files is true:

organisations.sql: Organisation INSERT statements
delinkedCalculations.sql: Delinked calculation INSERT statements
d365.sql: D365 INSERT statements

## Generated Data Structure
Both scripts generate consistent test data with this structure:

Organisations: SBI numbers starting at 123000000
FRNs starting at 1234000000
Calculation IDs starting at 987000000
Payment references in format "PY0000001"
Standard payment amounts and band values
Current timestamps for dates

## Example Usage - enter this into your command line from the directory containing the scripts, in this case it is within the /app dir.

**Generate 100,000 records directly to database:**
```bash
node create-dummy-records.js 100000

**Generate SQL file with 50,000 records:**
```bash
node create-dummy-file.js 50000

**Generate separate SQL files with 10,000 records:**
```bash
node create-dummy-file.js 10000 true

# Performance Considerations

The direct database insertion uses batches of 10,000 records
The SQL file generator also uses 10,000 record batches for memory efficiency
For very large datasets, the SQL file approach may be preferable as it allows manual execution control

## Error Handling

Both scripts include error handling and progress logging. Check the console output for:

Progress updates per batch
Error messages with details
Completion confirmation and timing information
````
