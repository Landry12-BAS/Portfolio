#!/bin/bash
# Compares a secrets file with its template and names every problem, so a missing or
# misspelled variable stops a deploy before anything restarts, not minutes later in a log.
#
#   infra/scripts/check-secret-file.sh <template> [<file>]     (no file: reads standard input)
#
# The template (infra/secrets/<name>.example.env) says what the file may hold. A line
# NAME=... is a variable the file must set to something; a comment of the form "# NAME="
# is one it may set; any other name is a typo. The output names variables and line numbers
# only: a value, which may be a secret, never reaches it, whatever is wrong with it.
# The exit status is 1 when there is any problem, and 2 for a wrong command line.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: check-secret-file.sh <template> [<file>]" >&2
    exit 2
fi
template="$1"
file="${2:--}"
if [ ! -s "$template" ]; then
    echo "check-secret-file: the template $template is missing or empty." >&2
    exit 2
fi

# Two files go in: the template first, then the secrets file, told apart by FNR resetting.
read -r -d '' program <<'AWK' || true
FNR == 1 { files_read++ }

# The template: what may be set, and what must be.
files_read == 1 {
    if (match($0, /^[A-Z][A-Z0-9_]*=/)) {
        name = substr($0, 1, RLENGTH - 1)
        allowed[name] = 1
        required[name] = 1
    } else if (match($0, /^# [A-Z][A-Z0-9_]*=/)) {
        name = substr($0, 3, RLENGTH - 3)
        allowed[name] = 1
    }
    next
}

# The secrets file, line by line.
{
    if ($0 ~ /\r$/) {
        printf "line %d ends with a carriage return\n", FNR
        sub(/\r$/, "")
    }
    if ($0 ~ /^[ \t]*(#.*)?$/) {
        next
    }
    if (!match($0, /^[A-Z][A-Z0-9_]*=/)) {
        printf "line %d is not of the form NAME=value\n", FNR
        next
    }
    name = substr($0, 1, RLENGTH - 1)
    value = substr($0, RLENGTH + 1)
    gsub(/^[ \t]+/, "", value)
    gsub(/[ \t]+$/, "", value)
    if (!(name in allowed)) {
        printf "%s is not a variable of the template\n", name
    }
    if (name in seen) {
        printf "%s is set twice\n", name
    }
    seen[name] = 1
    if (value == "" || value == "\"\"" || value == "\047\047") {
        empty[name] = 1
    } else {
        delete empty[name]
    }
    if (value ~ /^@token/) {
        printf "%s still holds the @token placeholder: make the file with just secrets-new\n", name
    }
}

END {
    for (name in required) {
        if (!(name in seen)) {
            printf "%s is missing\n", name
        } else if (name in empty) {
            printf "%s is empty\n", name
        }
    }
}
AWK

problems="$(awk "$program" "$template" "$file" | sort)"
if [ -n "$problems" ]; then
    printf '%s\n' "$problems"
    exit 1
fi
