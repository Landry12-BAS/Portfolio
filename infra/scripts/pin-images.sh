#!/bin/bash
# Keeps every third-party image the stack runs or builds from pinned by digest, so that a
# tag someone moves cannot change what the box runs. Images this repository builds are
# named by their release tag in docker-compose.yml (${LB_REGISTRY}/lb-...:${LB_TAG}) and are
# left alone: the deploy checks their signatures instead (deploy.sh).
#
#   infra/scripts/pin-images.sh --check   fail if an image is named without its digest (CI runs this)
#   infra/scripts/pin-images.sh           pin each image to the digest its tag names today
#
# A pinned reference reads name:tag@sha256:<digest>. The tag stays, for a person reading it
# and for this script, which asks the registry what the tag names now; the digest is what
# Docker pulls. It is the digest of the multi-architecture index, so the same pin serves the
# arm64 box and an amd64 laptop. To take a new release of an image, change its tag and run
# this script; to take the current build of the same tag (a security patch), just run it.
# Run it where Docker can reach the registries (Docker Hub limits anonymous pulls, which
# counts here too); review the diff before committing.
#
# It looks at the `image:` lines of docker-compose.yml, the FROM lines of every Dockerfile
# in infra/docker, and the COPY --from=<image> lines that copy out of another image.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"
files=("$infra/docker-compose.yml" "$infra"/docker/*.Dockerfile)
mode=update
if [ "${1:-}" = "--check" ]; then
    mode=check
elif [ -n "${1:-}" ]; then
    echo "usage: pin-images.sh [--check]" >&2
    exit 2
fi

# Prints the image a line names, or nothing when it names none. A COPY --from= that names
# an earlier build stage is not an image: an image always has a tag or a digest, a stage
# name has neither.
image_in() {
    local line="$1"
    if [[ "$line" =~ ^[[:space:]]*image:[[:space:]]+([^[:space:]\$]+)[[:space:]]*$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^FROM[[:space:]]+([^[:space:]]+) ]]; then
        if [ "${BASH_REMATCH[1]}" != scratch ] && [[ "${BASH_REMATCH[1]}" == *[:@]* ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
        fi
    elif [[ "$line" =~ ^COPY[[:space:]].*--from=([^[:space:]]+) ]]; then
        if [[ "${BASH_REMATCH[1]}" == *[:@]* ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
        fi
    fi
}

# Asks the registry for the digest of the index a name:tag reference names now.
digest_of() {
    local digest
    digest="$(docker buildx imagetools inspect "$1" | awk '/^Digest:/ { print $2; exit }')"
    if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        echo "pin-images: the registry gave no digest for $1." >&2
        return 1
    fi
    printf '%s' "$digest"
}

# --check: names every image that has no digest, and fails if there is one.
check_file() {
    local file="$1" line number=0 image
    while IFS= read -r line || [ -n "$line" ]; do
        number=$((number + 1))
        image="$(image_in "$line")"
        if [ -n "$image" ] && ! [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
            echo "${file#"$infra"/}:$number: $image is not pinned by digest" >&2
            unpinned=$((unpinned + 1))
        fi
    done < "$file"
}

# Rewrites one file so that every image in it carries the digest its tag names today.
pin_file() {
    local file="$1" line image tagged digest rewritten="$scratch/rewritten"
    : > "$rewritten"
    while IFS= read -r line || [ -n "$line" ]; do
        image="$(image_in "$line")"
        if [ -n "$image" ]; then
            tagged="${image%%@*}"
            if [[ "$tagged" == *:* ]]; then
                digest="$(digest_of "$tagged")"
                line="${line/"$image"/"$tagged@$digest"}"
            fi
        fi
        printf '%s\n' "$line" >> "$rewritten"
    done < "$file"
    if ! cmp -s "$file" "$rewritten"; then
        cat "$rewritten" > "$file"
        echo "pin-images: updated ${file#"$infra"/}"
    fi
}

unpinned=0
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
for file in "${files[@]}"; do
    if [ "$mode" = check ]; then check_file "$file"; else pin_file "$file"; fi
done

if [ "$mode" = check ]; then
    if [ "$unpinned" -gt 0 ]; then
        echo "pin-images: $unpinned image(s) without a digest. Run: just pin-images" >&2
        exit 1
    fi
    echo "pin-images: every image is pinned by digest."
fi
