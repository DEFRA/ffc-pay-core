Below you can find instructions on a recently automated way of running the initial data setup scripts using a single command for a specified statements/services. The nested folder inside postgres-setup-scripts coorelates with statements we are producing using Documents team services. In future we are planning to add more folders with sql scripts for each type of statement, for example in near future we will add a folder containing sql scripts for SFI-23 statement.

1.To install PostgreSQL on WSL (ie. Ubuntu):
Open your WSL terminal (ie. Ubuntu).
Update your Ubuntu packages: sudo apt update
Once the packages have updated, install PostgreSQL (and the -contrib package which has some helpful utilities) with: sudo apt install postgresql postgresql-contrib
Confirm installation and get the version number: psql --version

2.Download the script package from repo into your WSL

3.Ensure all services are up and running and navigate to the folder postgres-setup-scripts and issue command : ./automate-SFI22.sh
You should see the execution entries of scripts being logged in your WSL window, there is a success/fail message for each service/script.

Note : execution of scripts is linear, so if one fails, the script will exit giving indicative error on which service has failed and no other sql scripts will be executed.
Note: at this moment script has 7 services, that script is pushing data to : 
Ffc-pay-submission
Ffc-pay-statement-generator
Ffc-pay-statement-data
Ffc-pay-statement-constructor
Ffc-pay-request-editor
Ffc-pay-processing
ffc-pay-batch-processor


Below you can find the anatomy of script expression, so you can add new entries, edit existing ones in case there is a change to database setup or delete them if you are not using them. Current version only supports the above services for Documents team, so please ensure this is tailored to your own services by using below schema to edit properties of the script expressions.



![Auto-sql-script-execution-scheme](https://github.com/DEFRA/ffc-pay-core/assets/98330195/0bc13125-d3b4-4134-ba61-d807ac531512)

