#!/bin/bash
# Shows that every rule in compose-policy.jq can fail. It starts from a small configuration
# that follows all the rules (and must pass), breaks one rule at a time with a jq edit, and
# checks that the policy names the service and the rule. A policy that never fails would
# prove nothing about the real files.
#
#   infra/scripts/test-compose-policy.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

# A configuration that follows every rule: seven services on the networks they belong on.
read -r -d '' good <<'JSON' || true
{
  "networks": {
    "app": {"internal": true}, "data": {"internal": true}, "outbound": {},
    "sandbox": {"internal": true, "driver_opts": {"com.docker.network.bridge.inhibit_ipv4": "true"}}
  },
  "services": {
    "lb07-sandbox": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "environment": {"LB07_SHOP_TOKEN_KEY": "00", "LB07_RUNS_PER_LIFE": "20"},
      "networks": {"sandbox": null}
    },
    "node-worker": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"app": null, "data": null, "sandbox": null}
    },
    "web": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"app": null}
    },
    "caddy": {
      "read_only": true, "cap_drop": ["ALL"], "cap_add": ["NET_BIND_SERVICE"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"app": null}
    },
    "postgres": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "user": "postgres",
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"data": null},
      "volumes": [{"type": "bind", "source": "/opt/lb/postgresql.conf", "target": "/etc/p.conf", "read_only": true}]
    },
    "redis": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"data": null}
    },
    "egress-gateway": {
      "read_only": true, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
      "mem_limit": "134217728", "cpus": 0.5, "pids_limit": 64, "restart": "unless-stopped",
      "healthcheck": {"test": ["CMD", "true"]},
      "logging": {"driver": "json-file", "options": {"max-size": "10m"}},
      "networks": {"app": null, "outbound": null}
    }
  }
}
JSON

# policy <json> [dev: true|false]: what the rules say about a configuration.
policy() {
    jq -r --argjson dev "${2:-false}" -f "$here/compose-policy.jq" <<<"$1"
}

# expect_clean <label> <json> [dev]
expect_clean() {
    local output
    output="$(policy "$2" "${3:-false}")"
    if [ -z "$output" ]; then pass "$1"; else fail "$1 -- unexpected: $output"; fi
}

# expect_rule <label> <jq edit> <expected line> [dev]: breaks the good configuration with
# the edit, and expects the policy to print exactly that line among its findings.
expect_rule() {
    local label="$1" edit="$2" expected="$3" broken output
    broken="$(jq "$edit" <<<"$good")"
    output="$(policy "$broken" "${4:-false}")"
    if grep -qxF -- "$expected" <<<"$output"; then pass "$label"; else fail "$label -- expected '$expected', got: ${output:-nothing}"; fi
}

expect_clean "a configuration that follows every rule passes" "$good"

expect_rule "a writable root filesystem" '.services.web.read_only = false' "web: the root filesystem is not read-only"
expect_rule "capabilities left in place" '.services.web.cap_drop = []' "web: capabilities are not all dropped"
expect_rule "a capability added back" '.services.web.cap_add = ["SYS_ADMIN"]' "web: adds capabilities back: SYS_ADMIN"
expect_rule "NET_BIND_SERVICE for anyone but Caddy" '.services.web.cap_add = ["NET_BIND_SERVICE"]' "web: adds capabilities back: NET_BIND_SERVICE"
expect_rule "more than NET_BIND_SERVICE for Caddy" '.services.caddy.cap_add = ["NET_BIND_SERVICE", "SYS_ADMIN"]' "caddy: adds capabilities back: NET_BIND_SERVICE, SYS_ADMIN"
expect_rule "no-new-privileges missing" '.services.web.security_opt = []' "web: does not set no-new-privileges"
expect_rule "a privileged container" '.services.web.privileged = true' "web: is privileged"
expect_rule "the host network" '.services.web.network_mode = "host"' "web: shares the host's network, PID or IPC namespace"
expect_rule "the host PID namespace" '.services.web.pid = "host"' "web: shares the host's network, PID or IPC namespace"
expect_rule "a host device" '.services.web.devices = ["/dev/mem"]' "web: is given host devices"
expect_rule "running as root" '.services.web.user = "0:0"' "web: runs as root"
expect_rule "no memory limit" 'del(.services.web.mem_limit)' "web: has no memory limit"
expect_rule "no CPU limit" 'del(.services.web.cpus)' "web: has no CPU limit"
expect_rule "no process limit" 'del(.services.web.pids_limit)' "web: has no process limit"
expect_rule "no health check" 'del(.services.web.healthcheck)' "web: runs all the time but has no health check"
expect_rule "a disabled health check" '.services.web.healthcheck = {"disable": true}' "web: runs all the time but has no health check"
expect_rule "a restart policy that is not unless-stopped" '.services.web.restart = "always"' "web: restarts with always, not unless-stopped"
expect_rule "logs that are not rotated" '.services.web.logging.options = {}' "web: does not rotate its logs"
expect_rule "a published port in production" '.services.web.ports = [{"published": "80", "host_ip": "0.0.0.0"}]' "web: publishes port 80: the box has no inbound ports"
expect_rule "a writable bind mount" '.services.postgres.volumes[0].read_only = false' "postgres: mounts /opt/lb/postgresql.conf read-write"
expect_rule "the Docker socket" '.services.web.volumes = [{"type": "bind", "source": "/var/run/docker.sock", "target": "/s", "read_only": true}]' "web: mounts the Docker socket"
expect_rule "a network with a route out" '.networks.data.internal = false' "network data is not internal: a container on it could reach the internet"
expect_rule "a service that joins outbound" '.services.web.networks.outbound = null' "web: joins the outbound network, which only the egress proxies and the tunnel may"
expect_rule "Postgres on another network" '.services.postgres.networks.app = null' "postgres: is on networks other than data"
expect_rule "Redis on another network" '.services.redis.networks = {"app": null}' "redis: is on networks other than data"
expect_rule "a browser network that gives the host an address" 'del(.networks.sandbox.driver_opts)' "network sandbox gives the host an address: LB-07's browser could reach the box's own services"
expect_rule "a browser network with a route out" '.networks.sandbox.internal = false' "network sandbox is not internal: a container on it could reach the internet"
expect_rule "another service on the browser's network" '.services.web.networks.sandbox = null' "web: joins the sandbox network, which only LB-07's browser sandbox and the Node worker may"
expect_rule "the browser sandbox on another network" '.services["lb07-sandbox"].networks.data = null' "lb07-sandbox: is on networks other than sandbox"
expect_rule "the browser sandbox given another service's secret" '.services["lb07-sandbox"].environment.LB_SERVICE_KEY_JWK_B64 = "a2V5"' "lb07-sandbox: is given settings that are not its own (LB07_*): LB_SERVICE_KEY_JWK_B64"
expect_rule "memory limits that add up to more than the box has" '.services.web.mem_limit = "12582912000"' "the memory limits add up to 12768 MiB, over the 11264 MiB the box has to give (12 GiB less 1 for the host)"
expect_rule "services that run all the time beyond their share of the box" '.services.web.mem_limit = "8598323200"' "the services that run all the time have 8968 MiB of memory limits, over the 8192 MiB planned for them"
expect_rule "the local stack publishing on every address" '.services.web.ports = [{"published": "8180", "host_ip": "0.0.0.0"}]' "web: publishes port 8180 on 0.0.0.0, not on 127.0.0.1" true

expect_clean "the local stack publishing on 127.0.0.1 passes" "$(jq '.services.web.ports = [{"published": "8180", "host_ip": "127.0.0.1"}]' <<<"$good")" true
expect_clean "and so does Caddy on outbound there, which Docker needs to publish" "$(jq '.services.caddy.networks.outbound = null' <<<"$good")" true

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
