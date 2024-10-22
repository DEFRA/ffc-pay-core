#!/bin/bash

# Execute the ffc-pay-submission sql script
PGPASSWORD=ppp psql -h localhost -p 5438 -U postgres -d ffc_pay_submission -f $(pwd)/databases-reset/ffc-pay-submission.sql 

# Check the exit status of ffc-pay-submission sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-submission sql script executed successfully."
else
    echo "Error: ffc-pay-submission sql script failed."
    exit 1
fi

# Execute the ffc-pay-statement-generator sql script
PGPASSWORD=ppp psql -h localhost -p 5488 -U postgres -d ffc_doc_statement_generator -f $(pwd)/databases-reset/ffc-pay-statement-generator.sql 

# Check the exit status of ffc-pay-statement-generator sql script
if [ $? -eq 0 ]; then
    echo "ffc-doc-statement-generator sql script executed successfully."
else
    echo "Error: ffc-doc-statement-generator sql script failed."
    exit 1
fi

# Execute the ffc-pay-statement-constructor sql script
PGPASSWORD=ppp psql -h localhost -p 5486 -U postgres -d ffc_doc_statement_constructor -f $(pwd)/databases-reset/ffc-pay-statement-constructor.sql 

# Check the exit status of ffc-pay-statement-constructor sql script
if [ $? -eq 0 ]; then
    echo "ffc-doc-statement-constructor sql script executed successfully."
else
    echo "Error: ffc-doc-statement-constructor sql script failed."
    exit 1
fi

# Execute the ffc-pay-request-editor sql script
PGPASSWORD=ppp psql -h localhost -p 5433 -U postgres -d ffc_pay_request_editor -f $(pwd)/databases-reset/ffc-pay-request-editor.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-request-editor sql script executed successfully."
else
    echo "Error: ffc-pay-request-editor sql script failed."
    exit 1
fi

# Execute the ffc-pay-processing sql script
PGPASSWORD=ppp psql -h localhost -p 5434 -U postgres -d ffc_pay_processing -f $(pwd)/databases-reset/ffc-pay-processing.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-processing sql script executed successfully."
else
    echo "Error: ffc-pay-processing sql script failed."
    exit 1
fi

# Execute the ffc-pay-batch-processor sql script
PGPASSWORD=ppp psql -h localhost -p 5436 -U postgres -d ffc_pay_batch_processor -f $(pwd)/databases-reset/ffc-pay-batch-processor.sql 

# Check the exit status of ffc-pay-request-editor sql script
if [ $? -eq 0 ]; then
    echo "ffc-pay-batch-processor sql script executed successfully."
else
    echo "Error: ffc-pay-batch-processor sql script failed."
    exit 1
fi



