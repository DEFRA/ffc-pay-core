#!/bin/bash
# Clear the terminal
clear

home_directory=$(pwd)
# Function to display the list of subdirectories and get the user's choice
function select_subdir() {
  # Get all subdirectories in the current directory, excluding the one containing the automation-script.sh file
  subdirs=$(find . -maxdepth 5 -type d ! -path '*/data*' ! -path './documents' ! -path './payments' | sort)
  # Create an array of subdirectory names
  subdirs_array=($subdirs)
  # Display the list of subdirectories to the user
  echo "Select the directory that you wish to perform a reset for:"
  for ((i = 0; i < ${#subdirs_array[@]}; i++)); do
    echo "$((i + 1)). ${subdirs_array[i]}"
  done
  
  # Get the user's choice
  read -p "Enter the number of the subdirectory you want to use (or 'b' to go back, or 'q' to quit): " choice

  # Check if the user's choice is valid
 if [[ $choice =~ ^[1-9][0-9]*$ || $choice =~ [bq] ]]; then
    # Check if the user chose to go back, up, or quit
    if [[ $choice == "${#subdirs_array[@]}" ]]; then
      # Go back to the start
     echo " You selected - ${subdirs_array[choice - 1]}"
    elif [[ $choice == "b" ]]; then
      # Go back to the previous subdirectory
      cd ..
    elif [[ $choice == "q" ]]; then
      # Quit the script
      exit 0
    else
      # Get the selected subdirectory
      selected_subdir=${subdirs_array[choice - 1]}
      # Change to the selected subdirectory
      cd "$selected_subdir"
    fi
  else
    echo "Invalid choice"
    exit 1
  fi
}
# Function to check if the automation-script.sh file exists and execute it if found
function execute_script() {
  # Check if the automate-queries.sh file exists
  if [ -f automate-queries.sh ]; then
    # Store the current directory
    original_directory=$(pwd)

    # Change to the parent directory
    cd "../"

    # Execute the databases-reset-scripts.sh file with a 20-second timeout and the -k option to kill the process after the timeout
    timeout -k 20 20 ./databases-reset-scripts.sh

    # Check the exit status of the previous command
    if [ $? -eq 124 ]; then
      echo "Timeout: databases-reset-scripts.sh - Are you sure your services are running?"
    fi

    # Return to the original directory
    cd "$original_directory"

    # Execute the automate-queries.sh file with a 20-second timeout and the -k option to kill the process after the timeout
    timeout -k 20 20 ./automate-queries.sh

    # Check the exit status of the second command
    if [ $? -eq 124 ]; then
      echo "Timeout: automate-queries.sh - Are you sure your services are running?"
    fi
  else
    # Display an error message
    echo "The automate-queries.sh file does not exist in this directory."
  fi
}

# Start the script
cd "$original_directory"
# Loop until the automation-script.sh file is found or the user quits
while true; do
  # Select the subdirectory
  select_subdir
  # Check if the automation-script.sh file exists and execute it if found
  execute_script
done