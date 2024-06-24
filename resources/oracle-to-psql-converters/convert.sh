#!/bin/bash

# Prompt the user to choose the data combination
echo "Choose the data combination:"
select combination in "SFI23" "delinked"; do
    case $combination in
        SFI23 )
            # Associative array for SFI23 combination
            declare -A scripts=(
                ["doc-organisations-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Organisations table"
                ["doc-totals-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Totals table"
                ["doc-actions-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Actions table"
                ["doc-DAX-data-oracle-to-psql-converter.sh"]="Please choose the data-file for DAX table"
            )
            break
            ;;
        delinked )
            # Associative array for delinked combination
            declare -A scripts=(
                ["doc-organisations-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Organisations table"
                ["doc-DAX-data-oracle-to-psql-converter.sh"]="Please choose the data-file for DAX table"
                ["doc-delinkedCalculation-data-oracle-to-psql-converter.sh"]="Please choose the data-file for Delinked Calculation table"
            )
            break
            ;;
        * ) echo "Invalid selection. Please choose a valid option.";;
    esac
done

# Execute each script based on the chosen combination
for script in "${!scripts[@]}"; do
    echo "Running $script..."
    echo "${scripts[$script]}"
    bash "$script"
done
# Ensure final_output_file is assigned
final_output_file="outputs/final_output-$(date +%Y%m%d).txt"

echo "Final output file: $final_output_file"

# Example of debugging echo statements before concatenation commands
echo "Concatenating files for combination: $combination"
if [[ $combination == "SFI23" ]]; then
    echo "Files to concatenate: outputs/*organisations*-converted-*.txt"
    cat outputs/*organisations*-converted-*.txt > "$final_output_file"
    echo "Files to concatenate: outputs/*totals*-converted-*.txt"
    cat outputs/*totals*-converted-*.txt >> "$final_output_file"
    echo "Files to concatenate: outputs/*actions*-converted-*.txt"
    cat outputs/*actions*-converted-*.txt >> "$final_output_file"
    echo "Files to concatenate: outputs/*DAX*-converted-*.txt"
    cat outputs/*DAX*-converted-*.txt >> "$final_output_file"
    # Add similar echo statements before each concatenation command
elif [[ $combination == "delinked" ]]; then
    echo "Files to concatenate: outputs/*organisations*-converted-*.txt"
    cat outputs/*organisations*-converted-*.txt > "$final_output_file"
    echo "Files to concatenate: outputs/*DAX*-converted-*.txt"
    cat outputs/*DAX*-converted-*.txt >> "$final_output_file"
    # Include the new delinkedCalculation data type
    echo "Including delinkedCalculation data type"
    cat outputs/*delinkedCalculation*-converted-*.txt >> "$final_output_file"
fi

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