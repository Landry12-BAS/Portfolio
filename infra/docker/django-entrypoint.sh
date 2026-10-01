#!/bin/sh
# Entrypoint of the Django systems image: it hands the service's private key to the
# process as the file lb-common reads, then starts the container's command.
#
# lb-common loads the key from a JWK file and refuses one that other users could read
# (python/lb-common/src/lb_common/tokens.py). The deploy hands the key over as one
# environment variable, LB_SERVICE_KEY_JWK_B64 (the file's contents in base64), because
# a file bind-mounted from the host would have to be owned by this container's user, and
# would be missing after a reboot until the next deploy decrypts it again. The file is
# written to a tmpfs that only this user can read, and the variable is dropped before
# the real command starts, so the service never sees the key twice.
set -eu

if [ -n "${LB_SERVICE_KEY_JWK_B64:-}" ]; then
    key_dir=/run/lb
    if [ ! -d "$key_dir" ] || [ ! -w "$key_dir" ]; then
        echo "lb-entrypoint: $key_dir must be a writable tmpfs (see the tmpfs entry in docker-compose.yml)." >&2
        exit 1
    fi
    key_file="$key_dir/service-key.jwk.json"
    umask 077
    if ! printf '%s' "$LB_SERVICE_KEY_JWK_B64" | base64 -d > "$key_file"; then
        echo "lb-entrypoint: LB_SERVICE_KEY_JWK_B64 is not valid base64." >&2
        exit 1
    fi
    LB_SERVICE_KEY_FILE="$key_file"
    export LB_SERVICE_KEY_FILE
    unset LB_SERVICE_KEY_JWK_B64
fi

exec "$@"
