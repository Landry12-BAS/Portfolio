#!/bin/bash
# Installs pinned releases of tools that no package archive has, after checking each
# download's SHA-256 against the value written here: sops and cosign, which the box needs,
# and the linters hadolint and actionlint, which CI (and a machine without them) needs.
# This is the only place the versions and checksums are written down. docs/DEPLOY.md runs
# this script on the box, and CI runs it for the rest, so a wrong checksum fails in CI first.
#
#   sudo infra/scripts/install-tool.sh sops cosign
#   ssh <box> 'sudo bash -s -- sops cosign' < infra/scripts/install-tool.sh     (a box that has no clone)
#   LB_INSTALL_DIR="$HOME/.local/bin" infra/scripts/install-tool.sh hadolint actionlint
#
#   LB_INSTALL_DIR   where the programs go (default /usr/local/bin)
#
# To move to a new release, change its version and both checksums in one change. Each
# checksum is the one in the release's own checksums file, and was confirmed by
# downloading the file and hashing it.
set -euo pipefail

sops_version=v3.10.2
# The cosign release the image workflow signs with (images.yml names the same one), so what
# signs and what verifies cannot drift apart.
cosign_version=v3.0.6
hadolint_version=v2.15.1
actionlint_version=1.7.12

# The SHA-256 of the file each download must be (the archive, for actionlint).
# tool        architecture  SHA-256
checksums="
sops          amd64         79b0f844237bd4b0446e4dc884dbc1765fc7dedc3968f743d5949c6f2e701739
sops          arm64         e91ddc04e6a78f5aed9e4fc347a279b539c43b74d99e6b8078e2f2f6f5b309f5
cosign        amd64         c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74
cosign        arm64         bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8
hadolint      amd64         c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
hadolint      arm64         f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d
actionlint    amd64         8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
actionlint    arm64         325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
"

install_dir="${LB_INSTALL_DIR:-/usr/local/bin}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
    echo "install-tool: $*" >&2
    exit 1
}

[ "$(uname -s)" = Linux ] || fail "this installs Linux binaries, and this machine is $(uname -s)."
case "$(uname -m)" in
    x86_64 | amd64) architecture=amd64 ;;
    aarch64 | arm64) architecture=arm64 ;;
    *) fail "there is no build for $(uname -m)." ;;
esac

# Downloads a file into the scratch folder and stops unless its SHA-256 is the expected one.
# download <file name> <url> <expected sha256>
download() {
    local name="$1" url="$2" expected="$3" actual
    curl --fail --silent --show-error --location --retry 3 --output "$scratch/$name" "$url"
    actual="$(sha256sum "$scratch/$name" | cut -d ' ' -f 1)"
    if [ "$actual" != "$expected" ]; then
        fail "$name from $url has SHA-256 $actual, not the expected $expected. Nothing was installed."
    fi
}

# Puts a checked file in the install folder under its program name, mode 755.
# put_in_place <path of the checked file> <program name>
put_in_place() {
    mkdir -p "$install_dir"
    install -m 0755 "$1" "$install_dir/$2"
    echo "install-tool: installed $2 to $install_dir/$2"
}

# Prints the checksum of a tool's download for this machine's architecture.
expected_sha256() {
    awk -v tool="$1" -v architecture="$architecture" '$1 == tool && $2 == architecture { print $3 }' <<<"$checksums"
}

install_sops() {
    download sops "https://github.com/getsops/sops/releases/download/$sops_version/sops-$sops_version.linux.$architecture" "$(expected_sha256 sops)"
    put_in_place "$scratch/sops" sops
}

install_cosign() {
    download cosign "https://github.com/sigstore/cosign/releases/download/$cosign_version/cosign-linux-$architecture" "$(expected_sha256 cosign)"
    put_in_place "$scratch/cosign" cosign
}

install_hadolint() {
    local suffix=x86_64
    if [ "$architecture" = arm64 ]; then suffix=arm64; fi
    download hadolint "https://github.com/hadolint/hadolint/releases/download/$hadolint_version/hadolint-linux-$suffix" "$(expected_sha256 hadolint)"
    put_in_place "$scratch/hadolint" hadolint
}

install_actionlint() {
    download actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v$actionlint_version/actionlint_${actionlint_version}_linux_$architecture.tar.gz" "$(expected_sha256 actionlint)"
    tar -xzf "$scratch/actionlint.tar.gz" -C "$scratch" actionlint
    put_in_place "$scratch/actionlint" actionlint
}

if [ "$#" -eq 0 ]; then
    fail "usage: install-tool.sh sops | cosign | hadolint | actionlint (one or more)"
fi
for tool in "$@"; do
    case "$tool" in
        sops) install_sops ;;
        cosign) install_cosign ;;
        hadolint) install_hadolint ;;
        actionlint) install_actionlint ;;
        *) fail "unknown tool '$tool': use sops, cosign, hadolint or actionlint." ;;
    esac
done
