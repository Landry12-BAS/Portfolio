#!/bin/bash
# Prints the image a service of docker-compose.yml runs, exactly as the file writes it
# (for a third-party image that is `name:tag@sha256:digest`). The infrastructure tests use
# it, so the image they test is the image the box runs, with one place to change it.
#
#   infra/scripts/image-of.sh postgres
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service="${1:?usage: image-of.sh <compose service>}"

docker compose -f "$here/../docker-compose.yml" config --no-interpolate --no-env-resolution --format json \
    | jq -er --arg service "$service" '.services[$service].image'
