#!/bin/bash
# Runs in the `browser` stage of lb07-sandbox.Dockerfile, as root, once. It puts LB-07's browser and
# what the browser needs at run time into two folders that the runtime stage copies whole:
#
#   /opt/chromium   Chrome Headless Shell, the Chromium build that playwright-core drives (its
#                   browsers.json names the version), downloaded from Chrome for Testing and checked
#                   against the SHA-256 written below, with its locale files cut to the one it uses;
#   /rootfs         every shared library the browser loads that the distroless runtime lacks, the
#                   NSS modules that NSS opens by name, fontconfig's settings and one font family
#                   (so a screenshot shows text), and the Debian record of every package they came
#                   from, in var/lib/dpkg/status.d where distroless keeps its own, so an image
#                   scanner sees them and the release gate covers them.
#
#   lb07-sandbox-browser.sh <playwright-core's browsers.json> <the runtime image's status.d folder>
#
# To move to a new Chromium: upgrade playwright-core (the lockfile), write the version its
# browsers.json names for chromium-headless-shell below, and the SHA-256 of both new zips. The
# build stops until the three agree.
set -euo pipefail

chromium_version=153.0.8010.12
# The SHA-256 of each architecture's zip as Chrome for Testing serves it, confirmed by
# downloading the file and hashing it.
# architecture  platform     SHA-256
checksums="
amd64           linux64      a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d
arm64           linux-arm64  d433c45172c7836e38124fe545f767b02210bfb43a6262f08a297473a8e91c99
"
# The one locale file kept: the browser runs in English, and the others are 47 MB.
kept_locale=en-US.pak
# The fonts: DejaVu, the family fontconfig prefers for every generic name. With Liberation alone,
# Chromium draws `system-ui` (the shop's first choice) in a monospaced face.
font_packages="fonts-dejavu-core fonts-dejavu-mono"

browsers_json="${1:?usage: lb07-sandbox-browser.sh <browsers.json> <runtime status.d folder>}"
runtime_packages="${2:?usage: lb07-sandbox-browser.sh <browsers.json> <runtime status.d folder>}"
browser=/opt/chromium
rootfs=/rootfs
records="$rootfs/var/lib/dpkg/status.d"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
    echo "lb07-sandbox-browser: $*" >&2
    exit 1
}

# Stops the build unless the version written here is the one playwright-core drives.
check_version() {
    local expected
    expected="$(node -p "require(process.argv[1]).browsers.find(entry => entry.name === 'chromium-headless-shell').browserVersion" "$browsers_json")"
    if [ "$expected" != "$chromium_version" ]; then
        fail "playwright-core drives Chrome Headless Shell $expected, and this script pins $chromium_version: update the version and both checksums."
    fi
}

# Downloads the zip for this machine's architecture, checks it, and unpacks the browser into its
# folder.
install_browser() {
    local architecture pinned platform checksum zip
    architecture="$(dpkg --print-architecture)"
    pinned="$(awk -v architecture="$architecture" '$1 == architecture { print $2, $3 }' <<<"$checksums")"
    [ -n "$pinned" ] || fail "there is no Chrome Headless Shell pinned for $architecture."
    read -r platform checksum <<<"$pinned"
    zip="$scratch/chrome-headless-shell.zip"
    curl --fail --silent --show-error --location --retry 3 --output "$zip" \
        "https://storage.googleapis.com/chrome-for-testing-public/$chromium_version/$platform/chrome-headless-shell-$platform.zip"
    echo "$checksum  $zip" | sha256sum --check --strict --quiet \
        || fail "the Chrome Headless Shell zip for $platform is not the one pinned here."
    unzip -q "$zip" -d "$scratch/unpacked"
    mv "$scratch/unpacked/chrome-headless-shell-$platform" "$browser"
    find "$browser/locales" -name '*.pak' ! -name "$kept_locale" -delete
}

# The files the browser loads on its own: the shell, the libraries in its own folder, and NSS's
# modules (softokn, freebl, the built-in roots), which NSS opens by name, so no linker list holds them.
browser_files() {
    printf '%s\n' "$browser/chrome-headless-shell" "$browser"/*.so*
    dpkg-query --listfiles libnss3 | grep -E '\.so$'
}

# Prints every library a file needs, as the dynamic linker finds it, one path a line. A library
# the linker cannot find stops the build: the image would hold a browser that cannot start.
needed_libraries() {
    local file="$1" listing
    listing="$(ldd "$file")"
    if grep -q 'not found' <<<"$listing"; then
        fail "$file needs a library this stage does not have: $(grep 'not found' <<<"$listing" | tr -s ' \t' ' ')"
    fi
    awk '$2 == "=>" && $3 ~ /^\// { print $3 }' <<<"$listing"
}

# Prints the Debian package that installed a file, without its architecture.
package_of() {
    local owner
    owner="$(dpkg-query --search "$1" 2>/dev/null | head -1)" || fail "$1 does not come from a Debian package."
    printf '%s\n' "${owner%%:*}"
}

# Copies a library under the name the linker asks for (a link, as Debian ships most of them) and
# the file that name points at, both in their real folder: /lib is a link to /usr/lib in the
# runtime image, so nothing may be written under /lib itself.
copy_library() {
    local found="$1" folder name
    folder="$(readlink -f "$(dirname "$found")")"
    name="$(basename "$found")"
    cp --archive --parents "$folder/$name" "$rootfs"
    cp --archive --parents "$(readlink -f "$folder/$name")" "$rootfs"
}

# Writes a package's record where distroless keeps its own: the dpkg status entry, and the
# checksums of its files when dpkg has them.
record_package() {
    local package="$1" checksum_file
    dpkg-query --status "$package" > "$records/$package"
    for checksum_file in "/var/lib/dpkg/info/$package.md5sums" "/var/lib/dpkg/info/$package:$(dpkg --print-architecture).md5sums"; do
        if [ -f "$checksum_file" ]; then cp "$checksum_file" "$records/$package.md5sums"; fi
    done
}

# Copies every library the browser needs that the runtime image does not already have (the
# runtime's own packages are the files of its status.d), and records where each came from.
collect_libraries() {
    local file library real package
    : > "$scratch/packages"
    while IFS= read -r file; do
        needed_libraries "$file" >> "$scratch/libraries"
        printf '%s\n' "$file" >> "$scratch/libraries"
    done < <(browser_files)
    while IFS= read -r library; do
        real="$(readlink -f "$library")"
        # The browser's own folder is copied whole, by the Dockerfile.
        case "$real" in "$browser"/*) continue ;; esac
        package="$(package_of "$real")"
        if [ -e "$runtime_packages/$package" ]; then continue; fi
        copy_library "$library"
        printf '%s\n' "$package" >> "$scratch/packages"
    done < <(sort -u "$scratch/libraries")
    while IFS= read -r package; do
        record_package "$package"
    done < <(sort -u "$scratch/packages")
}

# Copies fontconfig's settings and the fonts: without a font, every letter in a screenshot is an
# empty box.
collect_fonts() {
    local package
    cp --archive --parents /etc/fonts /usr/share/fontconfig "$rootfs"
    record_package fontconfig-config
    for package in $font_packages; do
        dpkg-query --listfiles "$package" | grep -E '\.(ttf|otf)$' | xargs cp --archive --parents --target-directory "$rootfs"
        record_package "$package"
    done
}

check_version
install_browser
mkdir -p "$records"
collect_libraries
collect_fonts
echo "lb07-sandbox-browser: Chrome Headless Shell $chromium_version in $browser, and $(find "$rootfs" -type f | wc -l | tr -d ' ') files it needs in $rootfs."
