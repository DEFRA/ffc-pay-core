
## Testing and local environment automation - introduction

Within this directory is an automation script that has been created to make setting up and resetting a local database environment faster for either new starters or between end to end tests. The script is simple, it looks for the subdirectories contained within and reports them back as an array. This first step is just a terminal GUI to allow the selection of the service you wish to use.

Within each of the array elements, the script looks for the presence of a further script called automate-queries in each of the directories and that script does the actual automation and setup.
Each element in the array has an assigned number and by selecting that number, the automate-queries script loads any common resets that are not specific to that scheme or use-case before then loading the list of specific queries needed for that use-case.
As an example, all SFI end to end tests currently use the same database setup, most of the tables are truncated the same regardless of it being SFI22 or SFI23, but the data being loaded in might differ so in this case all the database-resets are performed initially, then SFI22 would load in its data if selected, whereas SFI23 would load in its own version of that data if selected.

In all instances, the PGAdmin component can be a totally clean instance as the script will create the server group and databases before then performing the queries. This gives a greater flexibility in cases such as pgAdmin being used in Docker instead of a local installation and allows for the user to do a full volume teardown between tests if needed.

## Installation of PostgreSQL in your WSL
1.To install PostgreSQL on WSL (ie. Ubuntu):
Open your WSL terminal (ie. Ubuntu).
Update your Ubuntu packages: sudo apt update
Once the packages have updated, install PostgreSQL (and the -contrib package which has some helpful utilities) with: sudo apt install postgresql postgresql-contrib
Confirm installation and get the version number: psql --version

2.Download the script package from repo into your WSL

## Using the automation-script in the terminal

The first step is to ensure that all of your services are running, this is done using the ffc-pay-core start script for ffc Documents and Payment Hub (see ffc-pay-core documentation) and also ensure that your installed version of pgAdmin is also running, particularly if you use a dockerised version.

If you are not using the same microservices as Documents and Payments, please update this readme with your specific instructions and then make your copies of the automate_queries script and amendments including  your required file structure in the repo.

If the repo contains all the required files you need, to start:

cd into the /resources/testing directory
run the command : ./automation-script.sh

You will be shown an output in your terminal similar to below:

Select the directory that you wish to perform a reset for:
1. .
2. ./documents/SFI22
3. ./documents/SFI23
4. ./documents/test-cases
5. ./documents/test-cases/file-validation
Enter the number of the subdirectory you want to use (or 'b' to go back, or 'q' to quit): q

To run the automation, select the required scheme or test case, if you have gone into a directory and need to go back up a level you may select b to go back, or quit the tool by pressing q

## If the selection contains the automate-queries script:

The script will run, otherwise it will drill into the next directory.
When the automate-queries script runs it will do the following:

## Execute the ffc-pay-statement-data sql script
PGPASSWORD=ppp psql -h host.docker.internal -p 5452 -U postgres -d ffc_pay_statement_data -f $(pwd)/data/SFI22-ffc-pay-statement-data.sql 

Using the connection data found in the readme for each of each repo. The script enters the local environment password and the -U flag sets the username. 
-h sets the hostname, in this instance as host.docker.internal - for locally installed version of pgAdmin this will likely be localhost. 
The -d flag sets the database name
-f looks at the present working directory, then the /data/ directory where the sql query files are stored and runs that query.

The script then continues to the next script in the list until it completes or fails.

## Script fails

Currently the execution of scripts is linear, so if one fails, the script will exit giving indicative error on which service has failed and no other sql scripts will be executed.

## Permissions issues 
As this tool relies on bash scripts, the .sh files need to have executable permission to operate. 
While this should be set automatically, should you have issues it is worth checking they are in place by doing the following:
3.Navigate to the directory where the script is saved, for example with SFI22 : cd /resources/testing/documents/SFI22, and issue command : chmod +x automate-query.sh 
For the automation-script this would be: cd /resources/testing and issue the command : chmod +x automation-script.sh

## Anatomy of the script execution

Below you can find the anatomy of script expression, so you can add new entries, edit existing ones in case there is a change to database setup or delete them if you are not using them. Current version only supports the above services for Documents team, so please ensure this is tailored to your own services by using below schema to edit properties of the script expressions.

![Auto-sql-script-execution-scheme](https://github.com/DEFRA/ffc-pay-core/assets/98330195/0bc13125-d3b4-4134-ba61-d807ac531512)

