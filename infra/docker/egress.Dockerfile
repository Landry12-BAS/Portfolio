# The egress proxy image: Squid, allowing HTTPS tunnels to a short list of host names.
# Build context: the repository root. See infra/egress/squid.conf for the policy and
# infra/docker-compose.yml for the two instances (one for the gateway, one for the systems).
#
# Alpine keeps it small, and Squid runs as its own unprivileged user. Base images are pinned
# by digest: `just pin-images` refreshes them.

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
LABEL org.opencontainers.image.title="lb-egress" \
      org.opencontainers.image.description="Allowlisted HTTPS egress proxy for the gateway and the systems." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# Alpine packages are not pinned by version: a release branch only receives fixes, and a
# pinned point release disappears from the mirror the next time Alpine rebuilds it.
# hadolint ignore=DL3018
RUN apk add --no-cache squid
COPY --chmod=0444 infra/egress/squid.conf /etc/squid/squid.conf
COPY --chmod=0555 infra/egress/entrypoint.sh /usr/local/bin/lb-egress
# Squid's own user (uid and gid 31), created by the package. The number is what
# docker-compose.yml gives the tmpfs mounts, so the two must agree.
USER 31:31
EXPOSE 3128
ENTRYPOINT ["/usr/local/bin/lb-egress"]
