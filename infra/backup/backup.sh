#!/bin/bash
# The nightly Postgres backup: dump the database, encrypt it with age, upload the result.
# It runs as the `backup` service (docker-compose.yml, profile "backup"), started by the
# systemd timer in infra/systemd (docs/DEPLOY.md, Backups).
#
# The dump is encrypted before it exists anywhere but this process's pipe: pg_dump's
# output goes straight into `age`, which writes the only file, in this container's memory
# (a tmpfs). Only that encrypted file is uploaded, and only when both stages succeeded, so
# a failed dump can never be stored under a name that looks like a good backup. The
# recipients are age PUBLIC keys; the private key stays off the box, so nothing on the box
# can read a backup, including this script.
#
# What a visitor sends is kept for an hour, and a backup is kept for weeks, so the dump has
# the shape of the tables that hold it and none of their rows (excluded-data.txt).
#
# Settings, from the environment:
#   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD   the read-only `lbbackup` login
#   LB_BACKUP_AGE_RECIPIENTS    age public keys (age1...), separated by commas or spaces
#   LB_BACKUP_DESTINATION       an rclone destination folder: `r2:<bucket>/postgres` in
#                               production (the remote is defined by RCLONE_CONFIG_R2_*
#                               variables), a plain folder such as /backups in local runs
#   LB_BACKUP_SHARE             the folder that holds lib.sh and excluded-data.txt: the
#                               script's own folder unless the image says otherwise
set -euo pipefail
umask 077

: "${PGHOST:?PGHOST is not set}" "${PGDATABASE:?PGDATABASE is not set}"
: "${PGUSER:?PGUSER is not set}" "${PGPASSWORD:?PGPASSWORD is not set}"
: "${LB_BACKUP_AGE_RECIPIENTS:?LB_BACKUP_AGE_RECIPIENTS is not set}"
: "${LB_BACKUP_DESTINATION:?LB_BACKUP_DESTINATION is not set}"

share="${LB_BACKUP_SHARE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
# shellcheck source=/dev/null
source "$share/lib.sh"
mapfile -t dump_arguments < <(backup_dump_arguments "$share/excluded-data.txt")

# rclone reads its remotes from RCLONE_CONFIG_* variables; an empty config file keeps it
# from looking for (or trying to write) one in a read-only home.
export RCLONE_CONFIG=/dev/null

# One -r flag per recipient. An age public key is "age1" and 58 lowercase letters and
# digits; anything else is a typo that would encrypt to nobody useful.
age_arguments=()
set -f
for recipient in ${LB_BACKUP_AGE_RECIPIENTS//,/ }; do
    if ! [[ "$recipient" =~ ^age1[a-z0-9]{58}$ ]]; then
        echo "backup: '$recipient' in LB_BACKUP_AGE_RECIPIENTS is not an age public key." >&2
        exit 1
    fi
    age_arguments+=(-r "$recipient")
done
set +f

work="$(mktemp -d /tmp/lb-backup.XXXXXX)"
trap 'rm -rf "$work"' EXIT
name="lb-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

# pipefail makes a failing pg_dump fail the whole line, not just the last command.
pg_dump "${dump_arguments[@]}" --dbname="$PGDATABASE" | age "${age_arguments[@]}" > "$work/$name"

# A real age file starts with this line; an empty or truncated one would not.
if [ "$(head -c 21 "$work/$name")" != "age-encryption.org/v1" ]; then
    echo "backup: the encrypted file does not look like an age file." >&2
    exit 1
fi
bytes="$(wc -c < "$work/$name")"
recipient_count=$((${#age_arguments[@]} / 2))

rclone copyto "$work/$name" "$LB_BACKUP_DESTINATION/$name" --retries 3 --low-level-retries 5
echo "backup: uploaded $name ($bytes bytes, encrypted to $recipient_count recipient(s))"
