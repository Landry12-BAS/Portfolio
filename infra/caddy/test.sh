#!/bin/bash
# Proves the Caddy edge (docs/SECURITY.md, sections 1 and 5) with the real Caddy image and
# the repository's Caddyfile, in front of two stand-in services (test-upstream.py):
#
#   - only the routes the Caddyfile lists reach a service; health checks, the OpenAPI
#     schema and the rest of the gateway answer 404 from Caddy itself;
#   - paths built to slip past the allowlist (dot segments, escaped slashes) never reach
#     a route they shouldn't;
#   - only the API's own Host is served;
#   - bodies over the limit are refused; CORS and WebSocket origins are limited to the site;
#   - server-sent events arrive as they are written, and a WebSocket upgrade passes through;
#   - every response carries HSTS and none names the software behind it;
#   - the access log holds no query string, no request header and no visitor address;
#   - a service that is down gives a JSON 502, and the health listener is private.
#
# It needs Docker and python3, and cleans up everything it starts.
#
#   infra/caddy/test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
caddy_image="${LB_CADDY_IMAGE:-$("$here/../scripts/image-of.sh" caddy)}"
# The stand-in services run on the same Python the Django image is built on.
python_image="${LB_PYTHON_IMAGE:-$(awk '/^FROM python/ {print $2; exit}' "$repo/infra/docker/django-systems.Dockerfile")}"
prefix="${LB_TEST_PREFIX:-lb-caddytest}-$$"
network="$prefix-net"
api_host=api.lb.test
site_origin=https://site.lb.test
scratch="$(mktemp -d)"
failures=0

cleanup() {
    docker rm -f "$prefix-caddy" "$prefix-django" "$prefix-gateway" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

docker network create "$network" >/dev/null
for pair in "django:django-api:8000" "gateway:gateway:8080"; do
    IFS=: read -r name alias port_number <<<"$pair"
    docker run -d --name "$prefix-$name" --network "$network" --network-alias "$alias" \
        -e UPSTREAM_NAME="$name" -e UPSTREAM_PORT="$port_number" \
        -v "$here/test-upstream.py":/test-upstream.py:ro \
        "$python_image" python -u /test-upstream.py >/dev/null
done
# Caddy as docker-compose.yml runs it: non-root, read-only, and no capabilities but the one
# the official binary's file capability needs before the kernel will start it (the port
# it listens on, 8080, is above 1024, so it is never used).
docker run -d --name "$prefix-caddy" --network "$network" -p 127.0.0.1::8080 \
    --user 65532:65532 --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
    --tmpfs /data:uid=65532,gid=65532 --tmpfs /config:uid=65532,gid=65532 \
    -e LB_API_HOST="$api_host" -e LB_SITE_ORIGIN="$site_origin" \
    -v "$here/Caddyfile":/etc/caddy/Caddyfile:ro "$caddy_image" >/dev/null
port=""
for _ in $(seq 1 40); do
    port="$(docker port "$prefix-caddy" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
    if [ -n "$port" ] && curl -s -m 2 -o /dev/null -H "Host: $api_host" "http://127.0.0.1:$port/"; then break; fi
    sleep 0.5
done
if [ -z "$port" ]; then
    docker logs "$prefix-caddy" >&2
    echo "Caddy did not start." >&2
    exit 1
fi

# call <method> <path> [curl arguments...]: sends one request with the API's Host, and sets
# $status, $body and the headers file. --path-as-is keeps curl from tidying dot segments.
call() {
    local method="$1" path="$2" host_arguments=(-H "Host: $api_host")
    shift 2
    # A test that sends a Host of its own replaces the API's.
    case " $* " in *" Host: "*) host_arguments=() ;; esac
    status="$(curl -sS -m 10 --path-as-is -X "$method" -o "$scratch/body" -D "$scratch/headers" -w '%{http_code}' \
        "${host_arguments[@]}" "$@" "http://127.0.0.1:$port$path" 2>/dev/null || true)"
    body="$(cat "$scratch/body" 2>/dev/null || true)"
}

# The echo names the service that answered, so "reached django" is one comparison.
reached() { grep -q "\"upstream\": \"$1\"" <<<"$body"; }
header_of() { grep -i "^$1:" "$scratch/headers" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ //' || true; }
caddy_404() { [ "$status" = 404 ] && grep -q 'There is nothing at this address' <<<"$body"; }

# check <label> <command...>: passes when the command succeeds.
check() {
    local label="$1"
    shift
    if "$@"; then pass "$label"; else fail "$label (status $status, body: ${body:0:160})"; fi
}

echo "Only the listed routes reach a service"
call GET /; check "the root answers 404 from Caddy" caddy_404
for path in /api/healthz /api/readyz /api/openapi.json /healthz /readyz /metrics /admin /.env; do
    call GET "$path"; check "$path stays internal: 404 from Caddy" caddy_404
done
for path in /v1/models /v1/usage /v1/embeddings /v1/rerank /v1/guard /v1/runs; do
    call GET "$path"; check "the gateway's $path stays internal" caddy_404
done
call POST /v1/chat/completions -d '{}'; check "POST /v1/chat/completions stays internal" caddy_404
for path in /api/lb03/x /api/lb04/x /api/lb05/x; do
    call GET "$path"; check "$path has no route until its service exists" caddy_404
done
call GET /ws/lb04/x -H "Origin: $site_origin"; check "/ws/lb04/x has no route until its service exists" caddy_404
call GET /api/lb01/customers -H "Authorization: Bearer test-token"
check "GET /api/lb01/customers reaches the Django systems" reached django
check "  with the path unchanged" grep -q '"path": "/api/lb01/customers"' <<<"$body"
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
check "  told the scheme was https" grep -q '"x-forwarded-proto": "https"' <<<"$body"
payload='{"text":"my bag arrived torn"}'
call POST /api/lb01/tickets -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb01/tickets reaches the Django systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb02/rooms; check "/api/lb02/* reaches the Django systems" reached django
call GET /v1/runs/run12345-abcdef/spans; check "GET /v1/runs/<id>/spans reaches the gateway" reached gateway
call POST /v1/runs/run12345-abcdef/spans -d '{}'; check "POST on that path stays internal" caddy_404
call GET /v1/runs/short/spans; check "a run id under 8 characters is refused" caddy_404
call GET /v1/runs/run12345-abcdef/spans/extra; check "a longer path under it is refused" caddy_404
call GET /v1/runs/run12345-abcdef/other; check "another resource of the run is refused" caddy_404

echo "Paths built to slip past the allowlist"
for path in /api/lb01/../healthz /api/lb01/%2e%2e/healthz /api/lb01/..%2fhealthz /api/lb01%2f..%2f..%2fhealthz \
    //api/healthz /api/lb01//../healthz '/api/lb01/..;/healthz' /v1/runs/..%2f..%2fusage/spans \
    /v1/runs/abcdefgh/spans/..%2f..%2fmodels /v1/runs/..%2fabcdefgh/spans /api/./healthz /API/healthz; do
    call GET "$path"
    if [ "$status" = 404 ] && grep -q 'There is nothing at this address' <<<"$body"; then
        pass "refused: $path"
    elif [ "$status" = 200 ]; then
        # It reached a service. That is only acceptable if the service, however it decodes
        # and tidies the path, still lands on a route the allowlist lets through.
        received="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["path"])' "$body")"
        resolved="$(python3 -c 'import posixpath,sys,urllib.parse; print(posixpath.normpath(urllib.parse.unquote(sys.argv[1].split("?")[0])))' "$received")"
        case "$resolved" in
            /api/lb01/* | /api/lb02/* | /ws/lb02/*) pass "forwarded as $received, which still resolves to $resolved" ;;
            /v1/runs/*/spans) pass "forwarded as $received, which still resolves to $resolved" ;;
            *) fail "$path reached a service as $received, which resolves to $resolved" ;;
        esac
    else
        fail "$path answered $status: ${body:0:120}"
    fi
done

echo "Only the API's own host is served"
call GET /api/lb01/customers -H "Host: evil.example"; check "another host name gets 404" caddy_404
call GET /api/lb01/customers -H "Host: 127.0.0.1"; check "a bare address gets 404" caddy_404

echo "Limits"
head -c 100000 /dev/zero | tr '\0' 'a' > "$scratch/small.bin"
head -c 2000000 /dev/zero | tr '\0' 'a' > "$scratch/large.bin"
call POST /api/lb01/tickets --data-binary "@$scratch/small.bin"; check "a 100 KB body passes" reached django
call POST /api/lb01/tickets --data-binary "@$scratch/large.bin"
check "a 2 MB body is refused with 413" test "$status" = 413
check "  in the platform's JSON error shape" grep -q '"error"' <<<"$body"

echo "CORS: the site's origin may call the API, and nobody else"
call OPTIONS /api/lb01/tickets -H "Origin: $site_origin" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization"
check "the site's preflight is answered 204 at the edge" test "$status" = 204
check "  allowing the site's origin" test "$(header_of access-control-allow-origin)" = "$site_origin"
check "  and the Authorization header" grep -qi 'authorization' <<<"$(header_of access-control-allow-headers)"
call OPTIONS /api/lb01/tickets -H "Origin: https://evil.lb.test" -H "Access-Control-Request-Method: POST"
check "another origin's preflight gets no allow-origin header" test -z "$(header_of access-control-allow-origin)"
call GET /api/lb01/customers -H "Origin: $site_origin"
check "a call from the site's origin is allowed" test "$(header_of access-control-allow-origin)" = "$site_origin"
check "  and varies by origin" grep -qi 'origin' <<<"$(header_of vary)"
call GET /api/lb01/customers -H "Origin: https://evil.lb.test"
check "a call from another origin gets no allow-origin header" test -z "$(header_of access-control-allow-origin)"
call GET /api/lb01/customers
check "a call without an origin gets none either" test -z "$(header_of access-control-allow-origin)"
call OPTIONS /v1/runs/run12345-abcdef/spans -H "Origin: $site_origin" -H "Access-Control-Request-Method: GET"
check "the gateway route is for the site's server, so it has no CORS" test -z "$(header_of access-control-allow-origin)"

echo "Every response has HSTS, and none names the software behind it"
for path in /api/lb01/customers /nothing-here; do
    call GET "$path"
    check "$path: Strict-Transport-Security is set" grep -qi 'max-age=63072000' <<<"$(header_of strict-transport-security)"
    check "$path: X-Content-Type-Options is nosniff" test "$(header_of x-content-type-options)" = nosniff
    check "$path: no Server header" test -z "$(header_of server)"
    check "$path: no X-Powered-By header" test -z "$(header_of x-powered-by)"
done

echo "Streams: server-sent events and WebSockets"
timing="$(python3 - "$port" "$api_host" <<'PY'
import http.client
import sys
import time

port, host = int(sys.argv[1]), sys.argv[2]
connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
started = time.monotonic()
connection.request("GET", "/api/lb01/events", headers={"Host": host})
response = connection.getresponse()
first = response.read1(64)
first_at = time.monotonic() - started
rest = response.read()
total = time.monotonic() - started
print(f"{first_at:.2f} {total:.2f} {first.decode().count('data:') + rest.decode().count('data:')}")
PY
)"
read -r first_at total events <<<"$timing"
check "the first event arrives as it is written, not when the stream ends ($first_at s of $total s)" \
    python3 -c "import sys; sys.exit(0 if float('$first_at') < 0.4 and float('$total') > 1.0 else 1)"
check "all three events arrive" test "$events" = 3

websocket() {
    # websocket <origin or empty>: opens a handshake and prints the status line and the first frame.
    python3 - "$port" "$api_host" "${1:-}" <<'PY'
import base64
import os
import socket
import sys

port, host, origin = int(sys.argv[1]), sys.argv[2], sys.argv[3]
key = base64.b64encode(os.urandom(16)).decode()
request = (
    f"GET /ws/lb02/live HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n" + (f"Origin: {origin}\r\n" if origin else "") + "\r\n"
)
with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
    connection.sendall(request.encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    if b" 101 " in head.split(b"\r\n")[0] and len(rest) < 2:
        rest += connection.recv(4096)
    print(head.split(b"\r\n")[0].decode(), "|", rest[2:].decode(errors="replace"))
PY
}
answer="$(websocket "$site_origin")"
check "a WebSocket from the site's origin is upgraded and reaches the service" grep -q '101.*hello from django' <<<"$answer"
answer="$(websocket "https://evil.lb.test")"
check "a WebSocket from another origin is refused with 403" grep -q ' 403 ' <<<"$answer"
answer="$(websocket "")"
check "a WebSocket with no origin is refused with 403" grep -q ' 403 ' <<<"$answer"

echo "The access log keeps no query string, header or visitor address"
call GET "/api/lb01/customers?token=SECRETQUERYTOKEN&page=2" \
    -H "Authorization: Bearer SECRETBEARERTOKEN" -H "Cf-Connecting-Ip: 203.0.113.77" -H "User-Agent: SecretBrowser/1.0"
sleep 1
docker logs "$prefix-caddy" > "$scratch/caddy.log" 2>&1
check "the request was logged" grep -q '"logger":"http.log.access' "$scratch/caddy.log"
check "the log shows the path with the query removed" grep -q 'customers?\[removed\]' "$scratch/caddy.log"
for secret in SECRETQUERYTOKEN SECRETBEARERTOKEN 203.0.113.77 SecretBrowser; do
    check "the log never holds $secret" bash -c "! grep -q '$secret' '$scratch/caddy.log'"
done

echo "A service that is down gives a JSON 502, and the health listener is private"
docker stop "$prefix-django" >/dev/null
call GET /api/lb01/customers
check "a stopped service answers 502" test "$status" = 502
check "  in the platform's JSON error shape" grep -q '"error"' <<<"$body"
check "the container's own health check answers" test "$(docker exec "$prefix-caddy" wget -q -O- http://127.0.0.1:8081/ready 2>/dev/null)" = ok
check "no other container can reach the health listener" bash -c \
    "! docker run --rm --network '$network' --entrypoint wget '$caddy_image' -q -T 3 -O- http://$prefix-caddy:8081/ready >/dev/null 2>&1"

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
