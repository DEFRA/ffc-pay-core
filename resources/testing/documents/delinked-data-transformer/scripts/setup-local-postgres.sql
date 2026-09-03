-- Run this against your local Postgres instance before testing.
-- It creates a target database and a source-like database for an end-to-end test.

-- Create the target database. Adjust the database name to match the service you are testing.
DROP DATABASE IF EXISTS ffc_pay_alerting_local;
CREATE DATABASE ffc_pay_alerting_local;

-- Connect to the target to create the managed identity role and liquibase tables.
\c ffc_pay_alerting_local;

-- Create a role that simulates the Azure managed identity in the target.
DROP ROLE IF EXISTS devffcinfdmid01;
CREATE ROLE devffcinfdmid01 WITH LOGIN;

-- Liquibase metadata tables (excluded from transfer, used by grant discovery).
CREATE TABLE public.databasechangelog (
    id character varying(255) NOT NULL,
    author character varying(255) NOT NULL,
    filename character varying(520) NOT NULL,
    dateexecuted timestamp with time zone NOT NULL,
    orderexecuted integer NOT NULL,
    exectype character varying(10) NOT NULL,
    md5sum character varying(35),
    description character varying(255),
    comments character varying(255),
    tag character varying(255),
    liquibase character varying(20),
    contexts character varying(255),
    labels character varying(255),
    deployment_id character varying(10)
);

CREATE TABLE public.databasechangeloglock (
    id integer NOT NULL,
    locked boolean NOT NULL,
    lockgranted timestamp with time zone,
    lockedby character varying(255)
);

-- Grant the MID access to the Liquibase tables so discovery can detect it.
GRANT ALL PRIVILEGES ON TABLE public.databasechangelog TO devffcinfdmid01;
GRANT ALL PRIVILEGES ON TABLE public.databasechangeloglock TO devffcinfdmid01;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devffcinfdmid01;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO devffcinfdmid01;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO devffcinfdmid01;
