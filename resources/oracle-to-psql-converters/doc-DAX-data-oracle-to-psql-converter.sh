#!/bin/bash
# Define column mappings for sfi-23 and delinked configurations
sfi23_columns=("calculationId" "paymentPeriod" "paymentReference" "paymentAmount" "transactionDate")
delinked_columns=("calculationId" "paymentPeriod" "paymentReference" "paymentAmount" "transactionDate")
# Function to convert Oracle SQL data to PostgreSQL format
function convert_data() {
    local file_path=$1
    # Convert Oracle to_date to PostgreSQL compatible format
    # Assuming Oracle format is 'DD-MON-YY' which is common, adjust if necessary
    local converted_data=$(grep "Insert into EXPORT_TABLE" "$file_path" \
        | awk -F"values" '{print $2}' \
        | sed "s/),(/),\n(/g" \
        | sed "s/;/,/g" \
        | sed '$s/,$//' \
        | sed "s/to_date('\([^']*\)','DD-MON-YY')/TO_DATE('\1', 'DD-MON-YY')/g") # Adjust the format as necessary
    echo "$converted_data"
}
# Function to generate INSERT and ON CONFLICT statements based on column mapping
function generate_statements() {
    local -n config_columns=$1
    local insert_columns_str=""
    local conflict_columns_str=""
    local first=true
    for column in "${config_columns[@]}"; do  # Iterate over elements of the indexed array
        if [ "$first" = true ]; then
            first=false
        else
            insert_columns_str+=", "
            conflict_columns_str+=", "
        fi
        insert_columns_str+="\"$column\""
        conflict_columns_str+="\"$column\" = EXCLUDED.\"$column\""
    done
    local insert_statement="INSERT INTO \"dax\" (${insert_columns_str})"
    local conflict_statement="ON CONFLICT (\"${config_columns[2]}\") DO UPDATE SET ${conflict_columns_str}"  # Assuming "paymentReference" is always the conflict column
    echo "$insert_statement#$conflict_statement"
}
# Main script
echo "Choose the configuration:"
echo "1) sfi-23"
echo "2) delinked"
read config_choice_number

declare -n column_mapping # Declare nameref here

case $config_choice_number in
    1)
        config_choice="sfi-23"
        column_mapping=sfi23_columns
        ;;
    2)
        config_choice="delinked"
        column_mapping=delinked_columns
        ;;
    *)
        echo "Invalid choice. Defaulting to sfi-23."
        config_choice="sfi-23"
        column_mapping=sfi23_columns
        ;;
esac
# Get the list of files in the current directory
files=$(ls data-files)
echo "Choose a file from the list:"
IFS=$'\n' # Set the input field separator to newline
select file_name in $files; do
    if [ -n "$file_name" ]; then
        # Define output file path here, after the file selection
        output_file="$(pwd)/outputs/ffc-doc-statement-${config_choice}-DAX-converted-$(date +%Y%m%d).txt"
        # Convert the data
        converted_data=$(convert_data "data-files/$file_name" column_mapping)
        # Generate and add the INSERT and ON CONFLICT statements at the top and bottom of the file, respectively
        combined_statements=$(generate_statements column_mapping)
        IFS='###' read -r insert_statement conflict_statement <<< "$combined_statements"
        {
            echo "$insert_statement"
            echo "VALUES"
            if [ "$config_choice" = "sfi-23" ]; then
                # For sfi-23, process the converted data to remove the last comma
                echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//'
            else
                # For delinked or any other choice, append the converted data directly
                echo "$converted_data"
            fi
            echo "$conflict_statement;"
        } > "$output_file"
        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done