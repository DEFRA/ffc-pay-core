#!/bin/bash

# Define default column mappings
declare -A default_column_mapping=(
    ["CALCULATIONID"]="calculationId"
    ["PAYMENTPERIOD"]="paymentPeriod"
    ["PAYMENTREFERENCE"]="paymentReference"
    ["PAIDAMOUNT"]="paymentAmount"
    ["TRANSDATE"]="transactionDate"
)

# Define SFI23 specific mappings
declare -A sfi23_column_mapping=(
    ["CALCULATIONID"]="sfiCalculationId"
    ["PAYMENTPERIOD"]="sfiPaymentPeriod"
    ["PAYMENTREFERENCE"]="sfiPaymentReference"
    ["PAIDAMOUNT"]="sfiPaymentAmount"
    ["TRANSDATE"]="sfiTransactionDate"
)

# Define delinked specific mappings
declare -A delinked_column_mapping=(
    ["CALCULATIONID"]="delinkedCalculationId"
    ["PAYMENTPERIOD"]="delinkedPaymentPeriod"
    ["PAYMENTREFERENCE"]="delinkedPaymentReference"
    ["TRANSDATE"]="delinkedTransactionDate"
    ["PAIDAMOUNT"]="delinkedPaymentAmount"
)

# Check if an argument is passed for mapping selection
if [ $# -eq 0 ]; then
    echo "No mapping type specified. Defaulting to 'Default'."
    column_mapping=("${default_column_mapping[@]}")
else
    case $1 in
        Default ) column_mapping=("${default_column_mapping[@]}");;
        SFI23 ) column_mapping=("${sfi23_column_mapping[@]}");;
        Delinked ) column_mapping=("${delinked_column_mapping[@]}");;
        * ) echo "Invalid mapping type specified. Defaulting to 'Default'."
            column_mapping=("${default_column_mapping[@]}");;
    esac
fi

# Function to convert Oracle SQL data to PostgreSQL format using selected mapping
function convert_data() {
    local file_path=$1
    # Extract the first insert statement to get column names
    local column_line=$(grep "Insert into EXPORT_TABLE" "$file_path" | head -1 | awk -F"(" '{print $2}' | awk -F")" '{print $1}')
    
    # Manually specify the order of columns
    local ordered_columns=("CALCULATIONID" "PAYMENTPERIOD" "PAYMENTREFERENCE" "PAIDAMOUNT" "TRANSDATE")
    
    # Transform column names based on mapping and specified order
    local transformed_columns=""
    for col in "${ordered_columns[@]}"; do
        if [[ $column_line == *"$col"* ]]; then
            transformed_columns+="${column_mapping[$col]}, "
        fi
    done
    transformed_columns=${transformed_columns%, }
    
    # Extract and convert data
    local converted_data=$(grep "Insert into EXPORT_TABLE" "$file_path" | awk -F"values" '{print $2}' | sed "s/),(/)\n(/g" | sed "s/),/)\n/g" | sed "s/),/)\n/g" | sed "s/;/,/g" | sed '$s/;//')
    echo "$transformed_columns|$converted_data"
}

# Get the list of files in the current directory
files=$(ls data-files)

# Prompt the user to choose a file from the list
echo "Choose a file from the list:"
IFS=$'\n' # Set the input field separator to newline
select file_name in $files; do
    if [ -n "$file_name" ]; then
        # Convert the data
        converted_data=$(convert_data "data-files/$file_name")

        # Create a new .txt file with the specified name format
        output_file="$(pwd)/outputs/ffc-doc-statment-DAX-data-converted-$(date +%Y%m%d).txt"

        # Add the INSERT statement at the top of the file
        echo "INSERT INTO \"dax\" (\"calculationId\", \"paymentPeriod\", \"paymentReference\", \"paymentAmount\", \"transactionDate\")" > "$output_file"
        echo "VALUES" >> "$output_file"

        # Append the converted data to the file
        echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//' >> "$output_file"

        # Add the ON CONFLICT statement at the end of the file
        echo "ON CONFLICT (\"paymentReference\")" >> "$output_file"
        echo "DO" >> "$output_file"
        echo "UPDATE SET" >> "$output_file"
        echo "  \"calculationId\" = EXCLUDED.\"calculationId\"," >> "$output_file"
        echo "  \"paymentPeriod\" = EXCLUDED.\"paymentPeriod\"," >> "$output_file"
        echo "  \"paymentReference\" = EXCLUDED.\"paymentReference\"," >> "$output_file"
        echo "  \"paymentAmount\" = EXCLUDED.\"paymentAmount\"," >> "$output_file"
        echo "  \"transactionDate\" = EXCLUDED.\"transactionDate\";" >> "$output_file"

        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done