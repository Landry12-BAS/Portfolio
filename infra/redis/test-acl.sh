#!/bin/bash
# Proves the Redis ACL (docs/SECURITY.md, section 5) on a real Redis started from the same
# image, config, entrypoint and ACL template the box uses. Two proofs:
#
#  1. The production ACL, unchanged. Each user can do what its service does and nothing
#     else: allowed and refused commands, keys and channels, inside Lua scripts too, and
#     nobody gets in without a password.
#
#  2. The services' own code against the same rules. The gateway's integration tests, the
#     lb-common span-writer tests, the gateway contract tests and a real Celery worker with
#     its scheduler all run against a Redis whose ACL is the production ACL with exactly two
#     additions, made mechanically below: every key and channel pattern under `lb:` is
#     joined by the same pattern under `lbtest-*:` (the tests write under random
#     `lbtest-<hex>:` prefixes, while Celery runs under the real `lb:`), and the two service
#     users get one extra selector for the commands the test harnesses use to read back and
#     clean up (KEYS, SCAN, DEL, XRANGE, TTL ...), which no service runs. Afterwards Redis's own
#     ACL LOG must be empty: any command, key or channel a service needed and the ACL
#     refused would be recorded there, even where the service swallowed the error.
#
# It needs Docker, the repository's dependencies (`just install`) and Node, and cleans up
# everything it starts.
#
#   infra/redis/test-acl.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${LB_REDIS_IMAGE:-$("$here/../scripts/image-of.sh" redis)}"
prefix="${LB_TEST_PREFIX:-lb-redistest}-$$"
scratch="$(mktemp -d)"
failures=0
worker_pid=""

cleanup() {
    if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
    # The worker's pid file exists from the moment it starts, so a failure in between
    # can't leave one running.
    if [ -f "$scratch/worker.pid" ]; then kill "$(cat "$scratch/worker.pid")" 2>/dev/null || true; fi
    docker rm -f "$prefix-prod" "$prefix-twin" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

random_password() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
gateway_password="$(random_password)"
django_password="$(random_password)"
health_password="$(random_password)"
admin_password="$(random_password)"

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
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
        -e LB_REDIS_PASSWORD_GATEWAY="$gateway_password" -e LB_REDIS_PASSWORD_DJANGO_SYSTEMS="$django_password" \
        -e LB_REDIS_PASSWORD_HEALTH="$health_password" -e LB_REDIS_PASSWORD_ADMIN="$admin_password" \
        --entrypoint /usr/local/bin/lb-redis-entrypoint "$image" redis-server /etc/redis/redis.conf >/dev/null
    local ready=false
    for _ in $(seq 1 30); do
        if [ "$(docker exec -e REDISCLI_AUTH="$admin_password" "$name" redis-cli --user admin --no-auth-warning ping 2>/dev/null || true)" = "PONG" ]; then
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

# cli <container> <user> <password> <command...>: runs one command as a user and prints the answer.
cli() {
    local name="$1" user="$2" password="$3"
    shift 3
    docker exec -e REDISCLI_AUTH="$password" "$name" redis-cli --user "$user" --no-auth-warning "$@" 2>&1
}

# allowed <label> <user> <password> <command...> must answer without an error.
allowed() {
    local label="$1" user="$2" password="$3" output
    shift 3
    output="$(cli "$prefix-prod" "$user" "$password" "$@")"
    if grep -Eq '^(NOPERM|NOAUTH|WRONGPASS|ERR )' <<<"$output"; then fail "$label -- $output"; else pass "$label"; fi
}

# refused <label> <user> <password> <command...> must be refused by the ACL (NOPERM).
refused() {
    local label="$1" user="$2" password="$3" output
    shift 3
    output="$(cli "$prefix-prod" "$user" "$password" "$@")"
    if grep -Eq '^(NOPERM|ERR ACL failure)' <<<"$output"; then pass "$label"; else fail "$label -- answered: $output"; fi
}

# acl_log_is_empty <container> <label>: Redis records every refused command, key and channel.
acl_log_is_empty() {
    local entries
    entries="$(cli "$1" admin "$admin_password" acl log)"
    if [ -z "$entries" ]; then
        pass "$2"
    else
        fail "$2 -- the ACL refused something a service needed:"
        printf '%s\n' "$entries" | grep -E -A1 '^(reason|object|username|context)$' | grep -v '^--$' | paste -sd' ' >&2
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
allowed "health: PING" health "$health_password" ping
refused "health: GET" health "$health_password" get lb:gw:meter:x
echo "The gateway keeps its meters and its spans, and nothing else"
allowed "gateway: moves a meter" gateway "$gateway_password" incrbyfloat lb:gw:meter:model:a/b:requests:d:1 1
allowed "gateway: reads meters with MGET" gateway "$gateway_password" mget lb:gw:meter:model:a/b:requests:d:1
allowed "gateway: runs the meter script's commands inside EVAL" gateway "$gateway_password" \
    eval "redis.call('incrbyfloat', KEYS[1], 1) redis.call('expire', KEYS[1], 60) return redis.call('get', KEYS[1])" 1 lb:gw:meter:run:x
allowed "gateway: appends to a run's span stream" gateway "$gateway_password" xadd lb:run:run-0000001:spans '*' span '{}'
allowed "gateway: sets that stream's expiry" gateway "$gateway_password" expire lb:run:run-0000001:spans 86400
allowed "gateway: reads a run's span stream (the Scope route)" gateway "$gateway_password" xrange lb:run:run-0000001:spans - +
allowed "gateway: appends to the all-runs stream" gateway "$gateway_password" xadd lb:spans '*' span '{}'
refused "gateway: cannot SET a meter" gateway "$gateway_password" set lb:gw:meter:x 1
refused "gateway: cannot read the all-runs stream" gateway "$gateway_password" xrange lb:spans - +
refused "gateway: cannot expire or delete the all-runs stream" gateway "$gateway_password" expire lb:spans 1
refused "gateway: cannot touch Celery's queue" gateway "$gateway_password" lpush lb:celery:celery x
refused "gateway: cannot read keys outside its prefixes" gateway "$gateway_password" get something:else
refused "gateway: cannot list keys" gateway "$gateway_password" keys '*'
refused "gateway: cannot flush" gateway "$gateway_password" flushall
refused "gateway: cannot read the configuration" gateway "$gateway_password" config get dir
refused "gateway: cannot read the ACL" gateway "$gateway_password" acl list
refused "gateway: cannot run FLUSHALL inside a script" gateway "$gateway_password" eval "return redis.call('flushall')" 1 lb:gw:meter:x
refused "gateway: cannot read another service's key inside a script" gateway "$gateway_password" \
    eval "return redis.call('get', 'lb:celery:x')" 1 lb:gw:meter:x
echo "The Django systems keep Celery's keys and channels, and append spans"
allowed "django-systems: queues a Celery message" django-systems "$django_password" lpush lb:celery:celery x
allowed "django-systems: takes it off the queue" django-systems "$django_password" rpop lb:celery:celery
allowed "django-systems: keeps unacknowledged messages" django-systems "$django_password" hset lb:celery:unacked tag message
allowed "django-systems: publishes on a Celery channel" django-systems "$django_password" publish lb:celery:/0.celeryev/worker.heartbeat x
allowed "django-systems: appends a span" django-systems "$django_password" xadd lb:run:run-0000002:spans '*' span '{}'
allowed "django-systems: appends to the all-runs stream" django-systems "$django_password" xadd lb:spans '*' span '{}'
refused "django-systems: cannot read the gateway's budgets" django-systems "$django_password" get lb:gw:meter:run:x
refused "django-systems: cannot write the gateway's budgets" django-systems "$django_password" incrbyfloat lb:gw:meter:run:x 1
refused "django-systems: cannot read a span stream" django-systems "$django_password" xrange lb:run:run-0000002:spans - +
refused "django-systems: cannot delete the all-runs stream" django-systems "$django_password" del lb:spans
refused "django-systems: cannot publish outside Celery's channels" django-systems "$django_password" publish other:channel x
refused "django-systems: cannot list keys" django-systems "$django_password" keys '*'
refused "django-systems: cannot flush" django-systems "$django_password" flushall
echo "Only the owner's user can administer, and DEBUG stays off"
allowed "admin: reads the ACL" admin "$admin_password" acl list
output="$(cli "$prefix-prod" admin "$admin_password" debug sleep 0)"
if grep -q 'DEBUG command not allowed' <<<"$output"; then pass "admin: DEBUG is switched off"; else fail "admin: DEBUG is available: $output"; fi

echo "2. The services' own code against the same rules"
# The same fold the entrypoint does, then the two additions described at the top.
awk '{ if (sub(/\\$/, "")) { printf "%s", $0 } else { print } }' "$here/users.acl.tmpl" \
    | sed -E 's/[[:space:]]+/ /g; s/^ //' \
    | sed -E 's/([~&])lb:([^ )]*)/\1lb:\2 \1lbtest-*:\2/g' \
    | sed -E '/^user (gateway|django-systems) /s/$/ (~lbtest-* +keys +scan +del +unlink +xrange +xrevrange +xlen +ttl +get +type +exists)/' \
    > "$scratch/twin.acl.tmpl"
start_redis "$prefix-twin" "$scratch/twin.acl.tmpl" publish
port="$(docker port "$prefix-twin" 6379/tcp | head -1 | sed 's/.*://')"
gateway_url="redis://gateway:$gateway_password@127.0.0.1:$port"
django_url="redis://django-systems:$django_password@127.0.0.1:$port"

echo "The gateway's integration tests (budgets, quotas, spans, fallback, streaming)"
if (cd "$repo" && LB_TEST_REDIS_URL="$gateway_url" pnpm --filter @lb/gateway exec vitest run --project integration >"$scratch/gateway.log" 2>&1); then
    pass "the gateway's integration tests pass as the gateway user"
else
    fail "the gateway's integration tests failed as the gateway user"
    tail -30 "$scratch/gateway.log" >&2
fi
echo "lb-common: the span writer as the Django user, the gateway contract tests as the gateway user"
if (cd "$repo" && LB_TEST_REDIS_URL="$django_url" uv run pytest python/lb-common/tests/integration/test_tracing_redis.py -q >"$scratch/lbcommon-writer.log" 2>&1); then
    pass "the span writer's tests pass as the django-systems user"
else
    fail "the span writer's tests failed as the django-systems user"
    tail -30 "$scratch/lbcommon-writer.log" >&2
fi
if (cd "$repo" && LB_TEST_REDIS_URL="$gateway_url" uv run pytest python/lb-common/tests/integration/test_gateway_contract.py -q >"$scratch/lbcommon-contract.log" 2>&1); then
    pass "the gateway contract tests pass as the gateway user"
else
    fail "the gateway contract tests failed as the gateway user"
    tail -30 "$scratch/lbcommon-contract.log" >&2
fi

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

acl_log_is_empty "$prefix-twin" "Redis's ACL LOG is empty: no service was refused anything it needed"

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
