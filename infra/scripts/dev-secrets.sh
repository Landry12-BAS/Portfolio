#!/bin/bash
# Makes throwaway secrets for a local stack: random passwords and fresh keys, in the same
# files and under the same variable names as the encrypted secrets of the box
# (infra/secrets/README.md), so `just stack` runs the very same compose file the box does.
# Nothing in them is reused from, or can open, anything real: delete .dev and make them
# again whenever you like.
#
#   infra/scripts/dev-secrets.sh            # makes them if they are not there yet
#   infra/scripts/dev-secrets.sh --again    # replaces them with new ones
#
# They go to infra/.dev/secrets (or $LB_SECRETS_DIR), readable by you alone, and git
# ignores the folder. The private halves of the two throwaway keys (the site's, which signs
# visitor tokens, and the web service's) go to infra/.dev/keys, for trying the API by hand.
# Needs openssl 1.1.1 or later (Ed25519) and age.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="$(cd "$here/.." && pwd)"
secrets_dir="${LB_SECRETS_DIR:-$infra/.dev/secrets}"
keys_dir="$(dirname "$secrets_dir")/keys"

if [ -e "$secrets_dir/compose.env" ] && [ "${1:-}" != "--again" ]; then
    echo "Local secrets already exist in $secrets_dir (use --again to replace them)."
    exit 0
fi

for tool in openssl age-keygen; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "dev-secrets.sh needs $tool." >&2
        exit 1
    fi
done

umask 077
rm -rf "$secrets_dir" "$keys_dir"
mkdir -p "$secrets_dir" "$keys_dir"
# Where the local backup service writes, as the unprivileged user inside its container.
mkdir -p "$(dirname "$secrets_dir")/backups"
chmod 0777 "$(dirname "$secrets_dir")/backups"

# A password in the alphabet the services accept (infra/postgres/provision.sh, infra/redis/entrypoint.sh).
token() { openssl rand -hex 24; }
# Standard base64 on one line, and the URL-safe form without padding that keys use.
base64_one_line() { openssl base64 -A; }
base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Prints "<private> <public>" for a new Ed25519 key, in the base64url form of a JWK's d and x.
ed25519_pair() {
    local pem private public
    pem="$(openssl genpkey -algorithm ed25519)"
    # The raw key is the last 32 bytes of the DER encoding, private and public alike.
    private="$(printf '%s\n' "$pem" | openssl pkey -outform DER | tail -c 32 | base64url)"
    public="$(printf '%s\n' "$pem" | openssl pkey -pubout -outform DER | tail -c 32 | base64url)"
    printf '%s %s\n' "$private" "$public"
}

# Writes a private key as the JWK file `just gateway-token keygen` makes, and prints its public half.
write_jwk() {
    local name="$1" private public
    read -r private public < <(ed25519_pair)
    printf '{"kty":"OKP","crv":"Ed25519","d":"%s","x":"%s","kid":"%s"}\n' "$private" "$public" "$name" > "$keys_dir/$name.jwk.json"
    printf '%s' "$public"
}

django_public="$(write_jwk django-systems)"
flask_public="$(write_jwk flask-systems)"
node_public="$(write_jwk node-systems)"
web_public="$(write_jwk web)"
site_public="$(write_jwk site)"
django_jwk_b64="$(base64_one_line < "$keys_dir/django-systems.jwk.json")"
flask_jwk_b64="$(base64_one_line < "$keys_dir/flask-systems.jwk.json")"
node_jwk_b64="$(base64_one_line < "$keys_dir/node-systems.jwk.json")"

# The backup is encrypted to a public key whose private half stays off the "box": here, with
# the other keys, so the restore can be tried.
age-keygen -o "$keys_dir/backup.age.key" >/dev/null 2>&1
age_public="$(age-keygen -y "$keys_dir/backup.age.key")"

cat > "$secrets_dir/compose.env" <<EOF
LB_TAG=dev
LB_API_HOST=localhost
LB_SITE_ORIGIN=http://localhost:3000
LB_WEB_TOKEN_KEY=$site_public
LB_EGRESS_SYSTEMS_ALLOW=
LB_LB03_BUCKET=lb-uploads
LB_R2_ENDPOINT=https://local-stack.r2.invalid
EOF

cat > "$secrets_dir/postgres.env" <<EOF
POSTGRES_PASSWORD=$(token)
EOF

cat > "$secrets_dir/postgres-roles.env" <<EOF
LB_PG_PASSWORD_LB01=$(token)
LB_PG_PASSWORD_LB02=$(token)
LB_PG_PASSWORD_LB03=$(token)
LB_PG_PASSWORD_LB05=$(token)
LB_PG_PASSWORD_LB08=$(token)
LB_PG_PASSWORD_LB04=$(token)
LB_PG_PASSWORD_LB09=$(token)
LB_PG_PASSWORD_LBBACKUP=$(token)
EOF

cat > "$secrets_dir/redis.env" <<EOF
LB_REDIS_PASSWORD_GATEWAY=$(token)
LB_REDIS_PASSWORD_DJANGO_SYSTEMS=$(token)
LB_REDIS_PASSWORD_FLASK_SYSTEMS=$(token)
LB_REDIS_PASSWORD_NODE_SYSTEMS=$(token)
LB_REDIS_PASSWORD_HEALTH=$(token)
LB_REDIS_PASSWORD_ADMIN=$(token)
EOF

# A provider key only has to exist for the gateway to count the provider as configured; the
# local stack's networks reach no provider, so it is never sent anywhere.
cat > "$secrets_dir/gateway.env" <<EOF
LB_SERVICE_KEYS='{"django-systems":"$django_public","flask-systems":"$flask_public","node-systems":"$node_public","web":"$web_public"}'
GROQ_API_KEY=local-stack-never-sent-anywhere
EOF

cat > "$secrets_dir/django-systems.env" <<EOF
DJANGO_SECRET_KEY=$(token)$(token)
LB_SERVICE_KEY_JWK_B64=$django_jwk_b64
EOF

# The R2 token is never used here: the local stack keeps LB-03's files on a memory-backed
# folder (docker-compose.dev.yml), and its networks reach no bucket.
cat > "$secrets_dir/flask-systems.env" <<EOF
LB_SERVICE_KEY_JWK_B64=$flask_jwk_b64
LB03_S3_ACCESS_KEY_ID=local-stack-never-sent-anywhere
LB03_S3_SECRET_ACCESS_KEY=local-stack-never-sent-anywhere
EOF

cat > "$secrets_dir/node-systems.env" <<EOF
LB_SERVICE_KEY_JWK_B64=$node_jwk_b64
EOF

# No tunnel locally: there is no token to put here, and cloudflared is not started.
cat > "$secrets_dir/cloudflared.env" <<EOF
# TUNNEL_TOKEN comes from Cloudflare; a local stack runs without the tunnel.
EOF

cat > "$secrets_dir/backup.env" <<EOF
LB_BACKUP_AGE_RECIPIENTS=$age_public
LB_BACKUP_DESTINATION=/backups
EOF

echo "Made throwaway secrets for a local stack in $secrets_dir (private keys in $keys_dir)."
