#!/bin/bash
# Proves the database's isolation (docs/SECURITY.md, section 5) against a real Postgres
# started from the same image, config and provisioning script the box uses, for every
# system listed in systems.txt (so adding a system adds it to this proof):
#
#   - a system's role can build and use its own schema, with the shared extensions
#     (pgvector for LB-01, btree_gist for LB-02's no-double-booking constraint);
#   - it cannot read, write, create in or drop anything in any other system's schema, in the
#     platform schema or in `public`, cannot become another role, and cannot log in to
#     another database;
#   - the superuser cannot log in over the network at all;
#   - the backup role reads every schema and writes nothing;
#   - a system declared before its password is set cannot log in until it is;
#   - provisioning twice changes nothing, and rotating a password takes effect.
#
# Everything runs in containers named after LB_TEST_PREFIX (default lb-pgtest), and is
# removed at the end.
#
#   infra/postgres/test-roles.sh                 # uses the image docker-compose.yml names
#   LB_PG_IMAGE=... infra/postgres/test-roles.sh # or any image with pgvector and psql
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The dump's arguments, which the nightly backup uses too (infra/backup/lib.sh).
# shellcheck source=/dev/null
source "$here/../backup/lib.sh"
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
lbgateway_password="$(random_password)"
lbbackup_password="$(random_password)"

# The systems that get a role of their own, from the same file the provisioner reads.
systems="$(sed 's/#.*//' "$here/systems.txt" | tr -s '[:space:]' ' ' | sed 's/^ *//; s/ *$//')"
for system in $systems; do
    random_password > "$scratch/password-$system"
done
password_of() { cat "$scratch/password-$1"; }
has_system() { [[ " $systems " == *" $1 "* ]]; }
last_system="$systems"
last_system="${last_system##* }"

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

# The provisioner's password variable for every system, except the ones named as arguments.
system_passwords() {
    local system
    for system in $systems; do
        if [[ " $* " != *" $system "* ]]; then
            printf 'LB_PG_PASSWORD_%s=%s\n' "$(printf '%s' "$system" | tr '[:lower:]' '[:upper:]')" "$(password_of "$system")"
        fi
    done
}

# Runs the provisioner once, with the given VAR=value pairs in its environment. The
# provisioner has no network: it reaches Postgres over the shared socket, like on the box.
provision() {
    local environment=() pair
    for pair in "$@"; do environment+=(-e "$pair"); done
    docker run --rm --network none --user postgres --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true \
        -v "$socket_volume":/var/run/postgresql \
        -v "$here":/provision:ro \
        "${environment[@]}" "$image" /provision/provision.sh
}

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
# The image starts a temporary server to run its init scripts, stops it, and starts the real one: the server
# is the real one once it has said it is ready twice, and `pg_isready` alone answers for the temporary one.
for _ in $(seq 1 90); do
    if [ "$(docker logs "$db" 2>&1 | grep -c 'database system is ready to accept connections')" -ge 2 ] \
        && docker exec "$db" pg_isready -h /var/run/postgresql -d lb -q; then ready=true; break; fi
    sleep 1
done
if [ "$ready" != true ]; then
    docker logs "$db" >&2
    echo "Postgres did not become ready." >&2
    exit 1
fi

echo "Provisioning $systems (the platform role has no password yet, and neither has $last_system)"
mapfile -t passwords < <(system_passwords "$last_system")
provision "${passwords[@]}" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
denied "$last_system is declared but has no password, so it cannot log in" "$last_system" "$(password_of "$last_system")" \
    "SELECT 1" "password authentication failed"
mapfile -t passwords < <(system_passwords)
provision "${passwords[@]}" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
allowed "$last_system logs in once its password is set" "$last_system" "$(password_of "$last_system")" "SELECT 1"
echo "Provisioning again changes nothing and succeeds"
provision "${passwords[@]}" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null && pass "second provisioning run succeeded"

echo "Each role builds and uses its own schema, with the shared extensions"
for system in $systems; do
    password="$(password_of "$system")"
    expect_equal "$system searches its own schema first, then the extensions" "$system, extensions" "$(sql_as "$system" "$password" 'SHOW search_path')"
    allowed "$system builds a table in its own schema and reads it back" "$system" "$password" \
        "CREATE TABLE $system.notes (id int PRIMARY KEY, note text); INSERT INTO $system.notes VALUES (1, 'only $system may read this'); SELECT note FROM $system.notes"
    allowed "$system's migration step 'CREATE EXTENSION IF NOT EXISTS' is a harmless no-op" "$system" "$password" \
        "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions"
    allowed "$system builds an exclusion constraint with btree_gist" "$system" "$password" \
        "CREATE TABLE $system.bookings (room int, during tstzrange, EXCLUDE USING gist (room WITH =, during WITH &&))"
done
if has_system lb01; then
    allowed "lb01 creates a table with a pgvector column" lb01 "$(password_of lb01)" \
        "CREATE TABLE lb01.chunks (id int PRIMARY KEY, embedding vector(3))"
    allowed "lb01 writes and reads it, with the vector operators" lb01 "$(password_of lb01)" \
        "INSERT INTO lb01.chunks VALUES (1, '[1,2,3]'); SELECT embedding <=> '[1,2,4]' FROM lb01.chunks"
fi
if has_system lb02; then
    allowed "lb02 books a room" lb02 "$(password_of lb02)" \
        "INSERT INTO lb02.bookings VALUES (1, '[2026-01-01 10:00, 2026-01-01 11:00)')"
    denied "lb02's constraint refuses a double booking of the same room" lb02 "$(password_of lb02)" \
        "INSERT INTO lb02.bookings VALUES (1, '[2026-01-01 10:30, 2026-01-01 11:30)')" "conflicting key value violates exclusion constraint"
    allowed "and accepts the same hour in another room" lb02 "$(password_of lb02)" \
        "INSERT INTO lb02.bookings VALUES (2, '[2026-01-01 10:30, 2026-01-01 11:30)')"
fi

echo "A role cannot touch another system's schema (every pair)"
for system in $systems; do
    password="$(password_of "$system")"
    for other in $systems; do
        [ "$other" = "$system" ] && continue
        denied "$system cannot read $other's table" "$system" "$password" "SELECT * FROM $other.notes" "permission denied for schema $other"
        denied "$system cannot write $other's table" "$system" "$password" "INSERT INTO $other.notes VALUES (2, 'x')" "permission denied for schema $other"
        denied "$system cannot create in $other" "$system" "$password" "CREATE TABLE $other.planted (id int)" "permission denied for schema $other"
        denied "$system cannot drop $other's table" "$system" "$password" "DROP TABLE $other.notes" "permission denied for schema $other"
        expect_equal "$system sees none of $other's tables in information_schema" "0" \
            "$(sql_as "$system" "$password" "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$other'")"
    done
    expect_equal "$system sees its own tables in information_schema" "2" \
        "$(sql_as "$system" "$password" "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$system' AND table_name IN ('notes', 'bookings')")"
done

echo "A role cannot change the shared schemas, reach the platform's, or become another role"
for system in $systems; do
    password="$(password_of "$system")"
    other="${systems%% *}"
    if [ "$other" = "$system" ]; then other="${last_system}"; fi
    denied "$system cannot create in extensions" "$system" "$password" "CREATE TABLE extensions.planted (id int)" "permission denied for schema extensions"
    denied "$system cannot create in public" "$system" "$password" "CREATE TABLE public.planted (id int)" "permission denied for schema public"
    denied "$system cannot create in platform" "$system" "$password" "CREATE TABLE platform.planted (id int)" "permission denied for schema platform"
    denied "$system cannot install another extension" "$system" "$password" "CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions" "permission denied"
    denied "$system cannot SET ROLE $other" "$system" "$password" "SET ROLE $other" "permission denied to set role"
    denied "$system cannot create a role" "$system" "$password" "CREATE ROLE intruder LOGIN" "permission denied"
    denied "$system cannot create a database" "$system" "$password" "CREATE DATABASE intruder" "permission denied"
    denied "$system cannot change $other's password" "$system" "$password" "ALTER ROLE $other PASSWORD 'intruder-was-here'" "permission denied"
    denied "$system cannot read password hashes" "$system" "$password" "SELECT rolpassword FROM pg_authid" "permission denied for table pg_authid"
    denied "$system cannot read the server's files" "$system" "$password" "SELECT pg_read_file('/etc/passwd')" "permission denied"
    denied "$system cannot log in to the postgres database" "$system" "$password" "SELECT 1" "pg_hba.conf rejects connection" postgres
done

echo "The superuser cannot log in over the network, and a wrong password is refused"
denied "the superuser is refused over the network, with the right password" postgres "$superuser_password" "SELECT 1" "pg_hba.conf rejects connection"
denied "a wrong password is refused" "${systems%% *}" "not-the-password" "SELECT 1" "password authentication failed"

echo "The platform role cannot log in until it has a password, then sees only its schema"
denied "lbgateway has no password, so it cannot log in" lbgateway "$lbgateway_password" "SELECT 1" "password authentication failed"
provision "${passwords[@]}" "LB_PG_PASSWORD_LBGATEWAY=$lbgateway_password" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
allowed "lbgateway logs in once its password is set, and builds in platform" lbgateway "$lbgateway_password" \
    "CREATE TABLE platform.run_spans (run_id text, body jsonb)"
for system in $systems; do
    denied "lbgateway cannot read $system" lbgateway "$lbgateway_password" "SELECT * FROM $system.notes" "permission denied for schema $system"
    denied "$system cannot read platform" "$system" "$(password_of "$system")" "SELECT * FROM platform.run_spans" "permission denied for schema platform"
done

echo "The backup role reads everything and writes nothing"
for system in $systems; do
    allowed "lbbackup reads $system" lbbackup "$lbbackup_password" "SELECT count(*) FROM $system.notes"
done
allowed "lbbackup reads platform" lbbackup "$lbbackup_password" "SELECT count(*) FROM platform.run_spans"
denied "lbbackup cannot write" lbbackup "$lbbackup_password" "INSERT INTO ${systems%% *}.notes VALUES (9, 'x')" "read-only transaction"
denied "lbbackup cannot create" lbbackup "$lbbackup_password" "CREATE TABLE ${systems%% *}.planted (id int)" "read-only transaction"
if docker exec -e PGPASSWORD="$lbbackup_password" "$client" \
    pg_dump -h "$db" -U lbbackup -d lb --format=custom --file=/tmp/lb.dump 2>/dev/null; then
    dump_list="$(docker exec "$client" pg_restore --list /tmp/lb.dump)"
    for system in $systems; do
        if grep -q "TABLE $system notes" <<<"$dump_list"; then pass "lbbackup's pg_dump holds $system's tables"; else fail "lbbackup's pg_dump lacks $system's tables"; fi
    done
else
    fail "lbbackup's pg_dump did not work"
fi

echo "The nightly backup leaves out what visitors upload (infra/backup/excluded-data.txt)"
if has_system lb04; then
    # LB-04's tables as the service has them, each with a row: a contract with the name of the visitor's file, its PDF, the report and a redline made of it, and a daily counter.
    allowed "lb04 holds a visitor's contract, its file, its report and its redline, and a daily counter" lb04 "$(password_of lb04)" \
        "CREATE TABLE lb04.contracts (id int PRIMARY KEY, title text); CREATE TABLE lb04.contract_files (contract_id int, content bytea); CREATE TABLE lb04.contract_pages (contract_id int, page_text text); CREATE TABLE lb04.reports (contract_id int, report jsonb); CREATE TABLE lb04.redlines (contract_id int, redline jsonb); CREATE TABLE lb04.usage_counters (session_key text, used int); INSERT INTO lb04.contracts VALUES (1, 'secret-name.pdf'); INSERT INTO lb04.contract_files VALUES (1, '\\x255044462d'); INSERT INTO lb04.contract_pages VALUES (1, 'secret words'); INSERT INTO lb04.reports VALUES (1, '{}'); INSERT INTO lb04.redlines VALUES (1, '{}'); INSERT INTO lb04.usage_counters VALUES ('s', 1)"
    mapfile -t dump_arguments < <(backup_dump_arguments "$here/../backup/excluded-data.txt")
    if docker exec -e PGPASSWORD="$lbbackup_password" "$client" \
        pg_dump -h "$db" -U lbbackup -d lb "${dump_arguments[@]}" --file=/tmp/lb-nightly.dump 2>/dev/null; then
        nightly_list="$(docker exec "$client" pg_restore --list /tmp/lb-nightly.dump)"
        for table in contracts contract_files contract_pages reports redlines; do
            if grep -q "TABLE lb04 $table " <<<"$nightly_list"; then pass "the backup keeps the shape of lb04.$table"; else fail "the backup lacks lb04.$table itself"; fi
            if grep -q "TABLE DATA lb04 $table " <<<"$nightly_list"; then fail "the backup holds the rows of lb04.$table"; else pass "  and none of its rows"; fi
        done
        if grep -q "TABLE DATA lb04 usage_counters " <<<"$nightly_list"; then pass "it keeps the daily counters, which are only numbers"; else fail "the backup lacks the daily counters"; fi
        if has_system lb06; then
            # LB-06's tables as the service has them: an incident with the visitor's version label, its log, the scenario cache, and a daily counter.
            allowed "lb06 holds a visitor's incident, its log, the scenario cache and a daily counter" lb06 "$(password_of lb06)" \
                "CREATE TABLE lb06.incidents (id int PRIMARY KEY, params jsonb); CREATE TABLE lb06.incident_events (incident_id int, data jsonb); CREATE TABLE lb06.scenario_cache (key text, payload jsonb); CREATE TABLE lb06.usage_counters (session_key text, used int); INSERT INTO lb06.incidents VALUES (1, '{\"version\": \"secret label\"}'); INSERT INTO lb06.incident_events VALUES (1, '{\"version\": \"secret label\"}'); INSERT INTO lb06.scenario_cache VALUES ('k', '{\"version\": \"secret label\"}'); INSERT INTO lb06.usage_counters VALUES ('s', 1)"
            if docker exec -e PGPASSWORD="$lbbackup_password" "$client" \
                pg_dump -h "$db" -U lbbackup -d lb "${dump_arguments[@]}" --file=/tmp/lb-nightly-lb06.dump 2>/dev/null; then
                lb06_list="$(docker exec "$client" pg_restore --list /tmp/lb-nightly-lb06.dump)"
                for table in incidents incident_events scenario_cache; do
                    if grep -q "TABLE lb06 $table " <<<"$lb06_list"; then pass "the backup keeps the shape of lb06.$table"; else fail "the backup lacks lb06.$table itself"; fi
                    if grep -q "TABLE DATA lb06 $table " <<<"$lb06_list"; then fail "the backup holds the rows of lb06.$table"; else pass "  and none of its rows"; fi
                done
                if grep -q "TABLE DATA lb06 usage_counters " <<<"$lb06_list"; then pass "it keeps LB-06's daily counters"; else fail "the backup lacks LB-06's daily counters"; fi
                if docker exec "$client" sh -c 'pg_restore -f - /tmp/lb-nightly-lb06.dump | grep -q "secret label"'; then fail "the backup holds the visitor's label"; else pass "no word of the visitor's label is in the backup"; fi
            else
                fail "lbbackup's nightly pg_dump did not work with LB-06's tables"
            fi
        fi
        if has_system lb07; then
            # LB-07's tables as the service has them: a test run with the visitor's goal, a step of its plan, a finding, a screenshot and a page snapshot, the report with its generated test, and a daily counter.
            allowed "lb07 holds a visitor's test run, its steps, findings, evidence and report, and a daily counter" lb07 "$(password_of lb07)" \
                "CREATE TABLE lb07.runs (id int PRIMARY KEY, goal text); CREATE TABLE lb07.run_steps (run_id int, step jsonb); CREATE TABLE lb07.findings (run_id int, detail text); CREATE TABLE lb07.evidence (run_id int, image bytea, text text); CREATE TABLE lb07.reports (run_id int, report jsonb, test_source text); CREATE TABLE lb07.usage_counters (session_key text, used int); INSERT INTO lb07.runs VALUES (1, 'secret goal'); INSERT INTO lb07.run_steps VALUES (1, '{\"value\": \"secret goal\"}'); INSERT INTO lb07.findings VALUES (1, 'secret goal'); INSERT INTO lb07.evidence VALUES (1, '\\x89504e47', 'secret goal'); INSERT INTO lb07.reports VALUES (1, '{\"goal\": \"secret goal\"}', 'test(\"secret goal\")'); INSERT INTO lb07.usage_counters VALUES ('s', 1)"
            if docker exec -e PGPASSWORD="$lbbackup_password" "$client" \
                pg_dump -h "$db" -U lbbackup -d lb "${dump_arguments[@]}" --file=/tmp/lb-nightly-lb07.dump 2>/dev/null; then
                lb07_list="$(docker exec "$client" pg_restore --list /tmp/lb-nightly-lb07.dump)"
                for table in runs run_steps findings evidence reports; do
                    if grep -q "TABLE lb07 $table " <<<"$lb07_list"; then pass "the backup keeps the shape of lb07.$table"; else fail "the backup lacks lb07.$table itself"; fi
                    if grep -q "TABLE DATA lb07 $table " <<<"$lb07_list"; then fail "the backup holds the rows of lb07.$table"; else pass "  and none of its rows"; fi
                done
                if grep -q "TABLE DATA lb07 usage_counters " <<<"$lb07_list"; then pass "it keeps LB-07's daily counters"; else fail "the backup lacks LB-07's daily counters"; fi
                if docker exec "$client" sh -c 'pg_restore -f - /tmp/lb-nightly-lb07.dump | grep -q "secret goal"'; then fail "the backup holds the visitor's goal"; else pass "no word of the visitor's goal is in the backup"; fi
            else
                fail "lbbackup's nightly pg_dump did not work with LB-07's tables"
            fi
        fi
        for system in $systems; do
            if grep -q "TABLE DATA $system notes " <<<"$nightly_list"; then pass "it keeps the rows of $system's other tables"; else fail "the backup lacks the rows of $system.notes"; fi
        done
        # The proof that the words are not in the file at all, whatever the list says.
        docker exec "$client" pg_restore --file=/tmp/lb-nightly.sql /tmp/lb-nightly.dump
        if docker exec "$client" grep -q 'secret-name.pdf\|secret words' /tmp/lb-nightly.sql; then fail "a visitor's file name or words are in the backup"; else pass "no word of a visitor's contract is in the backup"; fi
    else
        fail "the nightly pg_dump, with the tables' rows left out, did not work"
    fi
fi

echo "Rotating a password takes effect on the next provisioning"
rotating="${systems%% *}"
old_password="$(password_of "$rotating")"
new_password="$(random_password)"
printf '%s' "$new_password" > "$scratch/password-$rotating"
mapfile -t passwords < <(system_passwords)
provision "${passwords[@]}" "LB_PG_PASSWORD_LBGATEWAY=$lbgateway_password" "LB_PG_PASSWORD_LBBACKUP=$lbbackup_password" >/dev/null
denied "the old password stops working" "$rotating" "$old_password" "SELECT 1" "password authentication failed"
allowed "the new password works" "$rotating" "$new_password" "SELECT 1"
echo "A password that is too weak or malformed stops the provisioner"
if provision "LB_PG_PASSWORD_${rotating^^}=short" >/dev/null 2>&1; then
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
