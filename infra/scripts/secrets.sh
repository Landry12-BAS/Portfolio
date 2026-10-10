#!/bin/bash
# The owner's tool for the encrypted secrets in infra/secrets: it makes the owner's key,
# creates, edits and checks the encrypted files, and lets the box's key open them. The
# `just secrets-*` recipes call it; infra/secrets/README.md says what each file holds.
#
#   infra/scripts/secrets.sh init                          make your age key (outside the repository) and list its public half in .sops.yaml
#   infra/scripts/secrets.sh new <name>                    create infra/secrets/<name>.enc.env from its template, fill it in
#   infra/scripts/secrets.sh edit <name>                   change a secrets file in your editor ($EDITOR)
#   infra/scripts/secrets.sh check                         compare every file's variables with its template (names only, never values)
#   infra/scripts/secrets.sh add-recipient <label> <key>   let one more age public key open every file
#   infra/scripts/secrets.sh rekey                         after removing a key from .sops.yaml, lock every file to the keys that are left
#   infra/scripts/secrets.sh token [bytes]                 print a random hex token (16 to 64 bytes, 24 by default)
#
# <name> is the file's short name, such as gateway; a path such as infra/secrets/gateway.enc.env
# works too. Your private key is read from $SOPS_AGE_KEY_FILE (default
# ~/.config/sops/age/keys.txt). Needs sops, age and openssl.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# Every sops call runs from the repository root, so the path it matches against the rules
# in .sops.yaml is the same whatever directory the command was typed in.
cd "$repo"
secrets_dir=infra/secrets
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

# A half-written encrypted file is removed if the script stops before it is finished.
unfinished_file=""
trap 'rm -f "$unfinished_file"' EXIT

fail() {
    echo "secrets: $*" >&2
    exit 1
}

# Stops with an install hint when a program the command needs is missing.
require_tool() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"
}

# Accepts gateway, gateway.enc.env or infra/secrets/gateway.enc.env, and prints gateway.
name_of() {
    local name="${1##*/}"
    name="${name%.enc.env}"
    name="${name%.example.env}"
    if ! [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
        fail "'$1' does not name a secrets file: use lowercase letters, digits and hyphens."
    fi
    printf '%s' "$name"
}

# Prints the age public keys .sops.yaml lists, one per line: the lines of the form
# "- <key>", not a key mentioned in a comment.
listed_keys() {
    sed -n 's/^[[:space:]]*-[[:space:]]*\(age1[a-z0-9]\{58\}\)\([[:space:]].*\)\{0,1\}$/\1/p' .sops.yaml
}

# Stops unless .sops.yaml lists a key: without one sops can only fail, and says so badly.
require_listed_key() {
    local keys
    keys="$(listed_keys)"
    [ -n "$keys" ] || fail "no key is listed in .sops.yaml yet. Run: just secrets-init"
}

# Adds a line for a recipient to the end of .sops.yaml, where the list of keys is.
list_key() {
    printf '          - %s  # %s\n' "$2" "$1" >> .sops.yaml
}

# sops writes the plain text of a file it opens for editing to a temporary folder. Where
# the system has a memory-backed one for the user ($XDG_RUNTIME_DIR, on Linux), use it, so
# the plain text never reaches the disk.
prefer_memory_for_temp_files() {
    if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -w "$XDG_RUNTIME_DIR" ]; then
        export TMPDIR="$XDG_RUNTIME_DIR"
    fi
}

# Prints a secrets file decrypted, as dotenv text.
decrypted() {
    sops decrypt --input-type dotenv --output-type dotenv "$1"
}

# Opens a secrets file in the editor. sops answers 200 when nothing was changed, which is fine.
open_in_editor() {
    local status=0
    sops edit "$1" || status=$?
    if [ "$status" -ne 0 ] && [ "$status" -ne 200 ]; then
        return "$status"
    fi
}

# Prints a template's contents with each @token value (or @token:<bytes>) replaced by a
# new random token, so a password is never typed or invented by hand.
filled_template() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=@token(:([0-9]+))?$ ]]; then
            printf '%s=%s\n' "${BASH_REMATCH[1]}" "$(token "${BASH_REMATCH[3]:-24}")"
        else
            printf '%s\n' "$line"
        fi
    done < "$1"
}

# Prints what is wrong with a secrets file, compared to its template, and fails if anything is.
file_problems() {
    local name="$1" plain
    if ! plain="$(decrypted "$secrets_dir/$name.enc.env" 2>/dev/null)"; then
        echo "it cannot be decrypted with the key in $SOPS_AGE_KEY_FILE"
        return 1
    fi
    printf '%s\n' "$plain" | "$here/check-secret-file.sh" "$secrets_dir/$name.example.env"
}

# Makes your age key pair, if you have none, and lists the public half in .sops.yaml.
init() {
    require_tool age-keygen "Install age: https://github.com/FiloSottile/age (brew install age, apt install age)."
    if [ -e "$SOPS_AGE_KEY_FILE" ]; then
        echo "Using the key you already have: $SOPS_AGE_KEY_FILE"
    else
        mkdir -p "$(dirname "$SOPS_AGE_KEY_FILE")"
        age-keygen -o "$SOPS_AGE_KEY_FILE" >/dev/null 2>&1
        echo "Made your key: $SOPS_AGE_KEY_FILE"
    fi
    local public listed
    public="$(age-keygen -y "$SOPS_AGE_KEY_FILE")"
    listed="$(listed_keys)"
    if [ -z "$listed" ]; then
        list_key owner "$public"
        echo "Listed its public half in .sops.yaml as 'owner': $public"
        echo "Commit that change."
    elif grep -qx "$public" <<<"$listed"; then
        echo "Its public half is already listed in .sops.yaml."
    else
        echo "Warning: .sops.yaml already lists other keys, and this one is not among them, so it" >&2
        echo "cannot open the existing files. Ask the holder of a listed key to run:" >&2
        echo "  just secrets-add-recipient <label> $public" >&2
    fi
    echo
    echo "Back up $SOPS_AGE_KEY_FILE in a password manager. It is the only way to open the"
    echo "secrets, and it exists nowhere else: lose it and every file has to be made again."
    echo "It must never be committed, pasted into a chat, or copied to the box."
}

# Creates infra/secrets/<name>.enc.env from its template, with random values made, then
# opens it for the values only the owner has (provider keys, hostnames).
new() {
    require_tool sops "Install sops: https://github.com/getsops/sops/releases (brew install sops)."
    require_tool openssl "Install openssl."
    local name template target
    name="$(name_of "$1")"
    template="$secrets_dir/$name.example.env"
    target="$secrets_dir/$name.enc.env"
    [ -f "$template" ] || fail "there is no template $template."
    [ ! -e "$target" ] || fail "$target already exists. Change it with: just secrets-edit $name"
    require_listed_key
    prefer_memory_for_temp_files

    unfinished_file="$target.partial"
    filled_template "$template" \
        | sops encrypt --filename-override "$target" --input-type dotenv --output-type dotenv /dev/stdin > "$unfinished_file"
    mv "$unfinished_file" "$target"
    unfinished_file=""
    echo "Made $target."

    local problems
    if problems="$(file_problems "$name")"; then
        echo "Every variable is set."
    else
        echo "These still need a value:"
        printf '%s\n' "$problems" | sed 's/^/  /'
        echo "Opening it in your editor (set EDITOR to choose one)."
        open_in_editor "$target"
        report "$name"
    fi
}

# Opens an existing secrets file in the editor, then checks it against its template.
edit() {
    require_tool sops "Install sops: https://github.com/getsops/sops/releases (brew install sops)."
    local name
    name="$(name_of "$1")"
    [ -f "$secrets_dir/$name.enc.env" ] || fail "$secrets_dir/$name.enc.env does not exist. Make it with: just secrets-new $name"
    prefer_memory_for_temp_files
    open_in_editor "$secrets_dir/$name.enc.env"
    report "$name"
}

# Says whether one secrets file is complete, and what is missing if it is not.
report() {
    local name="$1" problems
    if problems="$(file_problems "$name")"; then
        printf '  ok    %s\n' "$name"
    else
        printf '  FAIL  %s\n' "$name"
        printf '%s\n' "$problems" | sed 's/^/          /'
        return 1
    fi
}

# Checks every secrets file against its template, and every file against the list of templates.
check() {
    require_tool sops "Install sops: https://github.com/getsops/sops/releases (brew install sops)."
    local failed=0 template target name
    for template in "$secrets_dir"/*.example.env; do
        name="$(name_of "$template")"
        if [ ! -f "$secrets_dir/$name.enc.env" ]; then
            printf '  FAIL  %s\n          %s.enc.env does not exist: make it with just secrets-new %s\n' "$name" "$name" "$name"
            failed=1
        elif ! report "$name"; then
            failed=1
        fi
    done
    for target in "$secrets_dir"/*.enc.env; do
        [ -e "$target" ] || continue
        name="$(name_of "$target")"
        if [ ! -f "$secrets_dir/$name.example.env" ]; then
            printf '  FAIL  %s\n          there is no template %s.example.env for it\n' "$name" "$name"
            failed=1
        fi
    done
    return "$failed"
}

# Lets one more age public key open every secrets file, and says who it belongs to.
add_recipient() {
    require_tool sops "Install sops: https://github.com/getsops/sops/releases (brew install sops)."
    local label="$1" key="$2" listed target
    [[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$ ]] || fail "the label must be one short word, such as box."
    [[ "$key" =~ ^age1[a-z0-9]{58}$ ]] || fail "that is not an age public key: it is age1 and 58 lowercase letters and digits."
    listed="$(listed_keys)"
    if grep -qx "$key" <<<"$listed"; then
        fail "that key is already listed in .sops.yaml."
    fi
    list_key "$label" "$key"
    for target in "$secrets_dir"/*.enc.env; do
        [ -e "$target" ] || continue
        sops updatekeys --yes "$target"
    done
    echo "Listed $label in .sops.yaml and locked every file to the keys listed there. Commit the changes."
}

# Locks every secrets file to exactly the keys listed in .sops.yaml, with a new data key.
# Run it after removing a key from .sops.yaml: the old data key stays in git's history,
# and whoever held the removed key could open an old copy, so the data key is replaced too
# (and every secret that file holds should then be changed as well).
rekey() {
    require_tool sops "Install sops: https://github.com/getsops/sops/releases (brew install sops)."
    require_listed_key
    local target
    for target in "$secrets_dir"/*.enc.env; do
        [ -e "$target" ] || continue
        sops updatekeys --yes "$target"
        sops rotate --in-place "$target"
    done
    echo "Locked every file to the keys listed in .sops.yaml. Commit the changes."
}

# Prints a random token as lowercase hex: 24 bytes (48 characters) unless told otherwise.
# Hex is inside the alphabet every password in this stack must keep to, and safe in a URL.
token() {
    local bytes="${1:-24}"
    if ! [[ "$bytes" =~ ^[0-9]+$ ]] || [ "$bytes" -lt 16 ] || [ "$bytes" -gt 64 ]; then
        fail "a token is 16 to 64 bytes."
    fi
    openssl rand -hex "$bytes"
}

case "${1:-}" in
    init) init ;;
    new) new "${2:?usage: secrets.sh new <name>}" ;;
    edit) edit "${2:?usage: secrets.sh edit <name>}" ;;
    check) check ;;
    add-recipient) add_recipient "${2:?usage: secrets.sh add-recipient <label> <key>}" "${3:?usage: secrets.sh add-recipient <label> <key>}" ;;
    rekey) rekey ;;
    token) token "${2:-24}" ;;
    *)
        echo "usage: secrets.sh init | new <name> | edit <name> | check | add-recipient <label> <key> | rekey | token [bytes]" >&2
        exit 2
        ;;
esac
