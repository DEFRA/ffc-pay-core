#!/bin/bash

# Execute the ffc-pay-statement-data sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5452 -U postgres -d ffc_pay_statement_data -f $(pwd)/sql_start_scripts/ffc-pay-statement-data.sql 

# Check the exit status of the ffc-pay-statement-data sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-data sql script executed successfully."
else
    echo "Error: ffc-pay-statement-data sql script failed."
    exit 1
fi

# Execute the ffc-pay-submission sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5438 -U postgres -d ffc_pay_submission -f $(pwd)/sql_start_scripts/ffc-pay-submission.sql 

# Check the exit status of ffc-pay-submission sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-submission sql script executed successfully."
else
    echo "Error: ffc-pay-submission sql script failed."
    exit 1
fi

# Execute the ffc-pay-statement-generator sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5451 -U postgres -d ffc_pay_statement_generator -f $(pwd)/sql_start_scripts/ffc-pay-statement-generator.sql 

# Check the exit status of ffc-pay-statement-generator sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-generator sql script executed successfully."
else
    echo "Error: ffc-pay-statement-generator sql script failed."
    exit 1
fi

# Execute the ffc-pay-statement-constructor sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5450 -U postgres -d ffc_pay_statement_constructor -f $(pwd)/sql_start_scripts/ffc-pay-statement-constructor.sql 

# Check the exit status of ffc-pay-statement-constructor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-constructor sql script executed successfully."
else
    echo "Error: ffc-pay-statement-constructor sql script failed."
    exit 1
fi

# Execute the ffc-pay-request-editor sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5433 -U postgres -d ffc_pay_request_editor -f $(pwd)/sql_start_scripts/ffc-pay-request-editor.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-request-editor sql script executed successfully."
else
    echo "Error: ffc-pay-request-editor sql script failed."
    exit 1
fi

# Execute the ffc-pay-processing sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5434 -U postgres -d ffc_pay_processing -f $(pwd)/sql_start_scripts/ffc-pay-processing.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-processing sql script executed successfully."
else
    echo "Error: ffc-pay-processing sql script failed."
    exit 1
fi

# Execute the ffc-pay-batch-processor sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5436 -U postgres -d ffc_pay_batch_processor -f $(pwd)/sql_start_scripts/ffc-pay-batch-processor.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-batch-processor sql script executed successfully."
else
    echo "Error: ffc-pay-batch-processor sql script failed."
    exit 1
fi



