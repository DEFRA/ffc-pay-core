#!/bin/bash

# Execute the ffc-pay-statement-data sql script
PGPASSWORD=ppp psql -h localhost -p 5482 -U postgres -d ffc_doc_statement_data -f $(pwd)/data/SFI23-ffc-pay-statement-data.sql 

# Check the exit status of the ffc-pay-statement-data sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-data sql script executed successfully."
else
    echo "Error: ffc-pay-statement-data sql script failed."
    exit 1
fi

# Execute the ffc-pay-statement-data sql script
PGPASSWORD=ppp psql -h localhost -p 5486 -U postgres -d ffc_doc_statement_constructor -f $(pwd)/data/SFI23-ffc-pay-statement-constructor.sql

# Check the exit status of the ffc-pay-statement-data sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-constructor sql script executed successfully."
else
    echo "Error: ffc-pay-statement-constructor sql script failed."
    exit 1
fi