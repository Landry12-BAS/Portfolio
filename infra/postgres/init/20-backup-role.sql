-- The nightly backup's login: it can read every table in every schema and write nothing.
-- Run by infra/postgres/provision.sh as the superuser, on every deploy, so every
-- statement is safe to run again. The password arrives in the environment as
-- LB_ROLE_PASSWORD; without one the role cannot log in.
\set ON_ERROR_STOP on

\getenv role_password LB_ROLE_PASSWORD
SELECT current_database() AS database,
       (:'role_password' <> '') AS has_password \gset

SELECT 'CREATE ROLE lbbackup NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lbbackup')
\gexec
ALTER ROLE lbbackup NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 2;
\if :has_password
    ALTER ROLE lbbackup LOGIN PASSWORD :'role_password';
\else
    ALTER ROLE lbbackup NOLOGIN PASSWORD NULL;
\endif
-- pg_read_all_data is Postgres's own role for "SELECT on everything, USAGE on every
-- schema", which is what pg_dump needs and nothing more.
GRANT pg_read_all_data TO lbbackup;
GRANT CONNECT ON DATABASE :"database" TO lbbackup;
ALTER ROLE lbbackup SET default_transaction_read_only = on;
