#!/bin/bash

# Execute the ffc-pay-statement-data sql scrip
PGPASSWORD=ppp psql -h host.docker.internal -p 5452 -U postgres -d ffc_pay_statement_data -f $(pwd)/data/SFI22-ffc-pay-statement-data.sql 

# Check the exit status of the ffc-pay-statement-data sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-statement-data sql script executed successfully."
else
    echo "Error: ffc-pay-statement-data sql script failed."
    exit 1
fi



