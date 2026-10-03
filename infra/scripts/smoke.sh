#!/bin/bash
# Checks a running stack from the inside, and exits 1 if anything is wrong. The deploy runs
# it after every release and rolls back on failure; `just stack-smoke` runs it on a local
# stack. It needs nothing but docker: every request is made from a container that is
# already there, so it needs no published port, no token and no secret.
#
#   1. Every long-running service is healthy, and the one-shot jobs (provisioning,
#      migrating, seeding and LB-05's data: the services whose restart policy is `no`)
#      finished cleanly.
#   2. Through Caddy, the way the tunnel comes in: the API's own routes reach their
#      service (LB-01, LB-02, LB-05 and LB-08 each ask for a visitor token), LB-02's
#      WebSocket upgrades, and the health checks, the OpenAPI schema and the rest of the
#      gateway are 404, as is any other Host.
#   3. Nothing leaves except through a proxy: from the gateway and from a Django container,
#      a raw connection to a public address and a public DNS lookup both fail, and the
#      proxy refuses a host that is not on its list. (Skipped where the proxies aren't
#      running, as in a local stack.)
#   4. No service was refused anything by Redis's ACL.
#   5. With --public (the deploy passes it on the box): one request through the API's own
#      public hostname, the way a visitor's browser comes in, which proves the tunnel and
#      Cloudflare's side as well. It must be answered with the 401 that asks for a token.
#
#   infra/scripts/smoke.sh [--public]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose="$here/compose.sh"
failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

echo "Services"
# One JSON object per container, including the ones that have finished.
containers="$("$compose" ps --all --format json)"
running_services="$(jq -r 'select(.State == "running") | .Service' <<<"$containers" | sort -u)"
# The one-shot jobs are the services that are not restarted: a new job needs no change here.
jobs="$("$compose" config --format json | jq -r '.services | to_entries[] | select((.value.restart // "no") == "no") | .key')"
# A '|' separates the fields: a tab would swallow the empty Health of a finished job.
while IFS='|' read -r service state health exit_code; do
    case "$service" in
        *-run-* | backup) ;;
        *)
            if grep -qx "$service" <<<"$jobs"; then
                if [ "$state" = exited ] && [ "$exit_code" = 0 ]; then pass "$service finished cleanly"; else fail "$service is $state (exit $exit_code), not finished cleanly"; fi
            elif [ "$state" = running ] && [ "$health" = healthy ]; then
                pass "$service is running and healthy"
            else
                fail "$service is $state ($health)"
            fi
            ;;
    esac
done < <(jq -r '[.Service, .State, .Health, (.ExitCode | tostring)] | join("|")' <<<"$containers")

echo "Through Caddy"
api_host="$("$compose" exec -T caddy printenv LB_API_HOST | tr -d '\r\n')"
# status <host> <path>: the HTTP status Caddy answers, asked from inside its own container.
status() {
    local host="$1" path="$2" output
    output="$("$compose" exec -T caddy wget -S -q -O /dev/null --header "Host: $host" "http://127.0.0.1:8080$path" 2>&1 || true)"
    grep -o 'HTTP/[0-9.]* [0-9]*' <<<"$output" | head -1 | awk '{print $2}'
}
expect_status() {
    local label="$1" expected="$2" host="$3" path="$4" actual
    actual="$(status "$host" "$path")"
    if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (expected $expected, got ${actual:-nothing})"; fi
}
expect_status "the root is 404" 404 "$api_host" /
expect_status "the Django health check is not exposed" 404 "$api_host" /api/healthz
expect_status "the OpenAPI schema is not exposed" 404 "$api_host" /api/openapi.json
expect_status "the gateway's model list is not exposed" 404 "$api_host" /v1/models
expect_status "another Host is refused" 404 "evil.invalid" /api/lb01/customers
expect_status "LB-01's API is reached, and asks for a visitor token" 401 "$api_host" /api/lb01/customers
expect_status "LB-02's API is reached, and asks for a visitor token" 401 "$api_host" /api/lb02/offerings
expect_status "LB-05's API is reached, and asks for a visitor token" 401 "$api_host" /api/lb05/quota
expect_status "LB-08's API is reached, and asks for a visitor token" 401 "$api_host" /api/lb08/limits
expect_status "LB-09's API is reached, and asks for a visitor token" 401 "$api_host" /api/lb09/limits

# LB-02's WebSocket, the way the site opens it: the upgrade must be accepted (101) through
# Caddy, which asks for the site's origin. The probe runs in the Django container, on the
# same network as Caddy, and closes before the hello the service waits for.
site_origin="$("$compose" exec -T caddy printenv LB_SITE_ORIGIN | tr -d '\r\n')"
websocket_probe="
import base64, os, socket, sys
host, origin = sys.argv[1], sys.argv[2]
key = base64.b64encode(os.urandom(16)).decode()
request = ('GET /ws/lb02/ HTTP/1.1\\r\\nHost: ' + host + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n'
           'Sec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\nOrigin: ' + origin + '\\r\\n\\r\\n')
try:
    with socket.create_connection(('caddy', 8080), timeout=5) as connection:
        connection.sendall(request.encode())
        print(connection.recv(200).split(b'\\r\\n')[0].decode())
except OSError as error:
    print('failed: ' + type(error).__name__)"
upgrade="$("$compose" exec -T django-api python -c "$websocket_probe" "$api_host" "$site_origin" 2>&1 | tail -1 | tr -d '\r')"
if [[ "$upgrade" == "HTTP/1.1 101"* ]]; then pass "LB-02's WebSocket is upgraded through Caddy"; else fail "LB-02's WebSocket answered '$upgrade', not 101"; fi

if [ "${1:-}" = "--public" ]; then
    echo "Through the public hostname"
    public_status=""
    # The tunnel can need a few seconds to carry traffic again after a restart.
    for _ in 1 2 3 4 5 6; do
        public_status="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "https://$api_host/api/lb01/customers" || true)"
        [ "$public_status" = 401 ] && break
        sleep 5
    done
    if [ "$public_status" = 401 ]; then
        pass "https://$api_host reaches LB-01's API, and asks for a visitor token"
    else
        fail "https://$api_host/api/lb01/customers answered ${public_status:-nothing}, not 401"
    fi
fi

echo "Nothing leaves except through a proxy"
if grep -qx 'egress-gateway' <<<"$running_services" && grep -qx 'egress-systems' <<<"$running_services"; then
    gateway_probe="
const net = require('node:net');
const dns = require('node:dns').promises;
const direct = new Promise(resolve => {
  const socket = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); resolve('connected'); });
  socket.on('error', () => resolve('blocked'));
  socket.on('timeout', () => { socket.destroy(); resolve('blocked'); });
});
const lookup = dns.lookup('example.com').then(() => 'resolved', () => 'blocked');
const proxied = fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => 'reached', () => 'refused');
Promise.all([direct, lookup, proxied]).then(results => console.log(results.join(' ')));"
    answer="$("$compose" exec -T gateway /nodejs/bin/node -e "$gateway_probe" 2>&1 | tail -1)"
    if [ "$answer" = "blocked blocked refused" ]; then
        pass "gateway: no direct connection, no public DNS, and its proxy refuses example.com"
    else
        fail "gateway: expected 'blocked blocked refused', got '$answer'"
    fi
    systems_probe="
import socket, urllib.request
try:
    socket.create_connection(('1.1.1.1', 443), timeout=3)
    direct = 'connected'
except OSError:
    direct = 'blocked'
try:
    socket.getaddrinfo('example.com', 443)
    lookup = 'resolved'
except OSError:
    lookup = 'blocked'
try:
    urllib.request.urlopen('https://api.groq.com/', timeout=5)
    proxied = 'reached'
except OSError:
    proxied = 'refused'
print(direct, lookup, proxied)"
    answer="$("$compose" exec -T django-api python -c "$systems_probe" 2>&1 | tail -1)"
    if [ "$answer" = "blocked blocked refused" ]; then
        pass "django: no direct connection, no public DNS, and its proxy refuses a model provider"
    else
        fail "django: expected 'blocked blocked refused', got '$answer'"
    fi
else
    echo "  skip  the egress proxies are not running in this stack"
fi

echo "Redis"
# The single quotes are deliberate: the password is expanded inside the container, where it lives.
# shellcheck disable=SC2016
acl_log="$("$compose" exec -T redis sh -c 'REDISCLI_AUTH="$LB_REDIS_PASSWORD_ADMIN" redis-cli --user admin --no-auth-warning acl log' | tr -d '\r')"
if [ -z "$acl_log" ]; then
    pass "Redis's ACL log is empty: no service was refused anything"
else
    fail "Redis refused something a service tried (see: just stack exec redis ... acl log):"
    printf '%s\n' "$acl_log" | grep -E -A1 '^(reason|object|username|context)$' | grep -v '^--$' | paste -sd' ' >&2
fi

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
