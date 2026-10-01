#!/bin/bash
# Checks the Compose files against the platform's security rules (docs/SECURITY.md,
# section 6), service by service, so that a new service block cannot quietly weaken what
# the others have. It reads the fully resolved configuration, for the production stack and
# for the local one, and names every service that breaks a rule (the rules are in
# compose-policy.jq):
#
#   - read-only root filesystem, all capabilities dropped, no-new-privileges, not privileged,
#     no host network, PID or IPC namespace, no devices, and not root;
#   - a memory, CPU and process limit, so that one service cannot starve the box;
#   - a restart policy of unless-stopped for what runs all the time, with a health check,
#     and rotated logs;
#   - no published port at all in production (the only way in is the tunnel), and on the
#     local stack only on 127.0.0.1;
#   - bind mounts read-only, and never the Docker socket;
#   - every network internal (no route out) except `outbound`, which only the egress proxies
#     and the tunnel connector may join; Postgres and Redis on `data` alone.
#
# The only capability any service may add back is NET_BIND_SERVICE, for Caddy, whose
# official image keeps its permission to bind port 80 in a file capability.
#
# It makes throwaway secrets for Compose to resolve against; nothing real is read.
#
#   infra/scripts/check-compose.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
failures=0

# check_stack <label> <dev: true|false> <environment for compose.sh>...
check_stack() {
    local label="$1" dev="$2" problems
    shift 2
    echo "$label"
    problems="$(env "$@" "$here/compose.sh" config --format json | jq -r --argjson dev "$dev" -f "$here/compose-policy.jq")"
    if [ -n "$problems" ]; then
        printf '%s\n' "$problems" | sed 's/^/  FAIL  /' >&2
        failures=$((failures + $(printf '%s\n' "$problems" | wc -l)))
    else
        echo "  ok    every service follows the rules"
    fi
}

LB_SECRETS_DIR="$scratch/secrets" "$here/dev-secrets.sh" > /dev/null
check_stack "the production stack" false LB_SECRETS_DIR="$scratch/secrets" LB_TAG=policy-check
check_stack "the local stack" true LB_SECRETS_DIR="$scratch/secrets" LB_TAG=policy-check LB_STACK=dev

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures problem(s) found." >&2
    exit 1
fi
