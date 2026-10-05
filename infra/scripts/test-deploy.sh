#!/bin/bash
# Tests deploy.sh's decisions, with stand-ins for everything it drives (Compose, Docker,
# cosign, the decrypt and smoke steps), so that each path takes seconds and no container is
# started. The stand-ins write every call they get to a log, and fail when a file in
# $BEHAVIOUR says so. What it proves:
#
#   - a release is decrypted, pulled, signature-checked, started and smoke-tested, in that
#     order, and only then becomes `current`;
#   - an image this repository builds is checked with the image workflow's identity, a
#     digest-pinned third-party image is not, and a third-party image pinned by tag only
#     must be signed too, so it fails;
#   - an unsigned image, a failed pull or a failed decrypt stops the deploy before anything
#     is started, and puts the live release's secrets back;
#   - a release that does not come up (compose, smoke) is replaced by the previous one,
#     and `current` never moves; when that fails too the exit status is 2;
#   - a bad release name, a wrong folder, a mismatched RELEASE file and a second deploy at
#     the same time are refused;
#   - the nightly backup, started with its unit's own command (infra/systemd/lb-backup.service),
#     takes the deploy's lock: a deploy while it runs is refused, it waits for a deploy that is
#     running and then backs up the release that is live, and when it cannot get the lock in
#     its time it fails and backs up nothing;
#   - old releases are removed, and the live one and the one before it are kept.
#
#   infra/scripts/test-deploy.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
work="$(mktemp -d)"
work="$(cd "$work" && pwd -P)"
failures=0

cleanup() {
    rm -rf "$work"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() {
    printf '  FAIL  %s\n' "$1" >&2
    failures=$((failures + 1))
}

export CALLS="$work/calls.log"
export BEHAVIOUR="$work/behaviour"
export LB_SECRETS_DIR="$work/secrets"
export LB_ROOT="$work/root"
mkdir -p "$work/bin" "$BEHAVIOUR" "$LB_SECRETS_DIR"

# ------------------------------------------------------------------------------------------
# The stand-ins
# ------------------------------------------------------------------------------------------
# docker: answers the few questions deploy.sh asks, and logs them.
cat > "$work/bin/docker" <<'STUB'
#!/bin/bash
echo "docker $*" >> "$CALLS"
case "$1 $2" in
    "image inspect")
        image="${*: -1}"
        if [ -e "$BEHAVIOUR/no-digest" ]; then exit 1; fi
        printf '%s@sha256:%s\n' "${image%:*}" "$(printf '%s' "$image" | sha256sum | cut -d ' ' -f 1)"
        ;;
    "image ls")
        for argument in "$@"; do
            case "$argument" in
                reference=*) reference="${argument#reference=}" ;;
            esac
        done
        printf 'id-of-%s\n' "${reference##*:}"
        ;;
esac
exit 0
STUB

# cosign: logs the call, and fails for any image reference listed in $BEHAVIOUR/unsigned.
cat > "$work/bin/cosign" <<'STUB'
#!/bin/bash
echo "cosign $*" >> "$CALLS"
reference="${*: -1}"
if [ -s "$BEHAVIOUR/unsigned" ] && grep -qF -f "$BEHAVIOUR/unsigned" <<<"$reference"; then
    echo "no matching signatures" >&2
    exit 1
fi
exit 0
STUB
chmod +x "$work/bin/docker" "$work/bin/cosign"
export PATH="$work/bin:$PATH"

# sha <n>: the hash of the n-th fake commit.
sha() { printf '%040x' "$1"; }

# make_release <n>: a release folder as the deploy leaves it, with the real deploy.sh and
# stand-ins for the scripts it calls. A stand-in fails when $BEHAVIOUR holds a file named
# for the step and the release (fail-up-<release>, fail-smoke-<release>, ...), and takes
# three seconds over `up` or `run` when it holds slow-up or slow-run.
make_release() {
    local release dir
    release="$(sha "$1")"
    dir="$LB_ROOT/releases/$release/infra"
    mkdir -p "$dir/scripts"
    cp "$here/deploy.sh" "$dir/scripts/deploy.sh"
    printf '%s' "$release" > "$dir/RELEASE"

    cat > "$dir/scripts/compose.sh" <<'STUB'
#!/bin/bash
release="$(cat "$(dirname "$0")/../RELEASE")"
echo "compose $release tag=${LB_TAG:-unset} $*" >> "$CALLS"
case " $* " in
    *" config --images "*)
        printf 'ghcr.io/landry12-bas/lb-gateway:%s\nghcr.io/landry12-bas/lb-backup:%s\n' "$LB_TAG" "$LB_TAG"
        printf 'pgvector/pgvector:0.8.6-pg17-bookworm@sha256:%064d\n' 7
        if [ -e "$BEHAVIOUR/unpinned-image" ]; then cat "$BEHAVIOUR/unpinned-image"; fi
        ;;
    *" pull "*) if [ -e "$BEHAVIOUR/fail-pull-$release" ]; then exit 1; fi ;;
    *" up "*)
        if [ -e "$BEHAVIOUR/slow-up" ]; then sleep 3; fi
        if [ -e "$BEHAVIOUR/fail-up-$release" ]; then exit 1; fi
        ;;
    *" run "*)
        if [ -e "$BEHAVIOUR/slow-run" ]; then sleep 3; fi
        echo "compose $release run finished" >> "$CALLS"
        ;;
esac
exit 0
STUB
    cat > "$dir/scripts/decrypt-secrets.sh" <<'STUB'
#!/bin/bash
release="$(cat "$(dirname "$0")/../RELEASE")"
echo "decrypt $release" >> "$CALLS"
if [ -e "$BEHAVIOUR/fail-decrypt-$release" ]; then exit 1; fi
printf '%s' "$release" > "$LB_SECRETS_DIR/release"
STUB
    cat > "$dir/scripts/smoke.sh" <<'STUB'
#!/bin/bash
release="$(cat "$(dirname "$0")/../RELEASE")"
echo "smoke $release $*" >> "$CALLS"
if [ -e "$BEHAVIOUR/fail-smoke-$release" ]; then exit 1; fi
exit 0
STUB
    chmod +x "$dir/scripts/"*.sh
    # Releases are removed oldest first, by the age of their folder.
    touch -d "@$((1700000000 + $1 * 100))" "$LB_ROOT/releases/$release"
}

# reset: an empty box, with no calls logged and no behaviour requested.
reset() {
    rm -rf "$LB_ROOT" "$BEHAVIOUR" "$LB_SECRETS_DIR"
    mkdir -p "$LB_ROOT/releases" "$BEHAVIOUR" "$LB_SECRETS_DIR"
    : > "$CALLS"
}

# deploy <n>: runs the n-th release's own deploy.sh, keeping its output and exit status.
deploy() {
    local release
    release="$(sha "$1")"
    status=0
    output="$("$LB_ROOT/releases/$release/infra/scripts/deploy.sh" "$release" 2>&1)" || status=$?
}

# live: the release `current` points at, as a number, or "none".
live() {
    if [ -L "$LB_ROOT/current" ]; then
        printf '%d' "0x$(basename "$(readlink "$LB_ROOT/current")")"
    else
        printf 'none'
    fi
}

expect_equal() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- expected '$2', got '$3'"; fi
}

# expect_in_order <label> <text>...: each text is in the call log, after the one before it.
expect_in_order() {
    local label="$1" last=0 text line
    shift
    for text in "$@"; do
        line="$(awk -v start="$last" -v text="$text" 'NR > start && index($0, text) { print NR; exit }' "$CALLS")"
        if [ -z "$line" ]; then
            fail "$label -- '$text' was not called after line $last"
            return
        fi
        last="$line"
    done
    pass "$label"
}

# expect_not_called <label> <text>
expect_not_called() {
    if grep -qF -- "$2" "$CALLS"; then fail "$1 -- '$2' was called"; else pass "$1"; fi
}

# expect_output <label> <text>: deploy.sh said it.
expect_output() {
    if grep -qF -- "$2" <<<"$output"; then pass "$1"; else fail "$1 -- the output was: $output"; fi
}

# wait_for_call <text>: waits until a call containing the text is logged, ten seconds at most.
wait_for_call() {
    local tries=0
    until grep -qF -- "$1" "$CALLS"; do
        tries=$((tries + 1))
        if [ "$tries" -gt 100 ]; then return 1; fi
        sleep 0.1
    done
}

# The nightly backup as its unit starts it: the unit's own command, which systemd runs without a
# shell, with the box's /opt/lb moved to this test's root.
backup_unit="$here/../systemd/lb-backup.service"
read -ra unit_command <<<"$(sed -n 's/^ExecStart=//p' "$backup_unit")"
backup_command=()
for word in "${unit_command[@]}"; do
    backup_command+=("${word/#\/opt\/lb/$LB_ROOT}")
done

# backup [wait seconds]: runs the backup's command, waiting the given time for the lock instead
# of the unit's own when one is given, and keeps its exit status and output.
backup() {
    local -a command=("${backup_command[@]}")
    local index
    if [ -n "${1:-}" ]; then
        for index in "${!command[@]}"; do
            if [ "${command[$index]}" = --wait ]; then command[index + 1]="$1"; fi
        done
    fi
    backup_status=0
    backup_output="$("${command[@]}" 2>&1)" || backup_status=$?
}

a="$(sha 1)"
b="$(sha 2)"

# ------------------------------------------------------------------------------------------
echo "a good release"
# ------------------------------------------------------------------------------------------
reset
make_release 1
deploy 1
expect_equal "the first deploy succeeds" "0" "$status"
expect_equal "and the release becomes current" "1" "$(live)"
expect_in_order "the steps run in order" \
    "decrypt $a" \
    "compose $a tag=$a --profile backup pull" \
    "cosign verify" \
    "compose $a tag=$a up --detach --pull never --remove-orphans --wait" \
    "smoke $a --public"
expect_equal "each image this repository builds is checked, and no other" "2" "$(grep -c '^cosign verify' "$CALLS")"
if grep '^cosign verify' "$CALLS" | grep -qF -- "--certificate-oidc-issuer https://token.actions.githubusercontent.com"; then
    pass "cosign is told to expect GitHub's OIDC issuer"
else
    fail "cosign was not told to expect GitHub's OIDC issuer"
fi
if grep '^cosign verify' "$CALLS" | grep -qF -- 'Landry12-BAS/Portfolio/\.github/workflows/(images|deploy)\.yml@refs/heads/main$'; then
    pass "and this repository's image workflow, from main, as the signer"
else
    fail "the signer identity is not the repository's image workflow: $(grep '^cosign verify' "$CALLS" | head -1)"
fi
if grep '^cosign verify' "$CALLS" | grep -qE '@sha256:[0-9a-f]{64}$'; then
    pass "an image is checked by the digest it was pulled as"
else
    fail "cosign was not given a digest: $(grep '^cosign verify' "$CALLS" | head -1)"
fi
expect_not_called "a digest-pinned third-party image needs no signature" "pgvector"
expect_in_order "unused images are pruned once it is live" "smoke $a --public" "docker image prune"
expect_output "the output says the release is live" "release $a is live"

# ------------------------------------------------------------------------------------------
echo "a second release"
# ------------------------------------------------------------------------------------------
make_release 2
: > "$CALLS"
deploy 2
expect_equal "it succeeds" "0" "$status"
expect_equal "and replaces the first as current" "2" "$(live)"
if [ -d "$LB_ROOT/releases/$a" ]; then pass "the first release stays, as the one to go back to"; else fail "the first release was removed"; fi
expect_equal "the deploy log records both" "2" "$(wc -l < "$LB_ROOT/deploys.log" | tr -d ' ')"
expect_equal "the live secrets are the new release's" "$b" "$(cat "$LB_SECRETS_DIR/release")"

# ------------------------------------------------------------------------------------------
echo "a release that does not come up"
# ------------------------------------------------------------------------------------------
make_release 3
touch "$BEHAVIOUR/fail-up-$(sha 3)"
: > "$CALLS"
deploy 3
expect_equal "compose failing: the deploy fails with 1" "1" "$status"
expect_equal "and current never moved" "2" "$(live)"
expect_in_order "the previous release is decrypted, started and tested again" \
    "compose $(sha 3) tag=$(sha 3) up" \
    "decrypt $b" \
    "compose $b tag=$b up --detach --pull never" \
    "smoke $b"
expect_equal "its secrets are back" "$b" "$(cat "$LB_SECRETS_DIR/release")"
expect_output "the output says which release is running" "release $b is running again"

make_release 4
touch "$BEHAVIOUR/fail-smoke-$(sha 4)"
: > "$CALLS"
deploy 4
expect_equal "the smoke test failing: the deploy fails with 1" "1" "$status"
expect_equal "and current never moved" "2" "$(live)"
expect_in_order "the previous release is started" "smoke $(sha 4) --public" "compose $b tag=$b up"

# ------------------------------------------------------------------------------------------
echo "a release that is refused before anything starts"
# ------------------------------------------------------------------------------------------
make_release 5
echo "lb-gateway" > "$BEHAVIOUR/unsigned"
: > "$CALLS"
deploy 5
expect_equal "an unsigned image: the deploy fails with 1" "1" "$status"
expect_not_called "nothing is started" "compose $(sha 5) tag=$(sha 5) up"
expect_not_called "and nothing is rolled back, because nothing changed" "compose $b tag=$b up"
expect_in_order "the live release's secrets are put back" "decrypt $(sha 5)" "decrypt $b"
expect_equal "current did not move" "2" "$(live)"
expect_output "the output says it was refused" "refused before anything was started"
rm -f "$BEHAVIOUR/unsigned"

touch "$BEHAVIOUR/fail-pull-$(sha 5)"
: > "$CALLS"
deploy 5
expect_equal "a failed pull: the deploy fails with 1" "1" "$status"
expect_not_called "and nothing is started" "compose $(sha 5) tag=$(sha 5) up"
rm -f "$BEHAVIOUR/fail-pull-$(sha 5)"

touch "$BEHAVIOUR/fail-decrypt-$(sha 5)"
: > "$CALLS"
deploy 5
expect_equal "a failed decrypt: the deploy fails with 1" "1" "$status"
expect_not_called "and nothing is pulled" "pull"
rm -f "$BEHAVIOUR/fail-decrypt-$(sha 5)"

touch "$BEHAVIOUR/no-digest"
: > "$CALLS"
deploy 5
expect_equal "an image with no digest to check: the deploy fails with 1" "1" "$status"
expect_not_called "and the check is not skipped" "cosign verify"
rm -f "$BEHAVIOUR/no-digest"

echo "redis:8" > "$BEHAVIOUR/unpinned-image"
echo "redis" > "$BEHAVIOUR/unsigned"
: > "$CALLS"
deploy 5
expect_equal "a third-party image pinned by tag only must be signed, so it fails" "1" "$status"
expect_in_order "and it was checked" "cosign verify" "redis"
rm -f "$BEHAVIOUR/unpinned-image" "$BEHAVIOUR/unsigned"

# ------------------------------------------------------------------------------------------
echo "a rollback that fails too, and a first deploy that fails"
# ------------------------------------------------------------------------------------------
make_release 6
touch "$BEHAVIOUR/fail-up-$(sha 6)" "$BEHAVIOUR/fail-up-$b"
: > "$CALLS"
deploy 6
expect_equal "both failing: the exit status is 2" "2" "$status"
expect_output "and it says so" "THE ROLLBACK DID NOT WORK"
expect_equal "current still names the last good release" "2" "$(live)"
rm -f "$BEHAVIOUR/fail-up-$(sha 6)" "$BEHAVIOUR/fail-up-$b"

reset
make_release 1
touch "$BEHAVIOUR/fail-up-$a"
deploy 1
expect_equal "a first deploy that fails leaves nothing to go back to: 2" "2" "$status"
expect_output "and says that" "no earlier release"
expect_equal "and there is no current release" "none" "$(live)"

# ------------------------------------------------------------------------------------------
echo "refusals"
# ------------------------------------------------------------------------------------------
reset
make_release 1
status=0
output="$("$LB_ROOT/releases/$a/infra/scripts/deploy.sh" not-a-commit 2>&1)" || status=$?
expect_equal "a release that is not a commit hash is refused" "1" "$status"
expect_output "with the usage" "40-character git commit hash"

status=0
output="$("$LB_ROOT/releases/$a/infra/scripts/deploy.sh" "$(sha 9)" 2>&1)" || status=$?
expect_equal "a release run from another release's folder is refused" "1" "$status"
expect_output "and the message names the right folder" "run this from the release's own copy"

printf '%s' "$(sha 9)" > "$LB_ROOT/releases/$a/infra/RELEASE"
deploy 1
expect_equal "a RELEASE file that names another release is refused" "1" "$status"
printf '%s' "$a" > "$LB_ROOT/releases/$a/infra/RELEASE"

: > "$CALLS"
# Another deploy, which holds the lock for three seconds.
( exec 8> "$LB_ROOT/deploy.lock"; flock -x 8; sleep 3 ) &
holder=$!
sleep 1
deploy 1
wait "$holder"
expect_equal "a second deploy while one is running is refused" "1" "$status"
expect_output "and says why" "another deploy or the nightly backup is running on this box"
expect_not_called "and does nothing" "decrypt"

# ------------------------------------------------------------------------------------------
echo "the nightly backup and a deploy take turns"
# ------------------------------------------------------------------------------------------
reset
make_release 1
make_release 2
deploy 1
: > "$CALLS"
touch "$BEHAVIOUR/slow-run"
"${backup_command[@]}" > "$work/backup.log" 2>&1 &
backup_process=$!
wait_for_call "--profile backup run" || fail "the backup never started: $(cat "$work/backup.log")"
deploy 2
backup_status=0
wait "$backup_process" || backup_status=$?
rm -f "$BEHAVIOUR/slow-run"
expect_equal "a deploy while the backup runs is refused" "1" "$status"
expect_output "and says that the backup may be what holds the lock" "another deploy or the nightly backup is running on this box"
expect_not_called "and does nothing" "decrypt $b"
expect_equal "the backup is not disturbed" "0" "$backup_status"
expect_equal "and the live release stays" "1" "$(live)"

: > "$CALLS"
touch "$BEHAVIOUR/slow-up"
"$LB_ROOT/releases/$b/infra/scripts/deploy.sh" "$b" > "$work/deploy.log" 2>&1 &
deploy_process=$!
wait_for_call "compose $b tag=$b up" || fail "the deploy never reached its up: $(cat "$work/deploy.log")"
backup
deploy_status=0
wait "$deploy_process" || deploy_status=$?
rm -f "$BEHAVIOUR/slow-up"
if [ "$backup_status" = 0 ]; then
    pass "a backup while a deploy runs waits for it"
else
    fail "a backup while a deploy runs waits for it -- it exited $backup_status: $backup_output"
fi
expect_equal "and the deploy is not disturbed" "0" "$deploy_status"
expect_in_order "the backup starts once the deploy is done" "smoke $b --public" "--profile backup run --rm --no-deps backup"
if grep -F -- "--profile backup run" "$CALLS" | grep -qF "compose $b "; then
    pass "and backs up through the release that is now live"
else
    fail "the backup did not run through release $b: $(grep -F -- "--profile backup run" "$CALLS")"
fi

: > "$CALLS"
# A deploy that holds the lock for three seconds, and a backup that waits for it one second.
( exec 8> "$LB_ROOT/deploy.lock"; flock -x 8; sleep 3 ) &
holder=$!
sleep 1
backup 1
wait "$holder"
expect_equal "a backup that cannot get the lock in its time fails" "1" "$backup_status"
expect_not_called "and backs up nothing" "--profile backup run"

# ------------------------------------------------------------------------------------------
echo "old releases"
# ------------------------------------------------------------------------------------------
reset
for n in 1 2 3 4 5 6 7; do
    make_release "$n"
    deploy "$n"
done
expect_equal "seven deploys in a row all succeed, and the last is current" "7" "$(live)"
remaining=""
for n in 1 2 3 4 5 6 7; do
    if [ -d "$LB_ROOT/releases/$(sha "$n")" ]; then remaining="$remaining$n"; fi
done
expect_equal "the live release and the two before it are kept, and the older ones are gone" "567" "$remaining"
expect_in_order "their images are removed too" "docker image ls --filter reference=*/lb-*:$(sha 1)" "docker image rm id-of-$(sha 1)"

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
