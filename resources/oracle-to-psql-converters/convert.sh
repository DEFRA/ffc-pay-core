#!/bin/bash

# Associative array of your conversion scripts and their corresponding prompts
declare -A scripts=(
    ["sfi23-doc-organisations-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Organisations table"
    ["sfi23-doc-totals-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Totals table"
    ["sfi23-doc-actions-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Actions table"
    ["sfi23-doc-DAX-data-oracle-to-psql-converter.sh"]="Please choose the data-file for DAX table"
    
    
    
)

# Execute each script
for script in "${!scripts[@]}"; do
    echo "Running $script..."
    echo "${scripts[$script]}"
    bash "$script"
done

# Create a final output file
final_output_file="final_output-$(date +%Y%m%d).txt"

# Concatenate the output files into the final output file in the specified order
cat outputs/*DAX*-converted-*.txt > "$final_output_file"
cat outputs/*organisations*-converted-*.txt >> "$final_output_file"
cat outputs/*totals*-converted-*.txt >> "$final_output_file"
cat outputs/*actions*-converted-*.txt >> "$final_output_file"

echo "All data concatenated and saved to $final_output_file"