#!/bin/sh
# Entrypoint of the Redis container: writes the ACL file from users.acl.tmpl, then runs the
# command it was given (redis-server).
#
# The template names every password as a placeholder, __HASH_<NAME>__, and the passwords
# themselves come from the environment, as LB_REDIS_PASSWORD_<NAME>, from the encrypted
# secrets file. This script hashes each one (Redis accepts a SHA-256 hash as well as a
# password), so even the file on the tmpfs holds no password. A placeholder without a
# variable, or a password that is too short or uses odd characters, stops the container:
# a user must never end up with an empty or guessable password. Redis refuses to start
# on a malformed ACL file too, so a typo in a rule fails the deploy instead of opening
# something.
#
# Lines of the template that end in a backslash continue on the next line, because Redis
# wants each user on one line and a user with several rules is unreadable that way.
set -eu

template=/etc/redis/users.acl.tmpl
acl_file=/run/redis/users.acl

if [ ! -d /run/redis ] || [ ! -w /run/redis ]; then
    echo "lb-redis: /run/redis must be a writable tmpfs (see the tmpfs entry in docker-compose.yml)." >&2
    exit 1
fi

umask 077
# Join continued lines, and squeeze the indentation that came with them.
awk '{ if (sub(/\\$/, "")) { printf "%s", $0 } else { print } }' "$template" | sed -E 's/[[:space:]]+/ /g; s/^ //' > "$acl_file"

placeholders=/run/redis/placeholders.txt
grep -o '__HASH_[A-Z0-9_]*__' "$acl_file" | sort -u > "$placeholders"
while read -r placeholder; do
    name="${placeholder#__HASH_}"
    name="${name%__}"
    variable="LB_REDIS_PASSWORD_$name"
    value="$(printenv "$variable" || true)"
    if [ -z "$value" ]; then
        echo "lb-redis: $variable is not set." >&2
        exit 1
    fi
    if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_-]{32,128}$'; then
        echo "lb-redis: $variable must be 32 to 128 letters, digits, '-' or '_'." >&2
        exit 1
    fi
    hash="$(printf '%s' "$value" | sha256sum | cut -d ' ' -f 1)"
    sed -i "s/$placeholder/$hash/g" "$acl_file"
done < "$placeholders"
rm -f "$placeholders"

exec "$@"
