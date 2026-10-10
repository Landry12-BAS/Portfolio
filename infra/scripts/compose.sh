#!/bin/bash
# Runs `docker compose` for this stack, with every decrypted secrets file handed over as a
# source for the ${VARIABLES} in docker-compose.yml. On the box the deploy uses it; for a
# local stack, `just stack` does.
#
#   LB_SECRETS_DIR   where the decrypted *.env files are: /run/lb/secrets (a tmpfs) on the
#                    box, infra/.dev/secrets for a local stack
#   LB_STACK=dev     also reads docker-compose.dev.yml: builds the images from this
#                    working tree, leaves out the tunnel and the proxies, and publishes
#                    Caddy on 127.0.0.1 only
#   LB_TAG           the release to run: the deploy sets it, and otherwise it is read from
#                    infra/RELEASE, which the deploy writes into each release's copy of the
#                    folder (the dev stack's secrets set it for a local stack)
#
# Everything else is docker compose's own command line:
#   infra/scripts/compose.sh ps
#   infra/scripts/compose.sh up -d --wait
set -euo pipefail

# Physical paths, so that a run through the `current` link names the same folders as the deploy did: Compose recreates a container whose bind-mount path changed.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"

# A copy of infra/ that the deploy unpacked names its own release, so a command run from
# /opt/lb/current/infra/scripts (a log, a shell in a container) always means the release
# that is live.
if [ -z "${LB_TAG:-}" ] && [ -r "$infra/RELEASE" ]; then
    LB_TAG="$(cat "$infra/RELEASE")"
    export LB_TAG
fi

files=(-f "$infra/docker-compose.yml")
secrets_default=/run/lb/secrets
if [ "${LB_STACK:-production}" = dev ]; then
    files+=(-f "$infra/docker-compose.dev.yml")
    secrets_default="$infra/.dev/secrets"
fi
export LB_SECRETS_DIR="${LB_SECRETS_DIR:-$secrets_default}"

env_files=()
shopt -s nullglob
for file in "$LB_SECRETS_DIR"/*.env; do
    env_files+=(--env-file "$file")
done
if [ "${#env_files[@]}" -eq 0 ]; then
    echo "compose.sh: there are no secrets in $LB_SECRETS_DIR." >&2
    echo "On the box, infra/scripts/decrypt-secrets.sh puts them there; for a local stack, run 'just stack-secrets'." >&2
    exit 1
fi

exec docker compose --project-directory "$infra" "${files[@]}" "${env_files[@]}" "$@"
