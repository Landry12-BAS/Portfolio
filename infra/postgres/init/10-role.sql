-- One login role that owns one schema and can reach nothing else: the pattern for every
-- system (`lb01` owns schema `lb01`) and for the platform (`lbgateway` owns `platform`).
-- Run once per role by infra/postgres/provision.sh, as the superuser, on every deploy, so
-- every statement is safe to run again and a changed password is applied.
--
-- The caller sets two psql variables, `role` and `schema`, and puts the password in the
-- environment as LB_ROLE_PASSWORD (read here with \getenv, so it never appears in a
-- process listing). Without a password the role exists but cannot log in: a system that is
-- declared before its secret is set fails closed instead of getting an empty password.
\set ON_ERROR_STOP on

\getenv role_password LB_ROLE_PASSWORD
SELECT current_database() AS database,
       (:'role_password' <> '') AS has_password \gset

-- The role: an ordinary login, with no way to create roles or databases, to bypass row
-- security or to replicate, and a cap on connections so one system can't starve the rest.
SELECT format('CREATE ROLE %I NOLOGIN', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')
\gexec
ALTER ROLE :"role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 20;
\if :has_password
    ALTER ROLE :"role" LOGIN PASSWORD :'role_password';
\else
    ALTER ROLE :"role" NOLOGIN PASSWORD NULL;
\endif
-- Whatever the connection asks for, the role starts out looking at its own schema and the
-- shared extensions. An abandoned transaction can't hold locks for long.
ALTER ROLE :"role" SET search_path = :"schema", extensions;
ALTER ROLE :"role" SET idle_in_transaction_session_timeout = '5min';

-- The schema belongs to the role, so it can create the tables its migrations describe,
-- and nobody else is let in.
CREATE SCHEMA IF NOT EXISTS :"schema" AUTHORIZATION :"role";
ALTER SCHEMA :"schema" OWNER TO :"role";
REVOKE ALL ON SCHEMA :"schema" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO :"role";
