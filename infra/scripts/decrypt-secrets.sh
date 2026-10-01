#!/bin/bash
# Decrypts this release's secrets into a memory-backed folder, where Compose reads them.
# The deploy runs it on the box before it starts anything, and the lb-secrets systemd unit
# runs it again after a reboot, when /run is empty. Nothing decrypted is ever written to
# disk: the script refuses a folder that is not a tmpfs.
#
#   infra/scripts/decrypt-secrets.sh
#
#   SOPS_AGE_KEY_FILE   the box's private age key (default /etc/lb/age.key, mode 600)
#   LB_SECRETS_DIR      where the decrypted files go (default /run/lb/secrets), a tmpfs
#
# For each template infra/secrets/<name>.example.env there must be a
# infra/secrets/<name>.enc.env, and the script writes $LB_SECRETS_DIR/<name>.env (mode 600)
# from it after checking it against the template (check-secret-file.sh). Everything is
# decrypted and checked in a staging folder first, and only moved into place when every
# file passed, so a bad release stops here and leaves the running release's secrets alone.
# Files left over from a release that had more secrets are removed.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="$(cd "$here/.." && pwd)"
out="${LB_SECRETS_DIR:-/run/lb/secrets}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/etc/lb/age.key}"

fail() {
    echo "decrypt-secrets: $*" >&2
    exit 1
}

command -v sops >/dev/null 2>&1 || fail "sops is not installed on this machine (docs/DEPLOY.md, The box)."
[ -f "$SOPS_AGE_KEY_FILE" ] || fail "the box's age key $SOPS_AGE_KEY_FILE does not exist."
key_mode="$(stat -c %a "$SOPS_AGE_KEY_FILE")"
case "$key_mode" in
    400 | 600) ;;
    *) fail "$SOPS_AGE_KEY_FILE must be readable by its owner only (mode 600), not $key_mode." ;;
esac

mkdir -p "$out"
chmod 0700 "$out"
filesystem="$(stat -f -c %T "$out")"
case "$filesystem" in
    tmpfs | ramfs) ;;
    *) fail "$out is on a $filesystem filesystem, not in memory. Refusing to write secrets to disk." ;;
esac

staging="$(mktemp -d "$out/.staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

for template in "$infra"/secrets/*.example.env; do
    name="$(basename "$template" .example.env)"
    encrypted="$infra/secrets/$name.enc.env"
    [ -f "$encrypted" ] || fail "infra/secrets/$name.enc.env does not exist, and the release needs it (just secrets-new $name)."
    sops decrypt --input-type dotenv --output-type dotenv "$encrypted" > "$staging/$name.env" \
        || fail "infra/secrets/$name.enc.env cannot be decrypted with $SOPS_AGE_KEY_FILE."
    if ! problems="$("$here/check-secret-file.sh" "$template" "$staging/$name.env")"; then
        echo "decrypt-secrets: infra/secrets/$name.enc.env is not complete:" >&2
        printf '%s\n' "$problems" | sed 's/^/  /' >&2
        exit 1
    fi
done

# Every file passed: replace the live ones, and drop any that this release no longer has.
for old in "$out"/*.env; do
    [ -e "$old" ] || continue
    [ -e "$staging/$(basename "$old")" ] || rm -f "$old"
done
mv "$staging"/*.env "$out"/
echo "decrypt-secrets: wrote $(find "$out" -maxdepth 1 -name '*.env' | wc -l | tr -d ' ') files to $out"
