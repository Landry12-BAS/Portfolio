#!/bin/bash
# Tests pin-images.sh on copies of the real compose file and Dockerfiles, with a stand-in
# for docker that answers any lookup with a digest made from the reference. It proves that
# --check names every image left without a digest (and passes on the repository as it is),
# that pinning adds exactly the digest and keeps everything else on the line (the tag, the
# `AS` of a FROM, the flags of a COPY), that a stale digest is replaced, that running it
# twice changes nothing, that the images this repository builds are left alone, and that a
# registry that gives no answer stops it with the file untouched.
#
#   infra/scripts/test-pin-images.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"
work="$(mktemp -d)"
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

expect_equal() {
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- expected '$2', got '$3'"; fi
}

# docker: `buildx imagetools inspect <reference>` answers with a digest made from the
# reference, unless the reference is listed in $UNREACHABLE.
mkdir -p "$work/bin"
cat > "$work/bin/docker" <<'STUB'
#!/bin/bash
reference="${*: -1}"
if [ -n "${UNREACHABLE:-}" ] && [[ "$reference" == *"$UNREACHABLE"* ]]; then
    echo "ERROR: not found" >&2
    exit 1
fi
printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    sha256:%s\n' \
    "$reference" "$(printf '%s' "$reference" | sha256sum | cut -d ' ' -f 1)"
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"

# A copy of the files the script reads, in the layout it expects.
mkdir -p "$work/infra/scripts" "$work/infra/docker"
cp "$here/pin-images.sh" "$work/infra/scripts/"
cp "$infra/docker-compose.yml" "$work/infra/"
cp "$infra"/docker/*.Dockerfile "$work/infra/docker/"
pin="$work/infra/scripts/pin-images.sh"
status=0
output=""

run() {
    status=0
    output="$("$@" 2>&1)" || status=$?
}

echo "pin-images.sh"
run "$pin" --check
expect_equal "the repository as it is passes --check" "0" "$status"

# The same files with every digest removed: the state before anything is pinned.
digest_pattern='@sha256:[0-9a-f]\{64\}'
sed -i "s/$digest_pattern//" "$work/infra/docker-compose.yml" "$work"/infra/docker/*.Dockerfile
expected="$(grep -c -E '^\s*image: [^$]+$|^FROM |^COPY .*--from=[^ ]*[:@]' "$work/infra/docker-compose.yml" "$work"/infra/docker/*.Dockerfile | awk -F: '{ total += $2 } END { print total }')"
run "$pin" --check
expect_equal "--check fails when the digests are gone" "1" "$status"
expect_equal "and names each image, by file and line" "$expected" "$(grep -c 'is not pinned by digest' <<<"$output")"

run "$pin"
expect_equal "pinning succeeds" "0" "$status"
run "$pin" --check
expect_equal "and --check then passes" "0" "$status"

before="$(cat "$work/infra/docker-compose.yml" "$work"/infra/docker/*.Dockerfile | cksum)"
run "$pin"
expect_equal "pinning a second time changes nothing" "$before" "$(cat "$work/infra/docker-compose.yml" "$work"/infra/docker/*.Dockerfile | cksum)"

# The ${LB_TAG} below is literal text to look for in the compose file, not a variable.
# shellcheck disable=SC2016
if grep -q 'lb-gateway:${LB_TAG' "$work/infra/docker-compose.yml" && ! grep 'lb-gateway:${LB_TAG' "$work/infra/docker-compose.yml" | grep -q '@sha256'; then
    pass "the images this repository builds are left alone"
else
    fail "an image this repository builds was pinned, or lost"
fi
if grep -qE '^FROM python:3\.13\.15-slim-trixie@sha256:[0-9a-f]{64} AS build$' "$work/infra/docker/django-systems.Dockerfile"; then
    pass "a FROM keeps its tag and its AS"
else
    fail "the FROM line of the Django Dockerfile is not as expected: $(grep -m1 '^FROM' "$work/infra/docker/django-systems.Dockerfile")"
fi
if grep -qE -- '--from=ghcr\.io/astral-sh/uv:[0-9.]+@sha256:[0-9a-f]{64} ' "$work/infra/docker/django-systems.Dockerfile"; then
    pass "a COPY --from=<image> is pinned, and a COPY --from=<stage> is not touched"
else
    fail "the COPY --from line of the Django Dockerfile is not as expected: $(grep -m1 -- '--from=ghcr' "$work/infra/docker/django-systems.Dockerfile")"
fi

# A stale digest, as when a tag has moved since the file was written.
stale="$(printf '0%.0s' $(seq 1 64))"
sed -i -E "0,/@sha256:[0-9a-f]{64}/s//@sha256:$stale/" "$work/infra/docker-compose.yml"
if grep -q "$stale" "$work/infra/docker-compose.yml"; then
    run "$pin"
    if grep -q "$stale" "$work/infra/docker-compose.yml"; then fail "a stale digest was kept"; else pass "a stale digest is replaced by the current one"; fi
else
    fail "the test could not plant a stale digest"
fi

# A registry that does not answer.
sed -i "s/$digest_pattern//" "$work/infra/docker/backup.Dockerfile"
cp "$work/infra/docker/backup.Dockerfile" "$work/backup.before"
status=0
output="$(UNREACHABLE=alpine "$pin" 2>&1)" || status=$?
expect_equal "an image the registry cannot find stops the run" "1" "$([ "$status" -ne 0 ] && echo 1 || echo 0)"
if cmp -s "$work/backup.before" "$work/infra/docker/backup.Dockerfile"; then pass "and leaves the file as it was"; else fail "the file was changed although the lookup failed"; fi

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
