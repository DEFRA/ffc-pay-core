#!/bin/bash

# Function to validate email address pattern
validate_email() {
    if [[ $1 =~ .*\..*@.* ]]; then
        echo "Email address is valid."
        return 0
    else
        echo "Invalid email address. Please provide an address following the pattern: anyChar.anyChar@anyChar"
        return 1
    fi
}

# Function to modify email addresses in a given SQL script
modify_script() {
    local script_path="$1"
    local user_email="$2"
    
    # Replace email addresses in the SQL script in-place
    sed -i "s/'[^']*@[^']*'/'$user_email'/g" "$script_path"

    echo "Script '$script_path' has been modified in-place."
}

# Prompt user for testing email address and validate
while true; do
    read -p "Enter your testing email address: " user_email
    if validate_email "$user_email"; then
        break
    fi
done

# Specify the paths to your SQL scripts
script1_path="./documents/SFI23/data/SFI23-ffc-pay-statement-data.sql"
script2_path="./documents/SFI22/data/SFI22-ffc-pay-statement-data.sql"

# Modify email addresses in each script
modify_script "$script1_path" "$user_email"
modify_script "$script2_path" "$user_email"
