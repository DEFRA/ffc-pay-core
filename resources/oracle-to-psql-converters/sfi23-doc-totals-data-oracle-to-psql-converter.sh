#!/bin/bash




# Function to convert Oracle SQL data to PostgreSQL format
function convert_data() {
    local file_path=$1
    local converted_data=$(grep "Insert into EXPORT_TABLE" "$file_path" | awk -F"values" '{print $2}' | sed "s/);/),/g" | sed "s/);/),/g" | sed "s/);/),/g" | sed "s/;/,/g" | sed "s/','DD-MON-YY HH:MI:SS')/','DD-MON-YY HH:MI:SS')/g" | sed 's/),$/)/g' | sed '$s/,$//')
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
        output_file="$(pwd)/outputs/ffc-doc-statment-totals-data-converted-$(date +%Y%m%d).txt"

        # Add the INSERT statement at the top of the file
        echo "INSERT INTO \"totals\" (\"sbi\", \"frn\", \"agreementNumber\", \"claimId\", \"schemeType\", \"calculationId\", \"calculationDate\", \"invoiceNumber\", \"agreementStart\", \"agreementEnd\", \"totalActionPayments\", \"totalAdditionalPayments\", \"totalPayments\", \"updated\")" > "$output_file"
        echo "VALUES" >> "$output_file"

        # Append the converted data to the file
        echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//' >> "$output_file"



# Add the ON CONFLICT statement at the end of the file
echo "ON CONFLICT (\"calculationId\")" >> "$output_file"
echo "DO" >> "$output_file"
echo "UPDATE SET" >> "$output_file"
echo "  \"frn\" = EXCLUDED.\"frn\"," >> "$output_file"
echo "  \"agreementNumber\" = EXCLUDED.\"agreementNumber\"," >> "$output_file"
echo "  \"claimId\" = EXCLUDED.\"claimId\"," >> "$output_file"
echo "  \"schemeType\" = EXCLUDED.\"schemeType\"," >> "$output_file"
echo "  \"calculationId\" = EXCLUDED.\"calculationId\"," >> "$output_file"
echo "  \"calculationDate\" = EXCLUDED.\"calculationDate\"," >> "$output_file"
echo "  \"invoiceNumber\" = EXCLUDED.\"invoiceNumber\"," >> "$output_file"
echo "  \"agreementStart\" = EXCLUDED.\"agreementStart\"," >> "$output_file"
echo "  \"agreementEnd\" = EXCLUDED.\"agreementEnd\"," >> "$output_file"
echo "  \"totalActionPayments\" = EXCLUDED.\"totalActionPayments\"," >> "$output_file"
echo "  \"totalAdditionalPayments\" = EXCLUDED.\"totalAdditionalPayments\"," >> "$output_file"
echo "  \"totalPayments\" = EXCLUDED.\"totalPayments\"," >> "$output_file"
echo "  \"updated\" = EXCLUDED.\"updated\";" >> "$output_file"

        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done
