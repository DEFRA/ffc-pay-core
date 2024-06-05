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
cat outputs/*organisations*-converted-*.txt > "$final_output_file"
cat outputs/*totals*-converted-*.txt >> "$final_output_file"
cat outputs/*DAX*-converted-*.txt >> "$final_output_file"
cat outputs/*actions*-converted-*.txt >> "$final_output_file"

# Ask the user if they want to obfuscate the data
read -p "Do you want to obfuscate the data? (yes/no) " obfuscate
if [[ $obfuscate == "yes" ]]; then
    # Ask the user for their email address
    read -p "Please enter your email address: " email
    # Load the obfuscation script
    obfuscation_script=$(cat <<'EOF'
DO $$

DECLARE

   rec RECORD;

   i INTEGER := 1;

BEGIN

   FOR rec IN (SELECT * FROM organisations)

   LOOP

      IF rec."addressLine1" IS NOT NULL THEN

         UPDATE organisations SET "addressLine1" = 'AddressLine1' || i WHERE sbi = rec.sbi;

      END IF;

      IF rec."addressLine2" IS NOT NULL THEN

         UPDATE organisations SET "addressLine2" = 'AddressLine2' || i WHERE sbi = rec.sbi;

      END IF;

      IF rec."addressLine3" IS NOT NULL THEN

         UPDATE organisations SET "addressLine3" = 'AddressLine3' || i WHERE sbi = rec.sbi;

      END IF;

      IF rec.city IS NOT NULL THEN

         UPDATE organisations SET city = 'City' || i WHERE sbi = rec.sbi;

      END IF;

      IF rec.county IS NOT NULL THEN

         UPDATE organisations SET county = 'County' || i WHERE sbi = rec.sbi;

      END IF;

      IF rec.postcode IS NOT NULL THEN

         UPDATE organisations SET postcode = 'A1 ' || i || 'A' WHERE sbi = rec.sbi;

      END IF;

      IF rec."emailAddress" IS NOT NULL THEN

         UPDATE organisations SET "emailAddress" = 'placeholder' WHERE sbi = rec.sbi;

      END IF;

      IF rec.name IS NOT NULL THEN

         UPDATE organisations SET name = 'name' || i WHERE sbi = rec.sbi;

      END IF;

      i := i + 1;

   END LOOP;

END $$;
EOF
)
    # Replace the placeholder email address with the user's email address
    obfuscation_script=$(echo "$obfuscation_script" | sed "s/placeholder/$email/")
    # Append the obfuscation script to the final output file
    echo "$obfuscation_script" >> "$final_output_file"
fi

echo "All data concatenated and saved to $final_output_file"