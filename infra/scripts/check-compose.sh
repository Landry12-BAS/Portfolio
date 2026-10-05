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
#   - the memory budget: what runs all the time, plus the larger of a deploy's biggest wave of
#     jobs and the jobs under the deploy's lock (the nightly backup), fits in what the box has
#     to give; a deploy's waves never overlap; and every one-shot job is in one of those groups;
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

# check_stack <label> <dev: true|false> <environment for compose.sh>...: the rules, and for a
# stack that follows them, the memory budget's sums, so that the room left is in plain sight.
check_stack() {
    local label="$1" dev="$2" config problems sums
    shift 2
    echo "$label"
    config="$(env "$@" "$here/compose.sh" config --format json)"
    problems="$(jq -r --argjson dev "$dev" -f "$here/compose-policy.jq" <<<"$config")"
    if [ -n "$problems" ]; then
        printf '%s\n' "$problems" | sed 's/^/  FAIL  /' >&2
        failures=$((failures + $(printf '%s\n' "$problems" | wc -l)))
    else
        sums="$(jq -r --argjson dev "$dev" --argjson sums true -f "$here/compose-policy.jq" <<<"$config")"
        echo "  ok    every service follows the rules"
        echo "  ok    $sums"
    fi
}

LB_SECRETS_DIR="$scratch/secrets" "$here/dev-secrets.sh" > /dev/null
# The production stack with the nightly backup, which is behind a profile: it is held to the same
# rules, and its memory counts in the box's budget, as a group of its own beside what runs all the
# time (it runs under the deploy's lock, so never beside a deploy's jobs). The local stack's backup
# writes to a folder on the laptop by design, so that check leaves it out.
check_stack "the production stack, with the nightly backup" false LB_SECRETS_DIR="$scratch/secrets" LB_TAG=policy-check COMPOSE_PROFILES=backup
check_stack "the local stack" true LB_SECRETS_DIR="$scratch/secrets" LB_TAG=policy-check LB_STACK=dev

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures problem(s) found." >&2
    exit 1
fi
