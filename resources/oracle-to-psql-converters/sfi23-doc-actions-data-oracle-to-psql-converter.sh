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
        output_file="$(pwd)/outputs/ffc-doc-statment-actions-data-converted-$(date +%Y%m%d).txt"

        # Add the INSERT statement at the top of the file
        echo "INSERT INTO \"actions\" (\"actionId\", \"calculationId\", \"fundingCode\", \"groupName\", \"actionCode\", \"actionName\", \"rate\", \"landArea\", \"uom\", \"annualValue\", \"quarterlyValue\", \"overDeclarationPenalty\", \"quarterlyPaymentAmount\")" > "$output_file"
        echo "VALUES" >> "$output_file"

        # Append the converted data to the file
        echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//' >> "$output_file"

        # Add the ON CONFLICT statement at the end of the file
        echo "ON CONFLICT (\"actionId\")" >> "$output_file"
        echo "DO" >> "$output_file"
        echo "UPDATE SET" >> "$output_file"
        echo "  \"actionId\" = EXCLUDED.\"actionId\"," >> "$output_file"
        echo "  \"calculationId\" = EXCLUDED.\"calculationId\"," >> "$output_file"
        echo "  \"fundingCode\" = EXCLUDED.\"fundingCode\"," >> "$output_file"
        echo "  \"groupName\" = EXCLUDED.\"groupName\"," >> "$output_file"
        echo "  \"actionCode\" = EXCLUDED.\"actionCode\"," >> "$output_file"
        echo "  \"actionName\" = EXCLUDED.\"actionName\"," >> "$output_file"
        echo "  \"rate\" = EXCLUDED.\"rate\"," >> "$output_file"
        echo "  \"landArea\" = EXCLUDED.\"landArea\"," >> "$output_file"
        echo "  \"uom\" = EXCLUDED.\"uom\"," >> "$output_file"
        echo "  \"annualValue\" = EXCLUDED.\"annualValue\"," >> "$output_file"
        echo "  \"quarterlyValue\" = EXCLUDED.\"quarterlyValue\"," >> "$output_file"
        echo "  \"overDeclarationPenalty\" = EXCLUDED.\"overDeclarationPenalty\"," >> "$output_file"
        echo "  \"quarterlyPaymentAmount\" = EXCLUDED.\"quarterlyPaymentAmount\";" >> "$output_file"

        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done