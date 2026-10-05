#!/bin/bash
# Proves the Caddy edge (docs/SECURITY.md, sections 1 and 5) with the real Caddy image and
# the repository's Caddyfile, in front of stand-ins for four services (test-upstream.py):
#
#   - only the routes the Caddyfile lists reach a service (LB-01 and LB-02 at the Django
#     systems, LB-03 and LB-05 at the Flask systems, LB-08, LB-04, LB-06 and LB-07 at the Node systems, one path of
#     the gateway); health checks, the OpenAPI schema and the rest of the gateway answer 404
#     from Caddy itself;
#   - paths built to slip past the allowlist (dot segments, escaped slashes) never reach
#     a route they shouldn't;
#   - only the API's own Host is served;
#   - bodies over the limit are refused (a megabyte, except the two upload routes: LB-03's
#     takes a file of 10 MB and the form around it, LB-04's contract upload 3 MB); CORS and
#     WebSocket origins are limited to the site;
#   - server-sent events arrive as they are written, and a WebSocket upgrade passes through;
#   - a service has as long to answer as the Caddyfile says: LB-05 and LB-08 more than a
#     minute (a question has 90 seconds), the others a minute;
#   - a quiet WebSocket is not cut by the idle timeout that closes an idle HTTP connection,
#     shown on a second Caddy whose only difference is a three-second idle timeout;
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
    docker rm -f "$prefix-caddy" "$prefix-caddy-idle" "$prefix-django" "$prefix-gateway" "$prefix-flask" "$prefix-node" >/dev/null 2>&1 || true
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
for pair in "django:django-api:8000" "gateway:gateway:8080" "flask:flask-api:8102" "node:node-api:8002"; do
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

# The slowest checks are started first and read last, so that their minute of waiting passes
# while the rest of the tests run. start_slow <service> <path> asks for an answer that takes
# 63 seconds, in the background, and keeps the status code it got in $scratch/slow-<service>.
slow_pids=()
start_slow() {
    (curl -sS -m 100 -o /dev/null -w '%{http_code}' -H "Host: $api_host" "http://127.0.0.1:$port$2" > "$scratch/slow-$1" 2>/dev/null || true) &
    slow_pids+=($!)
}
start_slow django "/api/lb01/slow?seconds=63"
start_slow flask "/api/lb05/slow?seconds=63"
start_slow node "/api/lb08/slow?seconds=63"

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
call GET /api/lb10/x; check "/api/lb10/x has no route until its service exists" caddy_404
for path in /ws/lb04/x /ws/lb05/x /ws/lb07/x /ws/lb08/x; do
    call GET "$path" -H "Origin: $site_origin"; check "$path has no route: only LB-02, LB-06 and LB-09 have a WebSocket" caddy_404
done
call GET /ws/lb09/ -H "Origin: $site_origin"; check "/ws/lb09/ reaches the Django systems from the site's origin" reached django
call GET /ws/lb09/ -H "Origin: https://elsewhere.example"; check "/ws/lb09/ from another origin is refused" test "$status" = 403
call GET /api/lb05; check "the bare /api/lb05 is not a route" caddy_404
call GET /api/lb03; check "the bare /api/lb03 is not a route" caddy_404
call GET /api/lb08; check "the bare /api/lb08 is not a route" caddy_404
call GET /api/lb04; check "the bare /api/lb04 is not a route" caddy_404
call GET /api/lb06; check "the bare /api/lb06 is not a route" caddy_404
call GET /api/lb07; check "the bare /api/lb07 is not a route" caddy_404
call GET /api/lb01/customers -H "Authorization: Bearer test-token"
check "GET /api/lb01/customers reaches the Django systems" reached django
check "  with the path unchanged" grep -q '"path": "/api/lb01/customers"' <<<"$body"
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
check "  told the scheme was https" grep -q '"x-forwarded-proto": "https"' <<<"$body"
payload='{"text":"my bag arrived torn"}'
call POST /api/lb01/tickets -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb01/tickets reaches the Django systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb02/rooms; check "/api/lb02/* reaches the Django systems" reached django
call GET /api/lb09/limits -H "Authorization: Bearer test-token"
check "/api/lb09/* reaches the Django systems" reached django
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
call GET /api/lb05/semantic-layer -H "Authorization: Bearer test-token"
check "GET /api/lb05/semantic-layer reaches the Flask systems" reached flask
check "  with the path unchanged and the API's own Host" grep -q "\"host\": \"$api_host\"" <<<"$body"
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
payload='{"question":"which coffee sold most last quarter?"}'
call POST /api/lb05/ask -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb05/ask reaches the Flask systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb03/quota -H "Authorization: Bearer test-token"
check "GET /api/lb03/quota reaches the Flask systems" reached flask
check "  with the path unchanged and the API's own Host" grep -q "\"host\": \"$api_host\"" <<<"$body"
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
call GET /api/lb03/documents/abc123def456ghi789jkl0/pages/1 -H "Authorization: Bearer test-token"
check "a page's picture is served from the Flask systems too" reached flask
payload='{"path":"total","value":"1040.60"}'
call POST /api/lb03/documents/abc123def456ghi789jkl0/corrections -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb03/documents/<id>/corrections reaches the Flask systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb08/samples -H "Authorization: Bearer test-token"
check "GET /api/lb08/samples reaches the Node systems" reached node
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
payload='{"description":"text me when a pallet arrives"}'
call POST /api/lb08/workflows -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb08/workflows reaches the Node systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb04/samples -H "Authorization: Bearer test-token"
check "GET /api/lb04/samples reaches the Node systems" reached node
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
payload='{"from":"sample","sampleId":"wholesale-supply"}'
call POST /api/lb04/contracts -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb04/contracts reaches the Node systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb04/contracts/11111111-1111-4111-8111-111111111111/report; check "a contract's report reaches the Node systems" reached node
call POST /api/lb04/contracts/11111111-1111-4111-8111-111111111111/findings/f1/redline; check "a redline's route reaches the Node systems" reached node
call GET /api/lb06/catalogue -H "Authorization: Bearer test-token"
check "GET /api/lb06/catalogue reaches the Node systems" reached node
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
payload='{"from":"sample","sampleId":"bad-deploy"}'
call POST /api/lb06/incidents -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb06/incidents reaches the Node systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call POST /api/lb06/incidents/11111111-1111-4111-8111-111111111111/proposals/p1/decision -H 'Content-Type: application/json' -d '{"decision":"approve"}'; check "a decision's route reaches the Node systems" reached node
call GET /api/lb06/incidents/11111111-1111-4111-8111-111111111111/postmortem; check "an incident's postmortem route reaches the Node systems" reached node
call GET /api/lb07/bugs -H "Authorization: Bearer test-token"
check "GET /api/lb07/bugs reaches the Node systems" reached node
check "  with the caller's Authorization header" grep -q '"authorization": "Bearer test-token"' <<<"$body"
payload='{"from":"custom","goal":"Buy two bags of Ethiopia Guji with WELCOME10","bugs":["coupon-twice"]}'
call POST /api/lb07/runs -H 'Content-Type: application/json' -d "$payload"
check "POST /api/lb07/runs reaches the Node systems with its body" grep -q "\"body_bytes\": ${#payload}" <<<"$body"
call GET /api/lb07/runs/11111111-1111-4111-8111-111111111111/evidence/e1; check "a test run's evidence reaches the Node systems" reached node
call GET /api/lb07/runs/11111111-1111-4111-8111-111111111111/test; check "a test run's generated test reaches the Node systems" reached node
call DELETE /api/lb07/runs/11111111-1111-4111-8111-111111111111; check "DELETE of a test run reaches the Node systems" reached node
call GET /v1/runs/run12345-abcdef/spans; check "GET /v1/runs/<id>/spans reaches the gateway" reached gateway
call POST /v1/runs/run12345-abcdef/spans -d '{}'; check "POST on that path stays internal" caddy_404
call GET /v1/runs/short/spans; check "a run id under 8 characters is refused" caddy_404
call GET /v1/runs/run12345-abcdef/spans/extra; check "a longer path under it is refused" caddy_404
call GET /v1/runs/run12345-abcdef/other; check "another resource of the run is refused" caddy_404

echo "Paths built to slip past the allowlist"
for path in /api/lb01/../healthz /api/lb01/%2e%2e/healthz /api/lb01/..%2fhealthz /api/lb01%2f..%2f..%2fhealthz \
    //api/healthz /api/lb01//../healthz '/api/lb01/..;/healthz' /v1/runs/..%2f..%2fusage/spans \
    /v1/runs/abcdefgh/spans/..%2f..%2fmodels /v1/runs/..%2fabcdefgh/spans /api/./healthz /API/healthz \
    /api/lb05/../healthz /api/lb05/%2e%2e/readyz /api/lb05/..%2fhealthz /api/lb08/../openapi.json \
    /api/lb08/%2e%2e/healthz '/api/lb08/..;/readyz' /api/lb05/../lb08/workflows \
    /api/lb03/../healthz /api/lb03/%2e%2e/readyz /api/lb03/..%2fhealthz /api/lb03/documents/../../../healthz \
    /api/lb03/../lb08/workflows \
    /api/lb04/../openapi.json /api/lb04/%2e%2e/healthz '/api/lb04/..;/readyz' /api/lb04/..%2fhealthz /api/lb05/../lb04/contracts \
    /api/lb06/../openapi.json /api/lb06/%2e%2e/healthz '/api/lb06/..;/readyz' /api/lb06/..%2fhealthz /api/lb05/../lb06/incidents \
    /api/lb07/../openapi.json /api/lb07/%2e%2e/healthz '/api/lb07/..;/readyz' /api/lb07/..%2fhealthz /api/lb05/../lb07/runs; do
    call GET "$path"
    if [ "$status" = 404 ] && grep -q 'There is nothing at this address' <<<"$body"; then
        pass "refused: $path"
    elif [ "$status" = 200 ]; then
        # It reached a service. That is only acceptable if the service, however it decodes
        # and tidies the path, still lands on a route the allowlist lets through.
        received="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["path"])' "$body")"
        resolved="$(python3 -c 'import posixpath,sys,urllib.parse; print(posixpath.normpath(urllib.parse.unquote(sys.argv[1].split("?")[0])))' "$received")"
        case "$resolved" in
            /api/lb01/* | /api/lb02/* | /api/lb03/* | /api/lb05/* | /api/lb08/* | /api/lb04/* | /api/lb06/* | /api/lb07/* | /api/lb09/* | /ws/lb02/* | /ws/lb06/* | /ws/lb09/*) pass "forwarded as $received, which still resolves to $resolved" ;;
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
# LB-03's upload takes a file: a megabyte is the limit of every other route, the upload's is 11 MB.
head -c 5000000 /dev/zero | tr '\0' 'a' > "$scratch/upload.bin"
head -c 12000000 /dev/zero | tr '\0' 'a' > "$scratch/too-big-upload.bin"
call POST /api/lb03/documents -H 'Content-Type: multipart/form-data; boundary=zz' --data-binary "@$scratch/upload.bin"
check "a 5 MB upload to LB-03 passes, whole" grep -q '"body_bytes": 5000000' <<<"$body"
call POST /api/lb03/documents -H 'Content-Type: multipart/form-data; boundary=zz' --data-binary "@$scratch/too-big-upload.bin"
check "a 12 MB upload to LB-03 is refused with 413" test "$status" = 413
check "  in the platform's JSON error shape" grep -q '"error"' <<<"$body"
call POST /api/lb03/documents/abc123def456ghi789jkl0/corrections -H 'Content-Type: application/json' --data-binary "@$scratch/large.bin"
check "the room for a file is for the upload alone: 2 MB to LB-03's corrections is refused with 413" test "$status" = 413
call PUT /api/lb03/documents --data-binary "@$scratch/large.bin"
check "  and the same path with another method is no upload: 413" test "$status" = 413
call GET /api/lb03/documents/abc123def456ghi789jkl0/export?format=csv
check "a read of LB-03 passes with no body at all" reached flask
# What a 2 MB PDF makes as base64 inside JSON, and a body bigger than any file could make.
head -c 2800000 /dev/zero | tr '\0' 'a' > "$scratch/upload.bin"
head -c 3200000 /dev/zero | tr '\0' 'a' > "$scratch/upload-too-large.bin"
call POST /api/lb04/contracts -H 'Content-Type: application/json' --data-binary "@$scratch/upload.bin"
check "LB-04's upload route takes a 2.8 MB body, which a contract's PDF makes" reached node
call POST /api/lb04/contracts -H 'Content-Type: application/json' --data-binary "@$scratch/upload-too-large.bin"
check "  and refuses a 3.2 MB body with 413" test "$status" = 413
check "  in the platform's JSON error shape" grep -q '"error"' <<<"$body"
call POST /api/lb04/contracts/11111111-1111-4111-8111-111111111111/findings/f1/redline --data-binary "@$scratch/large.bin"
check "every other LB-04 route keeps the 1 MB limit: a 2 MB body is refused with 413" test "$status" = 413
head -c 4400000 /dev/zero | tr '\0' 'a' > "$scratch/recording.bin"
head -c 6000000 /dev/zero | tr '\0' 'a' > "$scratch/huge.bin"
call POST /api/lb09/meetings --data-binary "@$scratch/recording.bin"
check "a 4.4 MB body passes on LB-09's upload route" reached django
check "  whole" grep -q '"body_bytes": 4400000' <<<"$body"
call POST /api/lb09/meetings --data-binary "@$scratch/huge.bin"
check "a 6 MB body is refused there too" test "$status" = 413
call GET /api/lb09/meetings --data-binary "@$scratch/large.bin"
check "a 2 MB body on another LB-09 route is refused" test "$status" = 413
call POST /api/lb09/meetings/abc/export --data-binary "@$scratch/large.bin"
check "a 2 MB body under the upload path, but not on it, is refused" test "$status" = 413

echo "CORS: the site's origin may call the API, and nobody else"
call OPTIONS /api/lb01/tickets -H "Origin: $site_origin" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization"
check "the site's preflight is answered 204 at the edge" test "$status" = 204
check "  allowing the site's origin" test "$(header_of access-control-allow-origin)" = "$site_origin"
check "  and the Authorization header" grep -qi 'authorization' <<<"$(header_of access-control-allow-headers)"
for path in /api/lb05/ask /api/lb08/workflows /api/lb04/contracts /api/lb06/incidents /api/lb07/runs; do
    call OPTIONS "$path" -H "Origin: $site_origin" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization"
    check "the site's preflight for $path is answered 204 at the edge" test "$status" = 204
    check "  allowing the site's origin" test "$(header_of access-control-allow-origin)" = "$site_origin"
done
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
    # websocket <origin or empty> [path]: opens a handshake and prints the status line and the first frame.
    python3 - "$port" "$api_host" "${1:-}" "${2:-/ws/lb02/live}" <<'PY'
import base64
import os
import socket
import sys

port, host, origin, path = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
key = base64.b64encode(os.urandom(16)).decode()
request = (
    f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
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
answer="$(websocket "$site_origin" /ws/lb06/)"
check "LB-06's WebSocket from the site's origin is upgraded and reaches the Node systems" grep -q '101.*hello from node' <<<"$answer"
answer="$(websocket "https://evil.lb.test" /ws/lb06/)"
check "LB-06's WebSocket from another origin is refused with 403" grep -q ' 403 ' <<<"$answer"
answer="$(websocket '' /ws/lb06/)"
check "LB-06's WebSocket with no origin is refused with 403" grep -q ' 403 ' <<<"$answer"
answer="$(websocket "")"
check "a WebSocket with no origin is refused with 403" grep -q ' 403 ' <<<"$answer"

echo "A quiet WebSocket outlives the idle timeout that closes an idle HTTP connection"
# A second Caddy: this Caddyfile with one change, an idle timeout of three seconds in place of
# two minutes. Any other difference would make the comparison prove nothing, so it is checked.
sed 's/^\([[:space:]]*\)idle 2m$/\1idle 3s/' "$here/Caddyfile" > "$scratch/Caddyfile.short-idle"
chmod a+rx "$scratch"
chmod a+r "$scratch/Caddyfile.short-idle"
changed_lines="$(diff "$here/Caddyfile" "$scratch/Caddyfile.short-idle" | grep -c '^>' || true)"
check "the short-idle copy differs from the Caddyfile in exactly one line" test "$changed_lines" = 1
docker run -d --name "$prefix-caddy-idle" --network "$network" -p 127.0.0.1::8080 \
    --user 65532:65532 --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
    --tmpfs /data:uid=65532,gid=65532 --tmpfs /config:uid=65532,gid=65532 \
    -e LB_API_HOST="$api_host" -e LB_SITE_ORIGIN="$site_origin" \
    -v "$scratch/Caddyfile.short-idle":/etc/caddy/Caddyfile:ro "$caddy_image" >/dev/null
idle_port=""
for _ in $(seq 1 40); do
    idle_port="$(docker port "$prefix-caddy-idle" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
    if [ -n "$idle_port" ] && curl -s -m 2 -o /dev/null -H "Host: $api_host" "http://127.0.0.1:$idle_port/"; then break; fi
    sleep 0.5
done
silence="$(python3 - "$idle_port" "$api_host" "$site_origin" <<'PY'
import base64
import http.client
import os
import socket
import sys
import time

port, host, origin = int(sys.argv[1]), sys.argv[2], sys.argv[3]
# Twice the idle timeout of this Caddy.
SILENCE_SECONDS = 6


def http_after_silence() -> str:
    """Use one keep-alive connection twice, with the silence between: report whether it was still open."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request("GET", "/api/lb01/customers", headers={"Host": host})
    connection.getresponse().read()
    time.sleep(SILENCE_SECONDS)
    try:
        connection.request("GET", "/api/lb01/customers", headers={"Host": host})
        connection.getresponse().read()
    except (http.client.HTTPException, OSError):
        return "closed"
    return "kept"


def read_exactly(connection: socket.socket, buffer: bytearray, count: int) -> bytes:
    """Take count bytes from what was received already and then from the connection."""
    while len(buffer) < count:
        chunk = connection.recv(4096)
        if not chunk:
            raise ConnectionError("the connection was closed")
        buffer.extend(chunk)
    taken = bytes(buffer[:count])
    del buffer[:count]
    return taken


def read_text_frame(connection: socket.socket, buffer: bytearray) -> str:
    """Read one short, unmasked text frame from the service."""
    header = read_exactly(connection, buffer, 2)
    return read_exactly(connection, buffer, header[1] & 0x7F).decode()


def websocket_after_silence() -> str:
    """Open a WebSocket, stay quiet, then speak: report what the service answered."""
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /ws/lb02/live HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=15) as connection:
        connection.sendall(request.encode())
        buffer = bytearray()
        while b"\r\n\r\n" not in buffer:
            chunk = connection.recv(4096)
            if not chunk:
                return "no handshake"
            buffer.extend(chunk)
        head, _, rest = bytes(buffer).partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            return head.split(b"\r\n")[0].decode()
        buffer = bytearray(rest)
        read_text_frame(connection, buffer)
        time.sleep(SILENCE_SECONDS)
        text = b"still here"
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(text))
        connection.sendall(bytes([0x81, 0x80 | len(text)]) + mask + masked)
        return read_text_frame(connection, buffer)


print(f"http: {http_after_silence()}")
print(f"websocket: {websocket_after_silence()}")
PY
)"
check "on the short-idle Caddy an HTTP connection that sat idle was closed, so the timeout is in force" grep -q '^http: closed' <<<"$silence"
check "  and a WebSocket that stayed quiet for twice that long still answers" grep -q '^websocket: echo: still here' <<<"$silence"

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

echo "A service has as long to answer as the Caddyfile gives it"
# Started at the top, and 63 seconds of waiting have passed during the tests since.
wait "${slow_pids[@]}"
check "LB-05 answers after 63 seconds: a question has up to 90" test "$(cat "$scratch/slow-flask")" = 200
check "LB-08 answers after 63 seconds: describing a workflow may make two model calls" test "$(cat "$scratch/slow-node")" = 200
slow_status="$(cat "$scratch/slow-django")"
check "LB-01 is cut off at a minute, with a 5xx from Caddy (status $slow_status)" test "$slow_status" -ge 500 -a "$slow_status" -lt 600

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
