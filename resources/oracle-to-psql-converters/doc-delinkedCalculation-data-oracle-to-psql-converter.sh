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
        echo "INSERT INTO \"delinkedCalculation\" (\"applicationId\", \"calculationId\", \"sbi\", \"frn\", \"paymentBand1\", \"paymentBand2\", \"paymentBand3\", \"paymentBand4\", \"percentageReduction1\", \"percentageReduction2\", \"percentageReduction3\", \"percentageReduction4\", \"progressiveReductions1\", \"progressiveReductions2\", \"progressiveReductions3\", \"progressiveReductions4\", \"totalProgressiveReduction\", \"referenceAmount\", \"totalDelinkedPayment\", \"paymentAmountCalculated\")" > "$output_file"
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
echo "  \"paymentBand1\" = EXCLUDED.\"paymentBand1\"," >> "$output_file"
echo "  \"paymentBand2\" = EXCLUDED.\"paymentBand2\"," >> "$output_file"
echo "  \"paymentBand3\" = EXCLUDED.\"paymentBand3\"," >> "$output_file"
echo "  \"paymentBand4\" = EXCLUDED.\"paymentBand4\"," >> "$output_file"
echo "  \"percentageReduction1\" = EXCLUDED.\"percentageReduction1\"," >> "$output_file"
echo "  \"percentageReduction2\" = EXCLUDED.\"percentageReduction2\"," >> "$output_file"
echo "  \"percentageReduction3\" = EXCLUDED.\"percentageReduction3\"," >> "$output_file"
echo "  \"percentageReduction4\" = EXCLUDED.\"percentageReduction4\"," >> "$output_file"
echo "  \"progressiveReductions1\" = EXCLUDED.\"progressiveReductions1\"," >> "$output_file"
echo "  \"progressiveReductions2\" = EXCLUDED.\"progressiveReductions2\"," >> "$output_file"
echo "  \"progressiveReductions3\" = EXCLUDED.\"progressiveReductions3\"," >> "$output_file"
echo "  \"progressiveReductions4\" = EXCLUDED.\"progressiveReductions4\"," >> "$output_file"
echo "  \"totalProgressiveReduction\" = EXCLUDED.\"totalProgressiveReduction\"," >> "$output_file"
echo "  \"referenceAmount\" = EXCLUDED.\"referenceAmount\"," >> "$output_file"
echo "  \"totalDelinkedPayment\" = EXCLUDED.\"totalDelinkedPayment\"," >> "$output_file"
echo "  \"paymentAmountCalculated\" = EXCLUDED.\"paymentAmountCalculated\";" >> "$output_file"
        # Print the success message
        echo "Data converted and saved to $output_file"
        break
    else
        echo "Invalid selection. Please choose a file from the list."
    fi
done