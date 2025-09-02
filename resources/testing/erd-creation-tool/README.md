##ERD Extraction Tool — extract-schema.js
This document describes the purpose of extract-schema.js, how to run it, an how to use the file flag.

##Purpose
extract-schema.js is a Node.js helper script intended to extract database schema information (from SQL DDL files or by introspecting a live database) and produce a representation that can be used to create an Entity Relationship Diagram (ERD). Typical outputs are:

JSON schema (tables, columns, PKs, FKs)

CD into the repository that contains a data directory and within it a model dir. 
run:

node extract-schema.js

This will create two files, one json output with the json format of the model, the other will be an ERD drawio output xml file that can be directly opened and edited in drawio.

##Direct file translation:

by using the -file flag in the command you can convert existing json files:

Single JSON file (WSL path);

node resources/testing/erd-creation-tool/extract-2.js -file /home/you/Downloads/my-repo-erd.json

Directory of JSONs:

node resources/testing/erd-creation-tool/extract-2.js -file /home/you/Downloads/json-exports

Multiple files (comma-separated):

node resources/testing/erd-creation-tool/extract-2.js -file file1.json,file2.json

Windows path (from WSL; script converts C:\... to /mnt/c/...):

node resources/testing/erd-creation-tool/extract-2.js -file "C:\Users\you\Downloads\my-repo-erd.json"