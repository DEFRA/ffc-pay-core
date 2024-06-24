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
        output_file="$(pwd)/outputs/ffc-doc-statement-delinkedCalculation-data-converted-$(date +%Y%m%d).txt"
        # Add the INSERT statement at the top of the file
        echo "INSERT INTO \"delinkedCalculation\" (\"applicationId\", \"calculationId\", \"sbi\", \"frn\", \"piBpsBand1\", \"piBpsBand2\", \"piBpsBand3\", \"piBpsBand4\", \"piBpsBandPrc1\", \"piBpsBandPrc2\", \"piBpsBandPrc3\", \"piBpsBandPrc4\", \"progRedBand1\", \"progRedBand2\", \"progRedBand3\", \"progRedBand4\", \"totProRedAmo\", \"curRefAmount\", \"neTotAmount\", \"paymentAmountCalculated\")" > "$output_file"
        echo "VALUES" >> "$output_file"
        # Append the converted data to the file
        echo "$converted_data" | perl -0777 -pe 's/,(?=[^,]*$)//' >> "$output_file"
        # Add the ON CONFLICT statement at the end of the file
        echo "ON CONFLICT (\"calculationId\")" >> "$output_file"
        echo "DO" >> "$output_file"
        echo "UPDATE SET" >> "$output_file"
        echo "  \"applicationId\" = EXCLUDED.\"applicationId\"," >> "$output_file"
        echo "  \"sbi\" = EXCLUDED.\"sbi\"," >> "$output_file"
        echo "  \"frn\" = EXCLUDED.\"frn\"," >> "$output_file"
        echo "  \"piBpsBand1\" = EXCLUDED.\"piBpsBand1\"," >> "$output_file"
        echo "  \"piBpsBand2\" = EXCLUDED.\"piBpsBand2\"," >> "$output_file"
        echo "  \"piBpsBand3\" = EXCLUDED.\"piBpsBand3\"," >> "$output_file"
        echo "  \"piBpsBand4\" = EXCLUDED.\"piBpsBand4\"," >> "$output_file"
        echo "  \"piBpsBandPrc1\" = EXCLUDED.\"piBpsBandPrc1\"," >> "$output_file"
        echo "  \"piBpsBandPrc2\" = EXCLUDED.\"piBpsBandPrc2\"," >> "$output_file"
        echo "  \"piBpsBandPrc3\" = EXCLUDED.\"piBpsBandPrc3\"," >> "$output_file"
        echo "  \"piBpsBandPrc4\" = EXCLUDED.\"piBpsBandPrc4\"," >> "$output_file"
        echo "  \"progRedBand1\" = EXCLUDED.\"progRedBand1\"," >> "$output_file"
        echo "  \"progRedBand2\" = EXCLUDED.\"progRedBand2\"," >> "$output_file"
        echo "  \"progRedBand3\" = EXCLUDED.\"progRedBand3\"," >> "$output_file"
        echo "  \"progRedBand4\" = EXCLUDED.\"progRedBand4\"," >> "$output_file"
        echo "  \"totProRedAmo\" = EXCLUDED.\"totProRedAmo\"," >> "$output_file"
        echo "  \"curRefAmount\" = EXCLUDED.\"curRefAmount\"," >> "$output_file"
        echo "  \"neTotAmount\" = EXCLUDED.\"neTotAmount\"," >> "$output_file"
        echo "  \"paymentAmountCalculated\" = EXCLUDED.\"paymentAmountCalculated\";" >> "$output_file"
        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done