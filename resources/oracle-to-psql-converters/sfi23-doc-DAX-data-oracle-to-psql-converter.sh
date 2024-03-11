#!/bin/bash

# Function to convert Oracle SQL data to PostgreSQL format
function convert_data() {
    local file_path=$1
    local converted_data=$(grep "Insert into EXPORT_TABLE" "$file_path" | awk -F"values" '{print $2}' | sed "s/),(/)\n(/g" | sed "s/),/)\n/g" | sed "s/),/)\n/g" | sed "s/;/,/g" | sed '$s/;//')
    echo "$converted_data"
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