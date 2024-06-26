#!/bin/bash

# Define column mappings for sfi-23 and delinked configurations
declare -A sfi23_columns=(
    ["CALCULATIONID"]="calculationId"
    ["PAYMENTPERIOD"]="paymentPeriod"
    ["PAYMENTREFERENCE"]="paymentReference"
    ["PAIDAMOUNT"]="paymentAmount"
    ["TRANSDATE"]="transactionDate"
)

# Updated column mappings to include all necessary columns and match the PostgreSQL 'dax' table structure
declare -A delinked_columns=(
    ["PAYMENTREFERENCE"]="paymentReference"
    ["CALCULATIONID"]="calculationId"
    ["PAYMENTPERIOD"]="paymentPeriod"
    ["PAIDAMOUNT"]="paymentAmount"
    ["TRANSDATE"]="transactionDate"
)

# Function to convert Oracle SQL data to PostgreSQL format
function convert_data() {
    local file_path=$1
    # Adjusted to correctly format the VALUES clause, ensuring correct handling of numeric and date values
    local converted_data=$(grep "Insert into EXPORT_TABLE" "$file_path" | awk -F"values" '{print $2}' | sed "s/),(/),\n(/g" | sed "s/;/,/g" | sed '$s/,$//')
    echo "$converted_data"
}

# Function to generate INSERT and ON CONFLICT statements based on column mapping
function generate_statements() {
    local insert_columns_str=""
    local conflict_columns_str=""
    local first=true
    for column in "${!column_mapping[@]}"; do
        if [ "$first" = true ]; then
            first=false
        else
            insert_columns_str+=", "
            conflict_columns_str+=", "
        fi
        insert_columns_str+="\"${column_mapping[$column]}\""
        conflict_columns_str+="\"${column_mapping[$column]}\" = EXCLUDED.\"${column_mapping[$column]}\""
    done
    local insert_statement="INSERT INTO \"dax\" (${insert_columns_str})"
    local conflict_statement="ON CONFLICT (\"paymentReference\") DO UPDATE SET ${conflict_columns_str}"
    echo "$insert_statement"
    echo "$conflict_statement"
}

# Main script
echo "Choose the configuration (sfi-23/delinked):"
read config_choice

declare -n column_mapping # Declare nameref here

case $config_choice in
    "sfi-23")
        column_mapping=sfi23_columns
        ;;
    "delinked")
        column_mapping=delinked_columns
        ;;
    *)
        echo "Invalid choice. Defaulting to sfi-23."
        column_mapping=sfi23_columns
        ;;
esac

# Get the list of files in the current directory
files=$(ls data-files)
echo "Choose a file from the list:"
IFS=$'\n' # Set the input field separator to newline
select file_name in $files; do
    if [ -n "$file_name" ]; then
        # Convert the data
        converted_data=$(convert_data "data-files/$file_name" column_mapping)
        # Create a new .txt file with the specified name format
        output_file="$(pwd)/outputs/ffc-doc-statement-${config_choice}-DAX-converted-$(date +%Y%m%d).txt"
        # Generate and add the INSERT and ON CONFLICT statements at the top and bottom of the file, respectively
        read insert_statement conflict_statement <<< $(generate_statements column_mapping)
        echo "$insert_statement" > "$output_file"
        echo "VALUES" >> "$output_file"
        echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//' >> "$output_file"
        echo "$conflict_statement;" >> "$output_file"
        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done