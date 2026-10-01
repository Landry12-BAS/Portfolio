#!/bin/bash
# Tests the secrets tooling with the real sops and age, in a throwaway copy of the
# repository's infra folder, with throwaway keys:
#
#   - check-secret-file.sh names what is missing, empty, misspelled, repeated or unfinished
#     in a secrets file, and never prints a value;
#   - secrets.sh refuses to encrypt before a key is listed, makes your key, makes each file
#     from its template with random values, checks them, and lets the box's key in;
#   - a key that is not listed opens nothing, and `rekey` shuts a removed key out;
#   - decrypt-secrets.sh writes only to memory, only with a private key kept private, only
#     complete files, and leaves the running release's files alone when anything is wrong;
#   - Compose accepts the files it writes.
#
# Your real key, .sops.yaml and secrets are never read. Needs sops and age; the decrypt
# tests also need a tmpfs at /dev/shm and a docker with Compose, and are skipped without them.
#
#   infra/scripts/test-secrets.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
shm=""
failures=0

cleanup() {
    rm -rf "$work"
    if [ -n "$shm" ]; then
        rm -rf "$shm"
    fi
}
trap cleanup EXIT

for tool in sops age-keygen openssl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "test-secrets: $tool is not installed." >&2
        exit 1
    fi
done

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

# Runs a command, keeping what it printed in $output and its exit status in $status.
run() {
    status=0
    output="$("$@" 2>&1)" || status=$?
}

# expect_ok <label> <command...>
expect_ok() {
    local label="$1"
    shift
    run "$@"
    if [ "$status" -eq 0 ]; then pass "$label"; else fail "$label -- exit $status: $output"; fi
}

# expect_refused <label> <fragment of the message> <command...>: it must fail, and say why.
expect_refused() {
    local label="$1" fragment="$2"
    shift 2
    run "$@"
    if [ "$status" -ne 0 ] && grep -qF -- "$fragment" <<<"$output"; then
        pass "$label"
    else
        fail "$label -- exit $status, output: $output"
    fi
}

# expect_equal <label> <expected> <actual>
expect_equal() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- expected '$2', got '$3'"; fi
}

# ------------------------------------------------------------------------------------------
# The files under test, copied so that nothing real is touched
# ------------------------------------------------------------------------------------------
mkdir -p "$work/repo" "$work/keys"
tar -C "$repo" --exclude=infra/.dev --exclude='*.enc.env' -cf - infra .sops.yaml | tar -C "$work/repo" -xf -
# The committed .sops.yaml may by now list the owner's real key; the tests start from none.
sed '/^[[:space:]]*-[[:space:]]*age1[a-z0-9]\{58\}/d' "$repo/.sops.yaml" > "$work/repo/.sops.yaml"

secrets="$work/repo/infra/scripts/secrets.sh"
checker="$work/repo/infra/scripts/check-secret-file.sh"
decrypt="$work/repo/infra/scripts/decrypt-secrets.sh"
owner_key="$work/keys/owner.txt"
box_key="$work/keys/box.txt"
stranger_key="$work/keys/stranger.txt"

unset SOPS_EDITOR VISUAL
export SOPS_AGE_KEY_FILE="$owner_key"

# Stands in for a person at an editor: gives every empty variable a value of the right shape.
cat > "$work/fill-editor.sh" <<'EDITOR_SCRIPT'
#!/bin/bash
set -euo pipefail
file="$1"
tmp="$(mktemp)"
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        LB_API_HOST=) echo "LB_API_HOST=api.test.invalid" ;;
        LB_SITE_ORIGIN=) echo "LB_SITE_ORIGIN=https://test.invalid" ;;
        LB_EGRESS_SYSTEMS_ALLOW=) echo "LB_EGRESS_SYSTEMS_ALLOW=acct.r2.cloudflarestorage.com" ;;
        LB_SERVICE_KEYS=) echo "LB_SERVICE_KEYS='{\"django-systems\":\"AAAA\",\"web\":\"BBBB\"}'" ;;
        [A-Z]*=) echo "${line}filled-by-the-test" ;;
        *) printf '%s\n' "$line" ;;
    esac
done < "$file" > "$tmp"
cat "$tmp" > "$file"
rm -f "$tmp"
EDITOR_SCRIPT
# An editor that must never be opened: it leaves a marker behind when it is.
cat > "$work/unwanted-editor.sh" <<EDITOR_SCRIPT
#!/bin/bash
touch "$work/editor-was-opened"
EDITOR_SCRIPT
# Changes the file with a sed expression, such as a misspelled name.
cat > "$work/sed-editor.sh" <<'EDITOR_SCRIPT'
#!/bin/bash
set -euo pipefail
tmp="$(mktemp)"
sed -e "$1" "$2" > "$tmp"
cat "$tmp" > "$2"
rm -f "$tmp"
EDITOR_SCRIPT
chmod +x "$work/fill-editor.sh" "$work/unwanted-editor.sh" "$work/sed-editor.sh"

# ------------------------------------------------------------------------------------------
echo "check-secret-file.sh"
# ------------------------------------------------------------------------------------------
cat > "$work/template.env" <<'TEMPLATE'
# A description is not a variable.
REQUIRED_ONE=
REQUIRED_TWO=a-default
# OPTIONAL_ONE=
TEMPLATE

check_text() {
    printf '%b' "$1" > "$work/candidate.env"
    run "$checker" "$work/template.env" "$work/candidate.env"
}

check_text 'REQUIRED_ONE=one\nREQUIRED_TWO=two\n'
expect_equal "a complete file passes" "0" "$status"
check_text '# comments and blank lines are fine\n\nREQUIRED_ONE=one\nREQUIRED_TWO=two\nOPTIONAL_ONE=three\n'
expect_equal "a file that also sets an optional variable passes" "0" "$status"
check_text 'REQUIRED_ONE=one\n'
expect_equal "a missing variable is named" "REQUIRED_TWO is missing" "$output"
check_text 'REQUIRED_ONE=\nREQUIRED_TWO=two\n'
expect_equal "an empty variable is named" "REQUIRED_ONE is empty" "$output"
check_text "REQUIRED_ONE=''\nREQUIRED_TWO=\"\"\n"
expect_equal "quoted nothing is empty too" "REQUIRED_ONE is empty
REQUIRED_TWO is empty" "$output"
check_text 'REQUIRED_ONE=one\nREQUIRED_TWO=two\nREQUIRED_THRE=3\n'
expect_equal "a misspelled variable is named" "REQUIRED_THRE is not a variable of the template" "$output"
check_text 'REQUIRED_ONE=one\nREQUIRED_TWO=two\nREQUIRED_ONE=again\n'
expect_equal "a repeated variable is named" "REQUIRED_ONE is set twice" "$output"
check_text 'REQUIRED_ONE=@token\nREQUIRED_TWO=two\n'
expect_equal "a placeholder nobody replaced is named" "REQUIRED_ONE still holds the @token placeholder: make the file with just secrets-new" "$output"
check_text 'REQUIRED_ONE=one\r\nREQUIRED_TWO=two\r\n'
expect_equal "Windows line endings are named" "line 1 ends with a carriage return
line 2 ends with a carriage return" "$output"
check_text 'REQUIRED_ONE=hunter2-the-secret\nREQUIRED_TWO=two\nOTHER=hunter2-the-secret\nhunter2-the-secret\n'
if grep -q 'hunter2' <<<"$output"; then fail "a value reached the output: $output"; else pass "no value reaches the output, whatever is wrong"; fi
run "$checker" "$work/template.env" < "$work/candidate.env"
expect_equal "it reads standard input when no file is given" "1" "$status"
expect_refused "an empty template is refused" "missing or empty" "$checker" "$work/nothing.env" "$work/candidate.env"

# ------------------------------------------------------------------------------------------
echo "secrets.sh: before any key exists"
# ------------------------------------------------------------------------------------------
expect_refused "the committed .sops.yaml lists no key, so nothing can be encrypted" "just secrets-init" \
    env EDITOR="$work/unwanted-editor.sh" "$secrets" new redis
expect_refused "a name that is not a file name is refused" "does not name a secrets file" "$secrets" new "Not A Name"
expect_refused "a file without a template is refused" "there is no template" "$secrets" new nosuchfile

echo "secrets.sh init"
expect_ok "init makes your key" "$secrets" init
expect_equal "the private key is readable by its owner only" "600" "$(stat -c %a "$owner_key" 2>/dev/null || stat -f %Lp "$owner_key")"
public_key="$(age-keygen -y "$owner_key")"
expect_equal ".sops.yaml now lists exactly that public key" "$public_key" "$(sed -n 's/^[[:space:]]*-[[:space:]]*\(age1[a-z0-9]\{58\}\).*/\1/p' "$work/repo/.sops.yaml")"
if grep -Eq 'AGE-SECRET-KEY-1[0-9A-Z]{58}' "$work/repo/.sops.yaml"; then fail "a private key reached .sops.yaml"; else pass "no private key reaches .sops.yaml"; fi
cp "$work/repo/.sops.yaml" "$work/sops-after-init.yaml"
expect_ok "init a second time is harmless" "$secrets" init
if cmp -s "$work/sops-after-init.yaml" "$work/repo/.sops.yaml"; then pass "and changes nothing"; else fail "init a second time changed .sops.yaml"; fi

# ------------------------------------------------------------------------------------------
echo "secrets.sh new, edit and check"
# ------------------------------------------------------------------------------------------
rm -f "$work/editor-was-opened"
expect_ok "a file whose values are all made for you needs no editor" env EDITOR="$work/unwanted-editor.sh" "$secrets" new redis
if [ -e "$work/editor-was-opened" ]; then fail "redis opened an editor"; else pass "it opened no editor"; fi
redis_plain="$(sops decrypt "$work/repo/infra/secrets/redis.enc.env")"
gateway_password="$(sed -n 's/^LB_REDIS_PASSWORD_GATEWAY=//p' <<<"$redis_plain")"
admin_password="$(sed -n 's/^LB_REDIS_PASSWORD_ADMIN=//p' <<<"$redis_plain")"
if [[ "$gateway_password" =~ ^[0-9a-f]{48}$ ]]; then pass "each password is 48 random hex characters"; else fail "a password is not 48 hex characters: ${#gateway_password} characters"; fi
if [ "$gateway_password" != "$admin_password" ]; then pass "and each is different"; else fail "two passwords are equal"; fi
if grep -qF "$gateway_password" "$work/repo/infra/secrets/redis.enc.env"; then fail "a password is readable in the encrypted file"; else pass "the file holds no password in the clear"; fi
if grep -q '^LB_REDIS_PASSWORD_GATEWAY=ENC\[' "$work/repo/infra/secrets/redis.enc.env"; then pass "variable names stay readable and values are encrypted"; else fail "the encrypted file is not in the expected form"; fi
expect_refused "making a file that exists is refused" "already exists" "$secrets" new redis

expect_ok "postgres" "$secrets" new postgres
expect_ok "postgres-roles" "$secrets" new postgres-roles
echo "  (the gateway's values are the owner's own: an editor that fills nothing leaves it unfinished)"
expect_refused "gateway is made, and named as unfinished" "LB_SERVICE_KEYS is empty" env EDITOR=true "$secrets" new gateway
run "$secrets" check
if [ "$status" -ne 0 ] && grep -qF "compose.enc.env does not exist" <<<"$output" && grep -qF "GROQ_API_KEY is empty" <<<"$output"; then
    pass "check names the unfinished file and the files never made"
else
    fail "check did not name what is missing -- exit $status: $output"
fi
expect_ok "editing it, a person fills the values" env EDITOR="$work/fill-editor.sh" "$secrets" edit gateway
for name in compose cloudflared backup django-systems; do
    expect_ok "$name is made, and filled in" env EDITOR="$work/fill-editor.sh" "$secrets" new "$name"
done
expect_equal "the Django secret key is long enough (Django needs 50 characters)" "64" \
    "$(sops decrypt "$work/repo/infra/secrets/django-systems.enc.env" | sed -n 's/^DJANGO_SECRET_KEY=//p' | tr -d '\n' | wc -c | tr -d ' ')"
expect_ok "check passes when all eight files are complete" "$secrets" check
expect_equal "and it says so for every one of them" "8" "$(grep -c '^  ok ' <<<"$output")"

expect_refused "a misspelled variable fails the check" "GROQ_API_KEI is not a variable of the template" \
    env EDITOR="$work/sed-editor.sh s/^GROQ_API_KEY=/GROQ_API_KEI=/" "$secrets" edit gateway
run "$secrets" check
if grep -qF "GROQ_API_KEY is missing" <<<"$output"; then pass "which also names the variable that went missing"; else fail "the missing variable was not named: $output"; fi
expect_ok "fixing it passes again" env EDITOR="$work/sed-editor.sh s/^GROQ_API_KEI=/GROQ_API_KEY=/" "$secrets" edit gateway

cp "$work/repo/infra/secrets/backup.enc.env" "$work/repo/infra/secrets/stray.enc.env"
expect_refused "an encrypted file with no template is named" "there is no template stray.example.env" "$secrets" check
rm -f "$work/repo/infra/secrets/stray.enc.env"

expect_equal "token makes 48 hex characters by default" "48" "$("$secrets" token | tr -d '\n' | wc -c | tr -d ' ')"
expect_equal "token takes a size in bytes" "64" "$("$secrets" token 32 | tr -d '\n' | wc -c | tr -d ' ')"
expect_refused "a token shorter than the services accept is refused" "16 to 64 bytes" "$secrets" token 8

# ------------------------------------------------------------------------------------------
echo "secrets.sh add-recipient, and who can open what"
# ------------------------------------------------------------------------------------------
age-keygen -o "$box_key" >/dev/null 2>&1
age-keygen -o "$stranger_key" >/dev/null 2>&1
box_public="$(age-keygen -y "$box_key")"

opens() { SOPS_AGE_KEY_FILE="$1" sops decrypt "$work/repo/infra/secrets/gateway.enc.env" >/dev/null 2>&1; }
if opens "$box_key"; then fail "the box's key opened a file before it was listed"; else pass "an unlisted key opens nothing"; fi
expect_refused "a malformed key is refused" "not an age public key" "$secrets" add-recipient box "age1tooshort"
expect_refused "a label that is not one short word is refused" "one short word" "$secrets" add-recipient "two words" "$box_public"
expect_ok "the box's key is added" "$secrets" add-recipient box "$box_public"
if opens "$box_key"; then pass "the box's key now opens the files"; else fail "the box's key does not open the files"; fi
if opens "$owner_key"; then pass "and the owner's key still does"; else fail "the owner's key stopped working"; fi
if opens "$stranger_key"; then fail "a stranger's key opened a file"; else pass "a stranger's key still opens nothing"; fi
expect_equal "every file lists both recipients" "16" "$(cat "$work"/repo/infra/secrets/*.enc.env | grep -c '^sops_age__list_[01]__map_recipient=')"
expect_refused "listing a key twice is refused" "already listed" "$secrets" add-recipient again "$box_public"
expect_equal ".sops.yaml says whose key is whose" "2" "$(grep -c -E '# (owner|box)$' "$work/repo/.sops.yaml")"

echo "secrets.sh rekey"
sed "/$box_public/d" "$work/repo/.sops.yaml" > "$work/sops-without-box.yaml"
cat "$work/sops-without-box.yaml" > "$work/repo/.sops.yaml"
expect_ok "rekey after taking the box's key out" "$secrets" rekey
if opens "$box_key"; then fail "the removed key still opens the files"; else pass "the removed key no longer opens them"; fi
if opens "$owner_key"; then pass "the owner's key still does"; else fail "the owner's key stopped working"; fi
expect_ok "the box is let back in" "$secrets" add-recipient box "$box_public"

# ------------------------------------------------------------------------------------------
echo "decrypt-secrets.sh"
# ------------------------------------------------------------------------------------------
if [ "$(stat -f -c %T /dev/shm 2>/dev/null || true)" != tmpfs ]; then
    echo "  skip  there is no tmpfs at /dev/shm on this machine"
else
    shm="$(mktemp -d /dev/shm/lb-secrets-test.XXXXXX)"
    live="$shm/live"
    cp "$box_key" "$work/keys/box-key-for-decrypt.txt"
    chmod 600 "$work/keys/box-key-for-decrypt.txt"
    decrypt_with() {
        SOPS_AGE_KEY_FILE="$1" LB_SECRETS_DIR="$live" "$decrypt"
    }

    expect_ok "the box's key decrypts every file into memory" decrypt_with "$work/keys/box-key-for-decrypt.txt"
    expect_equal "one file per template" "8" "$(find "$live" -maxdepth 1 -name '*.env' | wc -l | tr -d ' ')"
    expect_equal "each one is readable by its owner only" "8" "$(find "$live" -maxdepth 1 -name '*.env' -perm 600 | wc -l | tr -d ' ')"
    expect_equal "the folder is private too" "700" "$(stat -c %a "$live")"
    expect_equal "no staging folder is left behind" "0" "$(find "$live" -mindepth 1 -type d | wc -l | tr -d ' ')"
    if grep -q '^LB_REDIS_PASSWORD_GATEWAY=[0-9a-f]\{48\}$' "$live/redis.env"; then pass "the files are the plain dotenv Compose reads"; else fail "redis.env is not as expected"; fi

    if docker compose version >/dev/null 2>&1; then
        run env LB_TAG=test LB_SECRETS_DIR="$live" "$work/repo/infra/scripts/compose.sh" config --quiet
        expect_equal "Compose accepts them" "0" "$status"
        if [ "$status" -ne 0 ]; then echo "$output" >&2; fi
    else
        echo "  skip  Compose is not available here"
    fi

    echo "old" > "$live/stale.env"
    expect_ok "a second run replaces the files" decrypt_with "$work/keys/box-key-for-decrypt.txt"
    if [ -e "$live/stale.env" ]; then fail "a file from an earlier release was kept"; else pass "a file no release has any more is removed"; fi

    snapshot="$(cat "$live"/*.env | cksum)"
    unchanged() { [ "$(cat "$live"/*.env | cksum)" = "$snapshot" ]; }

    expect_refused "a key that is not one of the recipients is refused" "cannot be decrypted" decrypt_with "$stranger_key"
    if unchanged; then pass "and the running files are untouched"; else fail "files changed after a refused run"; fi

    cp "$box_key" "$work/keys/box-key-open.txt"
    chmod 644 "$work/keys/box-key-open.txt"
    expect_refused "a key that others can read is refused" "readable by its owner only" decrypt_with "$work/keys/box-key-open.txt"

    if [ "$(stat -f -c %T "$work")" = tmpfs ]; then
        echo "  skip  a folder on disk is refused (this machine's temporary folder is a tmpfs, so there is no disk to try)"
    else
        expect_refused "a folder that is not in memory is refused" "not in memory" \
            env SOPS_AGE_KEY_FILE="$work/keys/box-key-for-decrypt.txt" LB_SECRETS_DIR="$work/on-disk" "$decrypt"
    fi

    mv "$work/repo/infra/secrets/cloudflared.enc.env" "$work/cloudflared.enc.env.away"
    expect_refused "a release missing a secrets file stops the deploy" "cloudflared.enc.env does not exist" decrypt_with "$work/keys/box-key-for-decrypt.txt"
    if unchanged; then pass "and the running files are untouched"; else fail "files changed after a refused run"; fi
    mv "$work/cloudflared.enc.env.away" "$work/repo/infra/secrets/cloudflared.enc.env"

    SOPS_AGE_KEY_FILE="$owner_key" sops set "$work/repo/infra/secrets/cloudflared.enc.env" '["TUNNEL_TOKEN"]' '""' >/dev/null 2>&1
    expect_refused "a file with an empty secret stops the deploy, naming it" "TUNNEL_TOKEN is empty" decrypt_with "$work/keys/box-key-for-decrypt.txt"
    if unchanged; then pass "and the running files are untouched"; else fail "files changed after a refused run"; fi
fi

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
