#!/bin/bash
# Brings the database's shared schemas, extensions and login roles to the state this
# repository describes, and applies the passwords from the environment. It runs on every
# deploy (the `postgres-provision` service in docker-compose.yml) and changes nothing
# when nothing changed, so adding a system or rotating a password is a deploy, not a
# manual step on the box.
#
# It connects as the superuser over the unix socket, which pg_hba.conf allows only to the
# operating-system user `postgres`, so no password for the superuser exists anywhere in
# play. Each role's password comes from LB_PG_PASSWORD_<ROLE>, one variable per role.
#
#   lbgateway   owns the `platform` schema (sessions, quotas, usage, run spans)
#   lb01 ...    one role per system in systems.txt, each owning the schema of its name
#   lbbackup    reads everything, writes nothing: the nightly backup's login
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGUSER=postgres
export PGDATABASE="${PGDATABASE:-lb}"
# A password travels inside an ALTER ROLE statement, so nothing that could log the
# statement may be on for this session, not even after an error. Warnings only on the
# screen: "already exists, skipping" is the normal answer on every deploy after the first.
export PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic -c log_min_duration_statement=-1 -c client_min_messages=warning'

# `just secret-token` makes passwords from this alphabet, which is also safe inside the
# URLs the services connect with. Anything else is a mistake.
password_pattern='^[A-Za-z0-9_-]{32,128}$'

# Runs one SQL file, with the role's password (possibly empty) in LB_ROLE_PASSWORD.
run_sql() {
    local file="$1" password="$2"
    shift 2
    LB_ROLE_PASSWORD="$password" psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --file "$here/init/$file" "$@"
}

# Returns the value of the environment variable named LB_PG_PASSWORD_<ROLE IN CAPITALS>,
# or nothing when it is not set. Stops the script when it is set to something unusable.
password_of() {
    local role="$1" variable value
    variable="LB_PG_PASSWORD_${role^^}"
    value="${!variable:-}"
    if [ -n "$value" ] && ! [[ "$value" =~ $password_pattern ]]; then
        echo "provision: $variable must be 32 to 128 letters, digits, '-' or '_'." >&2
        exit 1
    fi
    printf '%s' "$value"
}

# Provisions one role that owns one schema, and says whether it can log in.
provision_role() {
    local role="$1" schema="$2" password
    password="$(password_of "$role")"
    run_sql 10-role.sql "$password" --set "role=$role" --set "schema=$schema"
    if [ -n "$password" ]; then
        echo "provision: $role owns schema $schema (login enabled)"
    else
        echo "provision: $role owns schema $schema (NO LOGIN: set LB_PG_PASSWORD_${role^^} to enable it)"
    fi
}

run_sql 00-platform.sql ""
provision_role lbgateway platform

while IFS= read -r line; do
    system="${line%%#*}"
    system="${system//[[:space:]]/}"
    [ -z "$system" ] && continue
    if ! [[ "$system" =~ ^lb[0-9]{2}$ ]]; then
        echo "provision: '$system' in systems.txt is not a system name like lb01." >&2
        exit 1
    fi
    provision_role "$system" "$system"
done < "$here/systems.txt"

backup_password="$(password_of lbbackup)"
run_sql 20-backup-role.sql "$backup_password"
if [ -n "$backup_password" ]; then
    echo "provision: lbbackup can read every schema (login enabled)"
else
    echo "provision: lbbackup can read every schema (NO LOGIN: set LB_PG_PASSWORD_LBBACKUP to enable it)"
fi
