#!/bin/sh
# Entrypoint of the egress proxy image: writes the allowlist from LB_EGRESS_ALLOW, then
# runs Squid in the foreground.
#
# LB_EGRESS_ALLOW is a list of host names separated by commas or spaces, such as
# "api.groq.com,openrouter.ai". A leading dot allows the host and all its subdomains. The
# list comes from the compose file, not from a visitor, but it is still checked: a typo
# must stop the proxy rather than quietly allow or refuse the wrong thing. An empty list
# is valid and means "nothing may leave" (the safe state before a service needs a host).
set -eu

allowlist_dir=/run/lb-egress
allowlist="$allowlist_dir/allowed-hosts.txt"

if [ ! -d "$allowlist_dir" ] || [ ! -w "$allowlist_dir" ]; then
    echo "lb-egress: $allowlist_dir must be a writable tmpfs (see the tmpfs entry in docker-compose.yml)." >&2
    exit 1
fi

: > "$allowlist"
count=0
# No globbing: an entry such as "*" must be judged as text, not expanded to file names.
set -f
# Splitting on whitespace is the point here, so the expansion stays unquoted.
# shellcheck disable=SC2046
for entry in $(printf '%s' "${LB_EGRESS_ALLOW:-}" | tr ',' ' '); do
    # Lowercase letters, digits and hyphens in dot-separated labels, at least two labels.
    if ! printf '%s\n' "$entry" | grep -Eq '^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
        echo "lb-egress: '$entry' in LB_EGRESS_ALLOW is not a lowercase host name." >&2
        exit 1
    fi
    printf '%s\n' "$entry" >> "$allowlist"
    count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
    echo "lb-egress: LB_EGRESS_ALLOW is empty, so every tunnel will be refused." >&2
else
    echo "lb-egress: allowing HTTPS tunnels to $count host name(s): $(tr '\n' ' ' < "$allowlist")" >&2
fi

exec squid -N -f /etc/squid/squid.conf
