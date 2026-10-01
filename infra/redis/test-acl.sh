#!/bin/bash
# Proves the Redis ACL (docs/SECURITY.md, section 5) on a real Redis started from the same
# image, config, entrypoint and ACL template the box uses. Two proofs:
#
#  1. The production ACL, unchanged. Each user can do what its service does and nothing
#     else: allowed and refused commands, keys and channels, inside Lua scripts too, and
#     nobody gets in without a password. A table tries every service on every other
#     service's keys.
#
#  2. The services' own code against the same rules. The gateway's integration tests, the
#     lb-common span-writer tests, the gateway contract tests, LB-02's WebSocket consumer
#     tests (the Channels layer), LB-05's integration tests, LB-08's whole suite (BullMQ) and
#     a real Celery worker with its scheduler all run against a Redis whose ACL is the
#     production ACL with three additions, made mechanically below:
#       - every key and channel pattern under `lb:` is joined by the same pattern under
#         `lbtest-*:` (the tests write under random `lbtest-<hex>:` prefixes, while Celery
#         runs under the real `lb:`);
#       - LB-08's queue pattern is joined by `lbtest-*-bull:lb08-*`, because three of its
#         tests give a queue a prefix of its own (`<test prefix>doomed-`, `quiet-`, `sweep-`);
#       - each service user gets one extra selector for the commands the test harnesses use
#         to read back and clean up (KEYS, SCAN, DEL, XRANGE, TTL ...), which no service runs.
#     One user exists only in this proof, `node-and-gateway`: the two users' rules together,
#     for the three LB-08 test files that start the real gateway on the same Redis URL as the
#     Node service (eval-cli, generate-gateway, processes). Everything else in LB-08's suite
#     runs as `node-systems` alone. Afterwards Redis's own ACL LOG must be empty: any command,
#     key or channel a service needed and the ACL refused would be recorded there, even where
#     the service swallowed the error.
#
# It needs Docker, the repository's dependencies (`just install`) and Node, and cleans up
# everything it starts. The suites that need Postgres use a throwaway one: this proof is
# about Redis, and test-roles.sh is the one about Postgres.
#
#   infra/redis/test-acl.sh                  everything
#   infra/redis/test-acl.sh node django      only these steps of proof 2, after proof 1 (steps:
#                                            gateway, lb-common, django, flask, node, celery)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${LB_REDIS_IMAGE:-$("$here/../scripts/image-of.sh" redis)}"
postgres_image="${LB_POSTGRES_IMAGE:-$("$here/../scripts/image-of.sh" postgres)}"
prefix="${LB_TEST_PREFIX:-lb-redistest}-$$"
scratch="$(mktemp -d)"
failures=0
worker_pid=""
steps=("$@")

cleanup() {
    if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
    # The worker's pid file exists from the moment it starts, so a failure in between
    # can't leave one running.
    if [ -f "$scratch/worker.pid" ]; then kill "$(cat "$scratch/worker.pid")" 2>/dev/null || true; fi
    docker rm -f "$prefix-prod" "$prefix-twin" "$prefix-pg" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

random_password() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
declare -A password
for user in gateway django-systems flask-systems node-systems health admin; do
    password[$user]="$(random_password)"
done
postgres_password="$(random_password)"

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

# wanted <step>: true when no steps were asked for, or this one was.
wanted() {
    local step
    if [ "${#steps[@]}" -eq 0 ]; then return 0; fi
    for step in "${steps[@]}"; do
        if [ "$step" = "$1" ]; then return 0; fi
    done
    return 1
}

# Starts a Redis exactly as docker-compose.yml does (non-root, read-only, no capabilities,
# the production config and entrypoint), with the given ACL template. Prints nothing.
start_redis() {
    local name="$1" template="$2" publish="${3:-}"
    local publish_arguments=()
    if [ -n "$publish" ]; then publish_arguments=(-p 127.0.0.1::6379); fi
    docker run -d --name "$name" "${publish_arguments[@]}" --user 999:1000 --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --tmpfs /run/redis:mode=0700,uid=999,gid=1000,size=1m --tmpfs /data:uid=999,gid=1000,size=64m \
        -v "$here/redis.conf":/etc/redis/redis.conf:ro \
        -v "$template":/etc/redis/users.acl.tmpl:ro \
        -v "$here/entrypoint.sh":/usr/local/bin/lb-redis-entrypoint:ro \
        -e LB_REDIS_PASSWORD_GATEWAY="${password[gateway]}" -e LB_REDIS_PASSWORD_DJANGO_SYSTEMS="${password[django-systems]}" \
        -e LB_REDIS_PASSWORD_FLASK_SYSTEMS="${password[flask-systems]}" -e LB_REDIS_PASSWORD_NODE_SYSTEMS="${password[node-systems]}" \
        -e LB_REDIS_PASSWORD_HEALTH="${password[health]}" -e LB_REDIS_PASSWORD_ADMIN="${password[admin]}" \
        --entrypoint /usr/local/bin/lb-redis-entrypoint "$image" redis-server /etc/redis/redis.conf >/dev/null
    local ready=false
    for _ in $(seq 1 30); do
        if [ "$(docker exec -e REDISCLI_AUTH="${password[admin]}" "$name" redis-cli --user admin --no-auth-warning ping 2>/dev/null || true)" = "PONG" ]; then
            ready=true
            break
        fi
        sleep 0.5
    done
    if [ "$ready" != true ]; then
        docker logs "$name" >&2
        echo "$name did not become ready." >&2
        exit 1
    fi
}

# Starts a throwaway Postgres for the suites that need one, on a loopback port of its own, and
# prints its URL. It waits on TCP: while the image sets itself up, only the socket answers.
start_postgres() {
    docker run -d --name "$prefix-pg" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data \
        -e POSTGRES_USER=lb -e POSTGRES_PASSWORD="$postgres_password" -e POSTGRES_DB=lb \
        "$postgres_image" -c fsync=off -c max_connections=200 >/dev/null
    local ready=false
    for _ in $(seq 1 60); do
        if docker exec "$prefix-pg" pg_isready -h 127.0.0.1 -U lb -d lb -q 2>/dev/null; then
            ready=true
            break
        fi
        sleep 1
    done
    if [ "$ready" != true ]; then
        docker logs "$prefix-pg" >&2
        echo "The throwaway Postgres did not become ready." >&2
        exit 1
    fi
    printf 'postgres://lb:%s@127.0.0.1:%s/lb' "$postgres_password" "$(docker port "$prefix-pg" 5432/tcp | head -1 | sed 's/.*://')"
}

# cli <container> <user> <password> <command...>: runs one command as a user and prints the answer.
cli() {
    local name="$1" user="$2" secret="$3"
    shift 3
    docker exec -e REDISCLI_AUTH="$secret" "$name" redis-cli --user "$user" --no-auth-warning "$@" 2>&1
}

# allowed <label> <user> <password> <command...> must answer without an error.
allowed() {
    local label="$1" user="$2" secret="$3" output
    shift 3
    output="$(cli "$prefix-prod" "$user" "$secret" "$@")"
    if grep -Eq '^(NOPERM|NOAUTH|WRONGPASS|ERR )' <<<"$output"; then fail "$label -- $output"; else pass "$label"; fi
}

# refused <label> <user> <password> <command...> must be refused by the ACL (NOPERM).
refused() {
    local label="$1" user="$2" secret="$3" output
    shift 3
    output="$(cli "$prefix-prod" "$user" "$secret" "$@")"
    if grep -Eq '^(NOPERM|ERR ACL failure)' <<<"$output"; then pass "$label"; else fail "$label -- answered: $output"; fi
}

# acl_log_is_empty <container> <label>: Redis records every refused command, key and channel.
acl_log_is_empty() {
    local entries
    entries="$(cli "$1" admin "${password[admin]}" acl log)"
    if [ -z "$entries" ]; then
        pass "$2"
    else
        fail "$2 -- the ACL refused something a service needed:"
        printf '%s\n' "$entries" | grep -E -A1 '^(reason|object|username|context)$' | grep -v '^--$' | paste -sd' ' >&2
    fi
}

# run_suite <label> <log> <command...>: runs a service's own tests from the repository root
# (put variables in front of the command with `env`), and passes when they do, saying how many
# ran (pytest's and Vitest's summary line). A failure shows the end of the log.
run_suite() {
    local label="$1" log="$2" summary
    shift 2
    if (cd "$repo" && "$@" >"$log" 2>&1); then
        summary="$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ *(Tests +)?[0-9]+ passed' | tail -1 | sed -E 's/^ +//')"
        pass "$label${summary:+ ($summary)}"
    else
        fail "$label"
        tail -30 "$log" >&2
    fi
}

echo "Starting Redis with the production ACL ($image)"
start_redis "$prefix-prod" "$here/users.acl.tmpl"

echo "1. The production ACL"
echo "Nobody gets in without a password"
output="$(docker exec "$prefix-prod" redis-cli ping 2>&1)"
if grep -q NOAUTH <<<"$output"; then pass "an unauthenticated connection is refused"; else fail "an unauthenticated connection was served: $output"; fi
output="$(cli "$prefix-prod" default anything ping)"
if grep -q WRONGPASS <<<"$output"; then pass "the default user is switched off"; else fail "the default user can log in: $output"; fi
output="$(cli "$prefix-prod" gateway wrong-password ping)"
if grep -q WRONGPASS <<<"$output"; then pass "a wrong password is refused"; else fail "a wrong password was accepted: $output"; fi
echo "The health check can only ping"
allowed "health: PING" health "${password[health]}" ping
refused "health: GET" health "${password[health]}" get lb:gw:meter:x
echo "The gateway keeps its meters and its spans, and nothing else"
allowed "gateway: moves a meter" gateway "${password[gateway]}" incrbyfloat lb:gw:meter:model:a/b:requests:d:1 1
allowed "gateway: reads meters with MGET" gateway "${password[gateway]}" mget lb:gw:meter:model:a/b:requests:d:1
allowed "gateway: runs the meter script's commands inside EVAL" gateway "${password[gateway]}" \
    eval "redis.call('incrbyfloat', KEYS[1], 1) redis.call('expire', KEYS[1], 60) return redis.call('get', KEYS[1])" 1 lb:gw:meter:run:x
allowed "gateway: appends to a run's span stream" gateway "${password[gateway]}" xadd lb:run:run-0000001:spans '*' span '{}'
allowed "gateway: sets that stream's expiry" gateway "${password[gateway]}" expire lb:run:run-0000001:spans 86400
allowed "gateway: reads a run's span stream (the Scope route)" gateway "${password[gateway]}" xrange lb:run:run-0000001:spans - +
allowed "gateway: appends to the all-runs stream" gateway "${password[gateway]}" xadd lb:spans '*' span '{}'
refused "gateway: cannot SET a meter" gateway "${password[gateway]}" set lb:gw:meter:x 1
refused "gateway: cannot read the all-runs stream" gateway "${password[gateway]}" xrange lb:spans - +
refused "gateway: cannot expire or delete the all-runs stream" gateway "${password[gateway]}" expire lb:spans 1
refused "gateway: cannot read keys outside its prefixes" gateway "${password[gateway]}" get something:else
refused "gateway: cannot list keys" gateway "${password[gateway]}" keys '*'
refused "gateway: cannot flush" gateway "${password[gateway]}" flushall
refused "gateway: cannot read the configuration" gateway "${password[gateway]}" config get dir
refused "gateway: cannot read the ACL" gateway "${password[gateway]}" acl list
refused "gateway: cannot run FLUSHALL inside a script" gateway "${password[gateway]}" eval "return redis.call('flushall')" 1 lb:gw:meter:x
refused "gateway: cannot read another service's key inside a script" gateway "${password[gateway]}" \
    eval "return redis.call('get', 'lb:celery:x')" 1 lb:gw:meter:x
echo "The Django systems keep Celery's keys and channels, LB-02's channel layer, and append spans"
allowed "django-systems: queues a Celery message" django-systems "${password[django-systems]}" lpush lb:celery:celery x
allowed "django-systems: takes it off the queue" django-systems "${password[django-systems]}" rpop lb:celery:celery
allowed "django-systems: keeps unacknowledged messages" django-systems "${password[django-systems]}" hset lb:celery:unacked tag message
allowed "django-systems: publishes on a Celery channel" django-systems "${password[django-systems]}" publish lb:celery:/0.celeryev/worker.heartbeat x
allowed "django-systems: appends a span" django-systems "${password[django-systems]}" xadd lb:run:run-0000002:spans '*' span '{}'
allowed "django-systems: appends to the all-runs stream" django-systems "${password[django-systems]}" xadd lb:spans '*' span '{}'
allowed "django-systems: queues a channel-layer message" django-systems "${password[django-systems]}" zadd 'lb:channels:specific.abc!' 1 message
allowed "django-systems: counts a channel's messages" django-systems "${password[django-systems]}" zcount 'lb:channels:specific.abc!' -inf +inf
allowed "django-systems: expires a channel" django-systems "${password[django-systems]}" expire 'lb:channels:specific.abc!' 60
allowed "django-systems: waits for a channel's next message" django-systems "${password[django-systems]}" bzpopmin 'lb:channels:specific.abc!' 0.01
allowed "django-systems: runs the channel layer's recovery script (the keys are arguments)" django-systems "${password[django-systems]}" \
    eval "local held = redis.call('ZRANGE', ARGV[2], 0, -1, 'WITHSCORES') for i = #held, 1, -2 do redis.call('ZADD', ARGV[1], held[i], held[i - 1]) end redis.call('DEL', ARGV[2])" \
    0 'lb:channels:specific.abc!' "lb:channels:specific.abc!\$inflight"
refused "django-systems: cannot read the gateway's budgets" django-systems "${password[django-systems]}" get lb:gw:meter:run:x
refused "django-systems: cannot write the gateway's budgets" django-systems "${password[django-systems]}" incrbyfloat lb:gw:meter:run:x 1
refused "django-systems: cannot read a span stream" django-systems "${password[django-systems]}" xrange lb:run:run-0000002:spans - +
refused "django-systems: cannot delete the all-runs stream" django-systems "${password[django-systems]}" del lb:spans
refused "django-systems: cannot publish outside Celery's channels" django-systems "${password[django-systems]}" publish other:channel x
refused "django-systems: cannot list keys" django-systems "${password[django-systems]}" keys '*'
refused "django-systems: cannot flush" django-systems "${password[django-systems]}" flushall
refused "django-systems: cannot read a channel with a command the layer never uses" django-systems "${password[django-systems]}" get 'lb:channels:specific.abc!'
refused "django-systems: cannot reach keys beside the channel prefix" django-systems "${password[django-systems]}" zadd lb:channelsx:abc 1 message
refused "django-systems: cannot read LB-08's queues from a channel script" django-systems "${password[django-systems]}" \
    eval "return redis.call('zrange', 'lb:bull:lb08-steps:delayed', 0, -1)" 0
echo "LB-05's Flask service appends spans and has nothing else"
allowed "flask-systems: appends a span" flask-systems "${password[flask-systems]}" xadd lb:run:run-0000003:spans '*' span '{}'
allowed "flask-systems: sets that stream's expiry" flask-systems "${password[flask-systems]}" expire lb:run:run-0000003:spans 86400
allowed "flask-systems: appends to the all-runs stream" flask-systems "${password[flask-systems]}" xadd lb:spans '*' span '{}'
refused "flask-systems: cannot read a span stream" flask-systems "${password[flask-systems]}" xrange lb:run:run-0000003:spans - +
refused "flask-systems: cannot delete the all-runs stream" flask-systems "${password[flask-systems]}" del lb:spans
refused "flask-systems: cannot run a script" flask-systems "${password[flask-systems]}" eval "return 1" 0
refused "flask-systems: cannot list keys" flask-systems "${password[flask-systems]}" keys '*'
refused "flask-systems: cannot flush" flask-systems "${password[flask-systems]}" flushall
echo "LB-08's Node service keeps its BullMQ queues, and appends spans"
allowed "node-systems: reads Redis's version, as BullMQ does" node-systems "${password[node-systems]}" info server
allowed "node-systems: names its connection" node-systems "${password[node-systems]}" client setname lb08-test
allowed "node-systems: queues a job" node-systems "${password[node-systems]}" lpush lb:bull:lb08-steps:wait run__node
allowed "node-systems: schedules a retry" node-systems "${password[node-systems]}" zadd lb:bull:lb08-steps:delayed 1 run__node
allowed "node-systems: records a queue event" node-systems "${password[node-systems]}" xadd lb:bull:lb08-steps:events '*' event added
allowed "node-systems: waits on the queue's marker" node-systems "${password[node-systems]}" bzpopmin lb:bull:lb08-maintenance:marker 0.01
allowed "node-systems: runs a queue script on a dead-letter job" node-systems "${password[node-systems]}" \
    eval "redis.call('hset', KEYS[1], 'name', 'x') return redis.call('hget', KEYS[1], 'name')" 1 lb:bull:lb08-dead-letters:1
allowed "node-systems: appends a span" node-systems "${password[node-systems]}" xadd lb:run:run-0000004:spans '*' span '{}'
allowed "node-systems: appends to the all-runs stream" node-systems "${password[node-systems]}" xadd lb:spans '*' span '{}'
refused "node-systems: cannot touch another queue under the same prefix" node-systems "${password[node-systems]}" lpush lb:bull:other-queue:wait x
refused "node-systems: cannot read a span stream" node-systems "${password[node-systems]}" xrange lb:run:run-0000004:spans - +
refused "node-systems: cannot delete the all-runs stream" node-systems "${password[node-systems]}" del lb:spans
refused "node-systems: cannot list keys, not even its own" node-systems "${password[node-systems]}" keys 'lb:bull:*'
refused "node-systems: cannot flush" node-systems "${password[node-systems]}" flushall
refused "node-systems: cannot empty the script cache" node-systems "${password[node-systems]}" script flush
refused "node-systems: cannot read the configuration" node-systems "${password[node-systems]}" config get dir
refused "node-systems: cannot run FLUSHALL inside a queue script" node-systems "${password[node-systems]}" \
    eval "return redis.call('flushall')" 1 lb:bull:lb08-steps:x
refused "node-systems: cannot reach Celery's queue inside a queue script" node-systems "${password[node-systems]}" \
    eval "return redis.call('lpush', 'lb:celery:celery', 'x')" 1 lb:bull:lb08-steps:x

# Each family of keys, tried by every service with the family's one ordinary write: only the
# service(s) that own it get through. Anything a service gains by accident shows here.
echo "Each service reaches its own keys and nobody else's"
declare -A owners=(
    [meters]="gateway"
    [celery]="django-systems"
    [channels]="django-systems"
    [bull]="node-systems"
    [spans]="gateway django-systems flask-systems node-systems"
)
declare -A ordinary_write=(
    [meters]="incrbyfloat lb:gw:meter:table 1"
    [celery]="lpush lb:celery:table x"
    [channels]="zadd lb:channels:specific.table! 1 x"
    [bull]="lpush lb:bull:lb08-steps:table x"
    [spans]="xadd lb:run:run-table:spans * span {}"
)
for family in meters celery channels bull spans; do
    read -r -a write_words <<<"${ordinary_write[$family]}"
    for user in gateway django-systems flask-systems node-systems; do
        if [[ " ${owners[$family]} " == *" $user "* ]]; then
            allowed "$user: writes the $family keys (its own)" "$user" "${password[$user]}" "${write_words[@]}"
        else
            refused "$user: cannot write the $family keys" "$user" "${password[$user]}" "${write_words[@]}"
        fi
    done
done
echo "Only the owner's user can administer, and DEBUG stays off"
allowed "admin: reads the ACL" admin "${password[admin]}" acl list
output="$(cli "$prefix-prod" admin "${password[admin]}" debug sleep 0)"
if grep -q 'DEBUG command not allowed' <<<"$output"; then pass "admin: DEBUG is switched off"; else fail "admin: DEBUG is available: $output"; fi

echo "2. The services' own code against the same rules"
# The same fold the entrypoint does, then the three additions described at the top.
awk '{ if (sub(/\\$/, "")) { printf "%s", $0 } else { print } }' "$here/users.acl.tmpl" \
    | sed -E 's/[[:space:]]+/ /g; s/^ //' \
    | sed -E 's/~lb:bull:lb08-\*/& ~lbtest-*-bull:lb08-*/' \
    | sed -E 's/([~&])lb:([^ )]*)/\1lb:\2 \1lbtest-*:\2/g' \
    | sed -E '/^user (gateway|django-systems|flask-systems|node-systems) /s/$/ (~lbtest-* +keys +scan +del +unlink +xrange +xrevrange +xlen +ttl +get +type +exists)/' \
    > "$scratch/twin.acl.tmpl"
# The proof's one extra user: the Node service's rules and the gateway's, together (see the top).
node_rules="$(sed -nE 's/^user node-systems on #[^ ]+ //p' "$scratch/twin.acl.tmpl")"
gateway_rules="$(sed -nE 's/^user gateway on #[^ ]+ resetkeys resetchannels -@all //p' "$scratch/twin.acl.tmpl")"
printf 'user node-and-gateway on #__HASH_NODE_SYSTEMS__ %s %s\n' "$node_rules" "$gateway_rules" >> "$scratch/twin.acl.tmpl"
start_redis "$prefix-twin" "$scratch/twin.acl.tmpl" publish
port="$(docker port "$prefix-twin" 6379/tcp | head -1 | sed 's/.*://')"
gateway_url="redis://gateway:${password[gateway]}@127.0.0.1:$port"
django_url="redis://django-systems:${password[django-systems]}@127.0.0.1:$port"
flask_url="redis://flask-systems:${password[flask-systems]}@127.0.0.1:$port"
node_url="redis://node-systems:${password[node-systems]}@127.0.0.1:$port"
node_and_gateway_url="redis://node-and-gateway:${password[node-systems]}@127.0.0.1:$port"
database_url=""
if wanted django || wanted flask || wanted node; then database_url="$(start_postgres)"; fi

if wanted gateway; then
    echo "The gateway's integration tests (budgets, quotas, spans, fallback, streaming)"
    run_suite "the gateway's integration tests pass as the gateway user" "$scratch/gateway.log" \
        env LB_TEST_REDIS_URL="$gateway_url" pnpm --filter @lb/gateway exec vitest run --project integration
fi

if wanted lb-common; then
    echo "lb-common: the span writer as the Django user, the gateway contract tests as the gateway user"
    run_suite "the span writer's tests pass as the django-systems user" "$scratch/lbcommon-writer.log" \
        env LB_TEST_REDIS_URL="$django_url" uv run pytest python/lb-common/tests/integration/test_tracing_redis.py -q
    run_suite "the gateway contract tests pass as the gateway user" "$scratch/lbcommon-contract.log" \
        env LB_TEST_REDIS_URL="$gateway_url" uv run pytest python/lb-common/tests/integration/test_gateway_contract.py -q
fi

if wanted django; then
    echo "LB-02's WebSocket consumers on the Redis channel layer, as the Django user"
    run_suite "the consumer tests pass as the django-systems user" "$scratch/django.log" \
        env LB_TEST_REDIS_URL="$django_url" LB_TEST_DATABASE_URL="$database_url" \
        uv run --directory services/django-systems pytest tests/integration/test_lb02_consumer.py -q -p no:cacheprovider
fi

if wanted flask; then
    echo "LB-05's integration tests (run spans), as the Flask user"
    run_suite "the Flask integration tests pass as the flask-systems user" "$scratch/flask.log" \
        env LB_TEST_REDIS_URL="$flask_url" LB_TEST_DATABASE_URL="$database_url" \
        uv run --directory services/flask-systems pytest tests/integration -q -p no:cacheprovider
fi

if wanted node; then
    echo "LB-08's suite (BullMQ queues, retries, a dying worker, the sweep, run spans)"
    # These three start the real gateway on the Redis URL they are given, which is the same one
    # the Node service gets, so they run as the combined user; the rest run as node-systems.
    with_gateway=(test/integration/eval-cli.test.ts test/integration/generate-gateway.test.ts test/integration/processes.test.ts)
    exclusions=()
    for file in "${with_gateway[@]}"; do exclusions+=(--exclude "$file"); done
    run_suite "LB-08's suite passes as the node-systems user" "$scratch/node.log" \
        env LB_TEST_REDIS_URL="$node_url" LB_TEST_DATABASE_URL="$database_url" \
        pnpm --filter @lb/node-systems exec vitest run "${exclusions[@]}"
    run_suite "LB-08's tests that run the real gateway pass as node-and-gateway" "$scratch/node-gateway.log" \
        env LB_TEST_REDIS_URL="$node_and_gateway_url" LB_TEST_DATABASE_URL="$database_url" \
        pnpm --filter @lb/node-systems exec vitest run "${with_gateway[@]}"
fi

if wanted celery; then
    echo "A real Celery worker with its scheduler, as the Django user"
    (
        cd "$repo/services/django-systems"
        export DJANGO_SECRET_KEY="redis-acl-test-only-secret-key-redis-acl-test-only-secret"
        export DJANGO_ALLOWED_HOSTS=localhost
        # Nothing listens here: the task fails at the database after Redis has done its part.
        export LB_DATABASE_URL=postgres://nobody:nothing@127.0.0.1:1/lb
        export LB_REDIS_URL="$django_url/0"
        uv run celery -A config worker --beat --loglevel INFO --concurrency 1 \
            --schedule "$scratch/celerybeat-schedule" >"$scratch/worker.log" 2>&1 &
        echo $! > "$scratch/worker.pid"
        for _ in $(seq 1 40); do
            if grep -q "ready\." "$scratch/worker.log" 2>/dev/null; then break; fi
            sleep 0.5
        done
        uv run celery -A config call lb01.sweep_expired_tickets >"$scratch/call.log" 2>&1 || true
        sleep 3
        uv run celery -A config inspect ping -t 5 >"$scratch/ping.log" 2>&1 || true
    )
    worker_pid="$(cat "$scratch/worker.pid")"
    if grep -q "pong" "$scratch/ping.log"; then pass "the worker answers 'inspect ping' (remote control over pub/sub)"; else fail "the worker did not answer 'inspect ping'"; cat "$scratch/ping.log" >&2; fi
    if grep -q "Task lb01.sweep_expired_tickets.*received" "$scratch/worker.log"; then pass "the worker received the task through the queue"; else fail "the worker never received the task"; tail -20 "$scratch/worker.log" >&2; fi
    if grep -q "beat: Starting" "$scratch/worker.log"; then pass "the scheduler started"; else fail "the scheduler did not start"; fi
    kill -TERM "$worker_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
        if ! kill -0 "$worker_pid" 2>/dev/null; then break; fi
        sleep 0.5
    done
    worker_pid=""
fi

acl_log_is_empty "$prefix-twin" "Redis's ACL LOG is empty: no service was refused anything it needed"

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
