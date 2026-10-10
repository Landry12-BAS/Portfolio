#!/bin/bash
# What the nightly backup and its test share: the arguments of the dump. It is sourced, never
# run: backup.sh uses it for the real backup, and infra/postgres/test-roles.sh for the proof
# that a dump leaves out what visitors upload.

# backup_dump_arguments <file of excluded tables>: prints, one a line, the arguments of the
# `pg_dump` that makes a backup: the custom format, and `--exclude-table-data` for each
# pattern the file lists (see excluded-data.txt for why).
backup_dump_arguments() {
    local list="$1" pattern
    [ -r "$list" ] || { echo "backup: $list cannot be read." >&2; return 1; }
    printf '%s\n' --format=custom
    while IFS= read -r pattern; do
        printf '%s\n' "--exclude-table-data=$pattern"
    done < <(sed 's/#.*//; s/[[:space:]]//g; /^$/d' "$list")
}
