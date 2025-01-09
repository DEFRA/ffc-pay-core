#!/bin/bash

# Common variables
DB_USER="your_db_user"
DB_PASSWORD="your_db_password"
DB_HOST="your_db_host"

# Function to create a database
create_database() {
    local db_name=$1
    local db_port=$2

    export PGPASSWORD=$DB_PASSWORD
    psql -h $DB_HOST -U $DB_USER -p $db_port -c "CREATE DATABASE $db_name;"
    
    # Check the exit status
    if [ $? -eq 0 ]; then
        echo "Database $db_name created successfully."
    else
        echo "Error: Failed to create database $db_name."
        exit 1
    fi

    # Unset the password variable
    unset PGPASSWORD
}

# Create databases
create_database "ffc_doc_statement_data" "5486"
create_database "ffc_doc_statement_constructor" "5486"
create_database "ffc_doc_statement_generator" "5488"
create_database "ffc_foc_statement_publisher" "5487"

# # Execute SQL scripts for each database
# execute_sql_script "ffc_pay_submission" "5438" "ffc-pay-submission.sql"
# execute_sql_script "ffc_doc_statement_generator" "5488" "ffc-pay-statement-generator.sql"
# execute_sql_script "ffc_doc_statement_constructor" "5486" "ffc-pay-statement-constructor.sql"
# execute_sql_script "ffc_pay_request_editor" "5433" "ffc-pay-request-editor.sql"
# execute_sql_script "ffc_pay_processing" "5434" "ffc-pay-processing.sql"
# execute_sql_script "ffc_pay_batch_processor" "5436" "ffc-pay-batch-processor.sql"

# Open pgAdmin if installed
if command -v pgadmin4 > /dev/null; then
    pgadmin4 &
    echo "pgAdmin opened."
else
    echo "pgAdmin is not installed."
fi