# The backup image: pg_dump, age and rclone around infra/backup/backup.sh. Build context:
# the repository root. It runs once a night as a throwaway container (docker-compose.yml,
# service `backup`), as an unprivileged user, and holds no secret of its own.
#
# The Postgres client is the same major version as the server (17): pg_dump refuses to
# dump a newer server. Base images are pinned by digest: `just pin-images` refreshes them.

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
LABEL org.opencontainers.image.title="lb-backup" \
      org.opencontainers.image.description="Nightly encrypted Postgres backup: pg_dump, age, rclone." \
      org.opencontainers.image.source="https://github.com/Landry12-BAS/Portfolio"
# Alpine packages are not pinned by version: a release branch only receives fixes, and a
# pinned point release disappears from the mirror the next time Alpine rebuilds it.
# hadolint ignore=DL3018
RUN apk add --no-cache bash age postgresql17-client rclone \
 && addgroup -S -g 10002 lbbackup \
 && adduser -S -u 10002 -G lbbackup -H -h /nonexistent -s /sbin/nologin lbbackup
COPY --chmod=0555 infra/backup/backup.sh /usr/local/bin/lb-backup
USER 10002:10002
ENTRYPOINT ["/usr/local/bin/lb-backup"]
