#!/bin/bash
# Installs pinned releases of the tools the box and CI need but no package archive has
# (sops, cosign), after checking each download's SHA-256 against the value written here.
# This is the only place the versions and checksums are written down: docs/DEPLOY.md runs
# this script on the box, and CI runs it for sops, so a wrong checksum fails in CI first.
#
#   sudo infra/scripts/install-tool.sh sops cosign
#   ssh <box> 'sudo bash -s -- sops cosign' < infra/scripts/install-tool.sh     (a box that has no clone)
#
#   LB_INSTALL_DIR   where the programs go (default /usr/local/bin)
#
# To move to a new release, change its version and both checksums in one change. The
# checksums come from the release's own checksums file (sops-<version>.checksums.txt,
# cosign_checksums.txt) and were each confirmed by downloading the file and hashing it.
set -euo pipefail

sops_version=v3.10.2
sops_sha256_amd64=79b0f844237bd4b0446e4dc884dbc1765fc7dedc3968f743d5949c6f2e701739
sops_sha256_arm64=e91ddc04e6a78f5aed9e4fc347a279b539c43b74d99e6b8078e2f2f6f5b309f5

# The cosign release the image workflow signs with (images.yml names the same one), so what
# signs and what verifies cannot drift apart.
cosign_version=v3.0.6
cosign_sha256_amd64=c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74
cosign_sha256_arm64=bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8

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

# Downloads one file, checks its SHA-256, and installs it as <name> (mode 755).
# install_binary <name> <url> <expected sha256>
install_binary() {
    local name="$1" url="$2" expected="$3" actual
    curl --fail --silent --show-error --location --retry 3 --output "$scratch/$name" "$url"
    actual="$(sha256sum "$scratch/$name" | cut -d ' ' -f 1)"
    if [ "$actual" != "$expected" ]; then
        fail "$name from $url has SHA-256 $actual, not the expected $expected. Nothing was installed."
    fi
    mkdir -p "$install_dir"
    install -m 0755 "$scratch/$name" "$install_dir/$name"
    echo "install-tool: installed $name to $install_dir/$name"
}

install_sops() {
    local expected="$sops_sha256_amd64"
    if [ "$architecture" = arm64 ]; then expected="$sops_sha256_arm64"; fi
    install_binary sops "https://github.com/getsops/sops/releases/download/$sops_version/sops-$sops_version.linux.$architecture" "$expected"
}

install_cosign() {
    local expected="$cosign_sha256_amd64"
    if [ "$architecture" = arm64 ]; then expected="$cosign_sha256_arm64"; fi
    install_binary cosign "https://github.com/sigstore/cosign/releases/download/$cosign_version/cosign-linux-$architecture" "$expected"
}

if [ "$#" -eq 0 ]; then
    fail "usage: install-tool.sh sops | cosign (one or both)"
fi
for tool in "$@"; do
    case "$tool" in
        sops) install_sops ;;
        cosign) install_cosign ;;
        *) fail "unknown tool '$tool': use sops or cosign." ;;
    esac
done
