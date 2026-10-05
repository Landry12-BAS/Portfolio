#!/bin/bash
# Proves LB-07's browser sandbox (docs/SECURITY.md, section 6) with the image the box runs, started
# by Compose from infra/docker-compose.yml itself, so every flag is the policy's own: a read-only
# root, the tmpfs, no capabilities, no new privileges, a non-root user, the memory, CPU and process
# limits, the restart policy, and the internal sandbox network whose bridge has no address on the
# host. A second container on that network stands in for node-worker (client.mjs) and calls the
# runner as the worker does. It shows:
#
#   - the container runs as the policy says: not root, no capability, no new privileges, a seccomp
#     filter, a root filesystem it cannot write;
#   - Chromium starts under those flags, and golden plans run through the runner's API called from
#     the other container: every bug found by the red passes and none by the green pass, a clean
#     shop left clean, a link to another host stopped, and nothing that left the shop; a call that
#     does not show the runner's key (or shows the bug-token key) is refused, and only the health
#     check answers without it;
#   - the heaviest golden plan, five runs in a row from a fresh start, stays inside the Compose
#     memory limit with no restart and no out-of-memory kill (the peak is printed);
#   - the container has no route out: no public address, no public name, no container on another
#     network, not the host; the shop answers only inside it, and the runner only on its network;
#   - after LB07_RUNS_PER_LIFE runs the process exits, the run in flight having finished first, and
#     Docker's restart policy starts a fresh one.
#
# It needs Docker (25 or later), jq and the repository's dependencies (`just install`: the stand-in
# imports the service's own client), and cleans up everything it starts.
#
#   infra/sandbox/test.sh                            builds the image from this working tree first
#   LB_SANDBOX_IMAGE=<image> infra/sandbox/test.sh   tests an image that is already built
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"
repo="$(cd "$infra/.." && pwd -P)"
prefix="${LB_TEST_PREFIX:-lb-sandboxtest}-$$"
# Compose names the image <registry>/lb-lb07-sandbox:<tag>; the one under test gets that name here.
registry="$prefix"
tag=proof
image="$registry/lb-lb07-sandbox:$tag"
network="${prefix}_sandbox"
other_network="$prefix-other"
scratch="$(mktemp -d)"
failures=0
# The heaviest plan's runs for the memory check, and a short life for the restart check.
heavy_runs=5
short_life=3

cleanup() {
    rm -f "$scratch/sampling"
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker rm -f "$prefix-client" "$prefix-decoy" >/dev/null 2>&1 || true
    docker network rm "$other_network" >/dev/null 2>&1 || true
    docker image rm "$image" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

# expect_equal <label> <expected> <actual>
expect_equal() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- expected '$2', got '$3'"; fi
}

# compose <arguments...>: Compose on the repository's own file, as a project of its own, with
# throwaway secrets for its ${VARIABLES} and the image built here in place of the release's.
compose() {
    LB_SECRETS_DIR="$scratch/secrets" LB_REGISTRY="$registry" LB_TAG="$tag" \
        "$infra/scripts/compose.sh" -p "$prefix" "$@"
}

# sandbox_id: the running sandbox container.
sandbox_id() { compose ps -q lb07-sandbox; }

# client <command...>: the stand-in for node-worker, in a container of its own on the sandbox
# network (and on a second one, as node-worker is on two), run with the policy's flags as well.
client() {
    docker run --rm --name "$prefix-client" --network "$network" --network "$other_network" \
        --read-only --cap-drop ALL --security-opt no-new-privileges:true \
        -e LB07_SHOP_TOKEN_KEY="$shop_key" -v "$repo":/repo:ro \
        --entrypoint /nodejs/bin/node "$image" /repo/infra/sandbox/client.mjs "$@"
}

# A probe for `docker exec`: one word for each <host>:<port> it is given, how a TCP connection to
# it went (connected; refused, which means the address was reached; or blocked: no route, or no
# answer), and for each dns:<name>, whether it resolved.
reach_probe="
const net = require('node:net');
const dns = require('node:dns').promises;
const tcp = (target) => new Promise(resolve => {
  const [host, port] = target.split(':');
  const socket = net.connect({ host, port: Number(port), timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); resolve('connected'); });
  socket.on('error', error => resolve(error.code === 'ECONNREFUSED' ? 'refused' : 'blocked'));
  socket.on('timeout', () => { socket.destroy(); resolve('blocked'); });
});
const lookup = (name) => dns.lookup(name).then(() => 'resolved', () => 'unresolved');
Promise.all(process.argv.slice(1).map(target => target.startsWith('dns:') ? lookup(target.slice(4)) : tcp(target)))
  .then(results => console.log(results.join(' ')));"

# reach <container> <target...>: what the probe says from inside a container.
reach() {
    local container="$1"
    shift
    docker exec "$container" /nodejs/bin/node -e "$reach_probe" "$@" 2>&1 | tail -1
}

# memory_mib <container>: the container's memory use as docker stats reports it, in MiB.
memory_mib() {
    docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{
        value = $1
        if (value ~ /GiB$/) { sub(/GiB$/, "", value); value *= 1024 }
        else if (value ~ /MiB$/) { sub(/MiB$/, "", value) }
        else if (value ~ /KiB$/) { sub(/KiB$/, "", value); value /= 1024 }
        else { sub(/B$/, "", value); value /= 1048576 }
        printf "%.0f\n", value
    }'
}

# cgroup_peak_mib <container id>: the kernel's own record of the container's peak, in MiB, where
# this machine's cgroups keep one (v2 with systemd, or v1); nothing otherwise.
cgroup_peak_mib() {
    local file
    for file in "/sys/fs/cgroup/system.slice/docker-$1.scope/memory.peak" "/sys/fs/cgroup/memory/docker/$1/memory.max_usage_in_bytes"; do
        if [ -r "$file" ]; then
            awk '{ printf "%.0f\n", $1 / 1048576 }' "$file"
            return
        fi
    done
}

# wait_until_healthy <container id>: Docker's health check, after a start or a restart.
wait_until_healthy() {
    local status=""
    for _ in $(seq 1 60); do
        status="$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || true)"
        if [ "$status" = healthy ]; then return 0; fi
        sleep 1
    done
    echo "the sandbox's health check says $status" >&2
    return 1
}

if [ -n "${LB_SANDBOX_IMAGE:-}" ]; then
    echo "Testing $LB_SANDBOX_IMAGE"
    docker tag "$LB_SANDBOX_IMAGE" "$image"
else
    echo "Building the sandbox image from this working tree"
    if ! docker build -f "$infra/docker/lb07-sandbox.Dockerfile" -t "$image" "$repo" > "$scratch/build.log" 2>&1; then
        tail -30 "$scratch/build.log" >&2
        echo "The image did not build." >&2
        exit 1
    fi
fi
printf '  the image is %s MB as docker image inspect counts it (compressed with the containerd image store, unpacked with the classic one)\n' \
    "$(docker image inspect -f '{{.Size}}' "$image" | awk '{ printf "%.0f", $1 / 1000000 }')"

LB_SECRETS_DIR="$scratch/secrets" "$infra/scripts/dev-secrets.sh" > /dev/null
shop_key="$(sed -n 's/^LB07_SHOP_TOKEN_KEY=//p' "$scratch/secrets/lb07-sandbox.env")"
memory_limit_mib="$(compose config --format json | jq -r '.services["lb07-sandbox"].mem_limit | tonumber / 1048576')"
docker network create "$other_network" > /dev/null
docker run -d --name "$prefix-decoy" --network "$other_network" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint /nodejs/bin/node "$image" \
    -e "require('node:net').createServer(socket => { socket.on('error', () => {}); socket.end('decoy'); }).listen(9000)" > /dev/null

echo "Starting the sandbox with Compose, as the box does (memory limit $memory_limit_mib MiB)"
compose up --detach --wait --wait-timeout 120 lb07-sandbox > "$scratch/up.log" 2>&1 || { cat "$scratch/up.log" >&2; exit 1; }
sandbox="$(sandbox_id)"

echo "1. The container runs as the policy says"
expect_equal "it runs as the image's non-root user" "65532:65532" "$(docker inspect -f '{{.Config.User}}' "$sandbox")"
expect_equal "its root filesystem is read-only, with every capability dropped" "true [ALL]" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "$sandbox")"
expect_equal "it is restarted unless stopped, with an init process" "unless-stopped true" "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.HostConfig.Init}}' "$sandbox")"
expect_equal "it is on the sandbox network and no other" "$network" "$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$sandbox" | xargs)"
status_probe="
const status = require('node:fs').readFileSync('/proc/self/status', 'utf8').split('\n');
const field = name => status.find(line => line.startsWith(name + ':')).split(':')[1].trim().split(/\s+/)[0];
let root = 'writable';
try { require('node:fs').writeFileSync('/app/planted', 'x'); } catch (error) { root = error.code; }
console.log([field('Uid'), field('CapEff'), field('NoNewPrivs'), field('Seccomp'), root].join(' '));"
expect_equal "inside: uid 65532, no effective capability, no new privileges, a seccomp filter, and a root it cannot write" \
    "65532 0000000000000000 1 2 EROFS" "$(docker exec "$sandbox" /nodejs/bin/node -e "$status_probe" 2>&1 | tail -1)"

echo "2. Chromium runs golden plans, called from another container on the sandbox network"
if client golden everything-on clean-shop partner-link checkout-in-firefox; then :; else fail "a golden plan did not run as its case says (above)"; fi
if client keyless; then :; else fail "the runner answered a call that did not show its key (above)"; fi

echo "3. The container reaches nothing but its own shop"
decoy_address="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$other_network\").IPAddress}}" "$prefix-decoy")"
host_address="$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
other_gateway="$(docker network inspect "$other_network" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
sandbox_address="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$sandbox")"
expect_equal "the worker's stand-in reaches the decoy on its second network (so the decoy listens)" "connected" \
    "$(client connect "$decoy_address" 9000)"
expect_equal "from inside: the shop on the loopback interface answers" "connected" "$(reach "$sandbox" 127.0.0.1:8007)"
expect_equal "from inside: no public address, no public name" "blocked unresolved" "$(reach "$sandbox" 1.1.1.1:443 dns:example.com)"
expect_equal "from inside: not the decoy, though the worker's stand-in beside it reaches it" "blocked" "$(reach "$sandbox" "$decoy_address:9000")"
expect_equal "from inside: not the host, by Docker's default bridge or by the other network's gateway" "blocked blocked" \
    "$(reach "$sandbox" "$host_address:22" "$other_gateway:22")"
# An internal network's gateway address is the host's own, and a container on it reaches the host
# there: the sandbox network must have none (its bridge is given no address, docker-compose.yml).
sandbox_gateway="$(docker network inspect "$network" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
if [[ "$sandbox_gateway" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "the sandbox network gives the host an address, $sandbox_gateway, and from inside it is $(reach "$sandbox" "$sandbox_gateway:22")"
else
    pass "the sandbox network gives the host no address to be reached at"
fi
expect_equal "the worker's stand-in cannot reach the shop: it is not on the sandbox's network address" "refused" \
    "$(client connect lb07-sandbox 8007)"
expect_equal "a container off the sandbox network cannot reach the runner, by name or by address" "unresolved blocked" \
    "$(reach "$prefix-decoy" dns:lb07-sandbox "$sandbox_address:8008")"

echo "4. Memory: the heaviest golden plan, $heavy_runs runs in a row from a fresh start"
compose up --detach --wait --wait-timeout 120 --force-recreate lb07-sandbox > "$scratch/up.log" 2>&1 || { cat "$scratch/up.log" >&2; exit 1; }
sandbox="$(sandbox_id)"
idle="$(memory_mib "$sandbox")"
touch "$scratch/sampling"
(while [ -e "$scratch/sampling" ]; do memory_mib "$sandbox" >> "$scratch/memory" 2>/dev/null || true; done) &
sampler=$!
if client heavy "$heavy_runs"; then :; else fail "a run of the heaviest plan did not run as its case says (above)"; fi
rm -f "$scratch/sampling"
wait "$sampler" || true
peak="$(sort -n "$scratch/memory" | tail -1)"
kernel_peak="$(cgroup_peak_mib "$sandbox")"
kernel_note=""
if [ -n "$kernel_peak" ]; then kernel_note=", $kernel_peak MiB by the kernel's own count, page cache included"; fi
echo "  idle $idle MiB; at the peak $peak MiB as docker stats counts it$kernel_note; the limit is $memory_limit_mib MiB"
expect_equal "no restart and no out-of-memory kill" "running 0 false" \
    "$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$sandbox")"

echo "5. After its share of runs the runner exits, and Docker starts a fresh one"
cat > "$scratch/short-life.yml" <<YAML
services:
  lb07-sandbox:
    environment:
      LB07_RUNS_PER_LIFE: "$short_life"
YAML
compose -f "$scratch/short-life.yml" up --detach --wait --wait-timeout 120 --force-recreate lb07-sandbox > "$scratch/up.log" 2>&1 \
    || { cat "$scratch/up.log" >&2; exit 1; }
sandbox="$(sandbox_id)"
if client exhaust "$short_life"; then :; else fail "the runner's last run or its restart went wrong (above)"; fi
expect_equal "Docker restarted the container once" "1" "$(docker inspect -f '{{.RestartCount}}' "$sandbox")"
if docker logs "$sandbox" 2>&1 | grep -q "has served its share of runs and is restarting"; then
    pass "the runner said why it exited"
else
    fail "the runner's log does not say it exited after its share of runs"
fi
if wait_until_healthy "$sandbox"; then pass "and the fresh one is healthy again"; else fail "the fresh sandbox did not become healthy"; fi

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
