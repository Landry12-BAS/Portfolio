-- What every system shares in the one database: closed doors by default, and the
-- `extensions` schema. Run by infra/postgres/provision.sh as the superuser, on every
-- deploy, so every statement is safe to run again.
\set ON_ERROR_STOP on

SELECT current_database() AS database \gset

-- Nobody connects, or uses the `public` schema, unless a role is granted it. Without
-- this, every role could connect and see what is left in `public`.
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Extensions live in one schema that every system can read, and none can change.
-- pgvector gives LB-01 its vector type and indexes; btree_gist lets LB-02 forbid
-- overlapping bookings with an exclusion constraint. A system's search_path is its own
-- schema plus this one (services/django-systems/core/databases.py).
CREATE SCHEMA IF NOT EXISTS extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions;
