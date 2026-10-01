#!/bin/bash
# Proves the database's isolation (docs/SECURITY.md, section 5) against a real Postgres
# started from the same image, config and provisioning script the box uses:
#
#   - a system's role can build and use its own schema, with pgvector and btree_gist;
#   - it cannot read, write, create in or drop anything in another system's schema, in the
#     platform schema or in `public`, cannot become another role, and cannot log in to
#     another database;
#   - the superuser cannot log in over the network at all;
#   - the backup role reads every schema and writes nothing;
#   - provisioning twice changes nothing, and rotating a password takes effect.
#
# A second, throwaway system (lb99) stands in for "another system". Everything runs in
# containers named after LB_TEST_PREFIX (default lb-pgtest), and is removed at the end.
#
#   infra/postgres/test-roles.sh                 # uses the image docker-compose.yml names
#   LB_PG_IMAGE=... infra/postgres/test-roles.sh # or any image with pgvector and psql
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${LB_PG_IMAGE:-$("$here/../scripts/image-of.sh" postgres)}"
prefix="${LB_TEST_PREFIX:-lb-pgtest}-$$"
net="$prefix-net"
db="$prefix-db"
client="$prefix-client"
socket_volume="$prefix-socket"
data_volume="$prefix-data"
scratch="$(mktemp -d)"
failures=0

cleanup() {
    docker rm -f "$client" "$db" >/dev/null 2>&1 || true
    docker volume rm "$socket_volume" "$data_volume" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

# Passwords for the test only, made fresh every run.
random_password() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
superuser_password="$(random_password)"
lb01_password="$(random_password)"
lb99_password="$(random_password)"
lbgateway_password="$(random_password)"
lbbackup_password="$(random_password)"

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

# Runs one statement as a role over the network, the way a service would. Prints what
# psql prints and returns its exit status.
sql_as() {
    local role="$1" password="$2" statement="$3" database="${4:-lb}"
    docker exec -e PGPASSWORD="$password" "$client" \
        psql -h "$db" -U "$role" -d "$database" -X -q -t -A -v ON_ERROR_STOP=1 -c "$statement" 2>&1
}

# allowed <label> <role> <password> <statement>
allowed() {
    local output
    if output="$(sql_as "$2" "$3" "$4")"; then pass "$1"; else fail "$1 -- $output"; fi
}

# denied <label> <role> <password> <statement> <fragment of the expected error> [database]
denied() {
    local output
    if output="$(sql_as "$2" "$3" "$4" "${6:-lb}")"; then
        fail "$1 -- it was allowed"
    elif grep -qi -- "$5" <<<"$output"; then
        pass "$1"
    else
        fail "$1 -- refused, but not as expected: $output"
    fi
}

# expect_equal <label> <expected> <actual>
expect_equal() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- expected '$2', got '$3'"; fi
}

# Runs the provisioner once, with the given VAR=value pairs in its environment. The
# provisioner has no network: it reaches Postgres over the shared socket, like on the box.
provision() {
    local environment=() pair
    for pair in "$@"; do environment+=(-e "$pair"); done
    docker run --rm --network none --user postgres --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true \
        -v "$socket_volume":/var/run/postgresql \
        -v "$here":/provision:ro -v "$scratch/systems.txt":/provision/systems.txt:ro \
        "${environment[@]}" "$image" /provision/provision.sh
}

printf 'lb01\nlb99\n' > "$scratch/systems.txt"

echo "Starting Postgres from $image"
docker network create --internal "$net" >/dev/null
docker volume create "$socket_volume" >/dev/null
docker volume create "$data_volume" >/dev/null
docker run -d --name "$db" --network "$net" --user postgres --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --shm-size 128m --tmpfs /tmp \
    -e POSTGRES_DB=lb -e POSTGRES_PASSWORD="$superuser_password" \
    -v "$socket_volume":/var/run/postgresql -v "$data_volume":/var/lib/postgresql/data \
    -v "$here/postgresql.conf":/etc/postgresql/postgresql.conf:ro \
    -v "$here/pg_hba.conf":/etc/postgresql/pg_hba.conf:ro \
    "$image" postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null
docker run -d --name "$client" --network "$net" --user postgres --entrypoint sleep "$image" 600 >/dev/null
ready=false
for _ in $(seq 1 60); do
    if docker exec "$db" pg_isready -h /var/run/postgresql -d lb -q; then ready=true; break; fi
    sleep 1
done
if [ "$ready" != true ]; then
    docker logs "$db" >&2
    echo "Postgres did not become ready." >&2
    exit 1
fi

echo "Provisioning (the platform role has no password yet)"
provision "LB_PG_PASSWORD_LB01=$lb01_password" "LB_PG_PASSWORD_LB99=$lb99_password" \
    "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password"
echo "Provisioning again changes nothing and succeeds"
provision "LB_PG_PASSWORD_LB01=$lb01_password" "LB_PG_PASSWORD_LB99=$lb99_password" \
    "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null && pass "second provisioning run succeeded"

echo "A role builds and uses its own schema, with the shared extensions"
allowed "lb01 searches its own schema and the extensions" lb01 "$lb01_password" "SHOW search_path"
allowed "lb01 creates a table with a pgvector column" lb01 "$lb01_password" \
    "CREATE TABLE lb01.chunks (id int PRIMARY KEY, embedding vector(3))"
allowed "lb01 writes and reads it" lb01 "$lb01_password" \
    "INSERT INTO lb01.chunks VALUES (1, '[1,2,3]'); SELECT embedding <=> '[1,2,4]' FROM lb01.chunks"
allowed "lb01 builds an exclusion constraint with btree_gist" lb01 "$lb01_password" \
    "CREATE TABLE lb01.bookings (room int, during tstzrange, EXCLUDE USING gist (room WITH =, during WITH &&))"
allowed "lb01's migration step 'CREATE EXTENSION IF NOT EXISTS' is a harmless no-op" lb01 "$lb01_password" \
    "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions"
allowed "lb99 builds its own schema too" lb99 "$lb99_password" \
    "CREATE TABLE lb99.secrets (id int, note text); INSERT INTO lb99.secrets VALUES (1, 'only lb99 may read this')"
expect_equal "lb01 searches its own schema first" "lb01, extensions" "$(sql_as lb01 "$lb01_password" 'SHOW search_path')"

echo "A role cannot touch another system's schema"
denied "lb01 cannot read lb99's table" lb01 "$lb01_password" "SELECT * FROM lb99.secrets" "permission denied for schema lb99"
denied "lb01 cannot write lb99's table" lb01 "$lb01_password" "INSERT INTO lb99.secrets VALUES (2, 'x')" "permission denied for schema lb99"
denied "lb01 cannot create in lb99" lb01 "$lb01_password" "CREATE TABLE lb99.planted (id int)" "permission denied for schema lb99"
denied "lb01 cannot drop lb99's table" lb01 "$lb01_password" "DROP TABLE lb99.secrets" "permission denied for schema lb99"
denied "lb99 cannot read lb01's table" lb99 "$lb99_password" "SELECT * FROM lb01.chunks" "permission denied for schema lb01"
expect_equal "lb01 sees none of lb99's tables in information_schema" "0" \
    "$(sql_as lb01 "$lb01_password" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'lb99'")"
expect_equal "lb99 sees its own table in information_schema" "1" \
    "$(sql_as lb99 "$lb99_password" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'lb99'")"

echo "A role cannot change the shared schemas, or reach the platform's"
denied "lb01 cannot create in extensions" lb01 "$lb01_password" "CREATE TABLE extensions.planted (id int)" "permission denied for schema extensions"
denied "lb01 cannot create in public" lb01 "$lb01_password" "CREATE TABLE public.planted (id int)" "permission denied for schema public"
denied "lb01 cannot create in platform" lb01 "$lb01_password" "CREATE TABLE platform.planted (id int)" "permission denied for schema platform"
denied "lb01 cannot install another extension" lb01 "$lb01_password" "CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions" "permission denied"

echo "A role cannot become another role, make roles or databases, or read credentials"
denied "lb01 cannot SET ROLE lb99" lb01 "$lb01_password" "SET ROLE lb99" "permission denied to set role"
denied "lb01 cannot create a role" lb01 "$lb01_password" "CREATE ROLE intruder LOGIN" "permission denied"
denied "lb01 cannot create a database" lb01 "$lb01_password" "CREATE DATABASE intruder" "permission denied"
denied "lb01 cannot change lb99's password" lb01 "$lb01_password" "ALTER ROLE lb99 PASSWORD 'intruder-was-here'" "permission denied"
denied "lb01 cannot read password hashes" lb01 "$lb01_password" "SELECT rolpassword FROM pg_authid" "permission denied for table pg_authid"
denied "lb01 cannot read the server's files" lb01 "$lb01_password" "SELECT pg_read_file('/etc/passwd')" "permission denied"

echo "Only the one database accepts logins, and the superuser cannot log in over the network"
denied "lb01 cannot log in to the postgres database" lb01 "$lb01_password" "SELECT 1" "pg_hba.conf rejects connection" postgres
denied "the superuser is refused over the network, with the right password" postgres "$superuser_password" "SELECT 1" "pg_hba.conf rejects connection"
denied "a wrong password is refused" lb01 "not-the-password" "SELECT 1" "password authentication failed"

echo "The platform role cannot log in until it has a password, then sees only its schema"
denied "lbgateway has no password, so it cannot log in" lbgateway "$lbgateway_password" "SELECT 1" "password authentication failed"
provision "LB_PG_PASSWORD_LB01=$lb01_password" "LB_PG_PASSWORD_LB99=$lb99_password" \
    "LB_PG_PASSWORD_LBGATEWAY=$lbgateway_password" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
allowed "lbgateway logs in once its password is set, and builds in platform" lbgateway "$lbgateway_password" \
    "CREATE TABLE platform.run_spans (run_id text, body jsonb)"
denied "lbgateway cannot read lb01" lbgateway "$lbgateway_password" "SELECT * FROM lb01.chunks" "permission denied for schema lb01"
denied "lb01 cannot read platform" lb01 "$lb01_password" "SELECT * FROM platform.run_spans" "permission denied for schema platform"

echo "The backup role reads everything and writes nothing"
allowed "lbbackup reads lb01" lbbackup "$lbbackup_password" "SELECT count(*) FROM lb01.chunks"
allowed "lbbackup reads lb99" lbbackup "$lbbackup_password" "SELECT count(*) FROM lb99.secrets"
allowed "lbbackup reads platform" lbbackup "$lbbackup_password" "SELECT count(*) FROM platform.run_spans"
denied "lbbackup cannot write" lbbackup "$lbbackup_password" "INSERT INTO lb01.chunks VALUES (9, '[0,0,0]')" "read-only transaction"
denied "lbbackup cannot create" lbbackup "$lbbackup_password" "CREATE TABLE lb01.planted (id int)" "read-only transaction"
if docker exec -e PGPASSWORD="$lbbackup_password" "$client" \
    pg_dump -h "$db" -U lbbackup -d lb --format=custom --file=/tmp/lb.dump 2>/dev/null \
    && docker exec "$client" pg_restore --list /tmp/lb.dump | grep -q 'TABLE lb99 secrets'; then
    pass "lbbackup's pg_dump holds every system's tables"
else
    fail "lbbackup's pg_dump did not work"
fi

echo "Rotating a password takes effect on the next provisioning"
new_lb01_password="$(random_password)"
provision "LB_PG_PASSWORD_LB01=$new_lb01_password" "LB_PG_PASSWORD_LB99=$lb99_password" \
    "LB_PG_PASSWORD_LBGATEWAY=$lbgateway_password" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
denied "the old password stops working" lb01 "$lb01_password" "SELECT 1" "password authentication failed"
allowed "the new password works" lb01 "$new_lb01_password" "SELECT 1"
echo "A password that is too weak or malformed stops the provisioner"
if provision "LB_PG_PASSWORD_LB01=short" >/dev/null 2>&1; then
    fail "a short password was accepted"
else
    pass "a short password is refused"
fi

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
