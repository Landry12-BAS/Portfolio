#!/bin/bash
# Puts one release live on the box, and puts the previous one back if the new one does not
# come up. The GitHub workflow runs it over Tailscale SSH, from the release's own copy of
# the infra folder (docs/DEPLOY.md, Deploying); the owner can run it by hand the same way.
#
#   /opt/lb/releases/<release>/infra/scripts/deploy.sh <release>
#
# A release is a git commit. Its 40-character hash is the tag of its images and the name of
# its folder under /opt/lb/releases, which holds that commit's infra/ folder: the compose
# file, the Caddyfile, the database and Redis configuration, the encrypted secrets, and
# these scripts. Because every release runs from a folder of its own, a deploy recreates
# the containers whose files come from it (Postgres, Redis and Caddy), and so none of them
# can keep running an older release's configuration.
#
# In order, it:
#   1. decrypts the release's secrets into memory, and stops if one is missing;
#   2. pulls the release's images, and checks that every image this repository builds was
#      signed by this repository's image workflow (cosign, keyless). Third-party images are
#      pinned by digest in docker-compose.yml, and that digest is their proof;
#   3. starts the stack and waits for every health check;
#   4. runs smoke.sh, which also requests the API through its public hostname once;
#   5. only then marks the release as current.
#
# Steps 1 and 2 change nothing that is running. If anything fails from step 3 on, it starts
# the previous release again (its folder and images are still on the box) and exits 1; if
# that fails too, it exits 2, and someone has to look. A first deploy has no earlier release
# to go back to, so a failure there leaves what it started in place, for inspection.
#
# A rollback does not undo database migrations. A release's migrations must therefore work
# with the previous release's code too (docs/DEPLOY.md, Rolling back).
#
#   LB_ROOT                the folder that holds releases/ (default /opt/lb)
#   LB_SECRETS_DIR         where the secrets are decrypted to (default /run/lb/secrets)
#   LB_SIGNER_REPOSITORY   the GitHub repository whose workflow signs the images
#   LB_WAIT_SECONDS        how long to wait for every container to be healthy (default 300)
set -euo pipefail

# A dropped SSH connection must not stop a deploy halfway.
trap '' HUP

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"
root="${LB_ROOT:-/opt/lb}"
wait_seconds="${LB_WAIT_SECONDS:-300}"
signer_repository="${LB_SIGNER_REPOSITORY:-Landry12-BAS/Portfolio}"
export LB_SECRETS_DIR="${LB_SECRETS_DIR:-/run/lb/secrets}"

# How many of the newest release folders to keep. The live release and the one before it
# are kept whatever their age, because a rollback needs them.
releases_kept=3

say() {
    printf 'deploy: %s\n' "$*" || true
}

die() {
    say "$*"
    exit 1
}

release="${1:-}"
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || die "usage: deploy.sh <release>, where a release is a 40-character git commit hash."
[[ "$signer_repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "LB_SIGNER_REPOSITORY must look like owner/repository."
[ "$infra" = "$root/releases/$release/infra" ] || die "run this from the release's own copy, $root/releases/$release/infra/scripts, not from $infra."
[ "$(cat "$infra/RELEASE" 2>/dev/null)" = "$release" ] || die "$infra/RELEASE does not name release $release."

mkdir -p "$root"
exec 9> "$root/deploy.lock"
flock -n 9 || die "another deploy is already running on this box."

# The release that is live now, if there is one: the target of the `current` link.
previous=""
if [ -L "$root/current" ]; then
    previous="$(basename "$(readlink "$root/current")")"
    [[ "$previous" =~ ^[0-9a-f]{40}$ ]] || previous=""
fi

# The certificate every image signature must carry: the image workflow of this repository,
# run from its main branch, as GitHub's own OIDC issuer vouches. A signature from anywhere
# else, a fork or another branch included, is not accepted.
signer_pattern="^https://github\\.com/${signer_repository//./\\.}/\\.github/workflows/(images|deploy)\\.yml@refs/heads/main\$"
oidc_issuer="https://token.actions.githubusercontent.com"

# Checks every image of the release that is not pinned by digest. Each is looked up by the
# digest it was pulled as, so a tag that moves between the pull and the check cannot make
# the box run something that was not checked.
verify_signatures() {
    local images image digest_reference
    images="$("$infra/scripts/compose.sh" --profile backup config --images | sort -u)" || return 1
    while IFS= read -r image; do
        case "$image" in
            *@sha256:*) continue ;;
        esac
        digest_reference="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")" || return 1
        say "checking the signature of $image"
        if ! cosign verify --certificate-identity-regexp "$signer_pattern" --certificate-oidc-issuer "$oidc_issuer" "$digest_reference" > /dev/null; then
            say "the signature of $image does not verify."
            return 1
        fi
    done <<<"$images"
}

# Steps 1 and 2: everything that can be refused without touching what is running.
prepare() {
    export LB_TAG="$release"
    "$infra/scripts/decrypt-secrets.sh" || return 1
    say "pulling the images of release $release"
    "$infra/scripts/compose.sh" --profile backup pull --quiet || return 1
    verify_signatures || return 1
}

# Steps 3 and 4: start the release, and prove that it works.
switch_over() {
    say "starting release $release"
    "$infra/scripts/compose.sh" up --detach --pull never --remove-orphans --wait --wait-timeout "$wait_seconds" || return 1
    "$infra/scripts/smoke.sh" --public || return 1
}

# Starts the release that was live before, from its own folder with its own secrets.
# Returns 2 when there is nothing to go back to, or going back does not work either.
roll_back() {
    if [ -z "$previous" ]; then
        say "there is no earlier release to go back to."
        return 2
    fi
    local previous_infra="$root/releases/$previous/infra"
    say "going back to release $previous"
    export LB_TAG="$previous"
    "$previous_infra/scripts/decrypt-secrets.sh" || return 2
    "$previous_infra/scripts/compose.sh" up --detach --pull never --remove-orphans --wait --wait-timeout "$wait_seconds" || return 2
    "$previous_infra/scripts/smoke.sh" || return 2
}

# Makes the `current` link point at the release, in one atomic step.
mark_current() {
    ln -sfn "releases/$release" "$root/current.next"
    mv -T "$root/current.next" "$root/current"
    printf '%s %s live (was %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$release" "${previous:-nothing}" >> "$root/deploys.log"
}

# Removes the folders and images of releases older than the few worth keeping.
remove_old_releases() {
    local old
    # Newest first; the first few are kept, and so are the live release and the one before it.
    # The names are checked to be 40 hex digits below, so `ls` is safe here, and it sorts by age.
    # shellcheck disable=SC2012
    while IFS= read -r old; do
        [[ "$old" =~ ^[0-9a-f]{40}$ ]] || continue
        [ "$old" = "$release" ] && continue
        [ "$old" = "$previous" ] && continue
        say "removing release $old"
        docker image ls --filter "reference=*/lb-*:$old" --quiet | sort -u | xargs -r docker image rm > /dev/null 2>&1 || true
        rm -rf "${root:?}/releases/$old"
    done < <(ls -1t "$root/releases" | tail -n +$((releases_kept + 1)))
    docker image prune --force > /dev/null 2>&1 || true
}

if ! prepare; then
    # The new secrets are in memory by now; put the live release's back, so that a command run
    # from it reads the files it expects.
    if [ -n "$previous" ]; then
        "$root/releases/$previous/infra/scripts/decrypt-secrets.sh" > /dev/null 2>&1 || true
    fi
    die "release $release was refused before anything was started; what was running is untouched."
fi

if switch_over; then
    mark_current
    remove_old_releases
    say "release $release is live."
    exit 0
fi

say "release $release did not come up."
status=0
roll_back || status=$?
if [ "$status" -eq 0 ]; then
    die "release $previous is running again, and release $release is not."
fi
say "THE ROLLBACK DID NOT WORK either. Look at the containers: $infra/scripts/compose.sh ps"
exit 2
