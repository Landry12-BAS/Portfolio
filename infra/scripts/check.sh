#!/bin/bash
# The infrastructure's static checks: everything that can be verified without starting the
# stack. CI runs it (the `infra` job), and `just infra-check` runs it on a machine with the
# tools (infra/scripts/install-tool.sh installs hadolint and actionlint; shellcheck, jq and
# Docker are the usual ones). A missing tool is a failure, never a skipped check.
#
#   - every shell script passes shellcheck, and is executable;
#   - every Dockerfile passes hadolint;
#   - every file a Dockerfile copies is admitted by its .dockerignore;
#   - the GitHub workflows pass actionlint (which also runs shellcheck on their scripts);
#   - every image is pinned by digest or built here (pin-images.sh --check);
#   - the Compose files resolve and follow the security rules (check-compose.sh);
#   - the Caddyfile is valid and is formatted the way `caddy fmt` writes it;
#   - the systemd units parse, and the nightly backup's unit takes the deploy's lock;
#   - the encrypted secrets files are encrypted, and nothing else is in infra/secrets.
#
#   infra/scripts/check.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
infra="$(cd "$here/.." && pwd -P)"
repo="$(cd "$infra/.." && pwd -P)"
failures=0

# check <label> <command...>: runs the command, and says ok, or fails and shows what it said.
check() {
    local label="$1" output
    shift
    if output="$("$@" 2>&1)"; then
        printf '  ok    %s\n' "$label"
    else
        printf '  FAIL  %s\n' "$label" >&2
        printf '%s\n' "$output" | head -40 | sed 's/^/        /' >&2
        failures=$((failures + 1))
    fi
}

# Stops a check with an install hint when a tool it needs is missing.
need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "$1 is not installed. $2"
        return 1
    }
}

shell_scripts() {
    need shellcheck "Install shellcheck (apt install shellcheck, brew install shellcheck)." || return 1
    find "$infra" -name '*.sh' -not -path '*/.dev/*' -print0 | xargs -0 shellcheck -x
}

executable_scripts() {
    local not_executable
    not_executable="$(find "$infra" -name '*.sh' -not -path '*/.dev/*' ! -perm -u+x)"
    if [ -n "$not_executable" ]; then
        echo "These scripts are not executable (chmod +x):"
        printf '%s\n' "$not_executable"
        return 1
    fi
}

dockerfiles() {
    need hadolint "Run: infra/scripts/install-tool.sh hadolint (or brew install hadolint)." || return 1
    local file
    for file in "$infra"/docker/*.Dockerfile; do
        hadolint "$file"
    done
}

workflows() {
    need actionlint "Run: infra/scripts/install-tool.sh actionlint (or brew install actionlint)." || return 1
    (cd "$repo" && actionlint)
}

caddyfile() {
    need docker "Install Docker." || return 1
    local image
    image="$("$here/image-of.sh" caddy)"
    docker run --rm -v "$infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
        -e LB_API_HOST=api.example.com -e LB_SITE_ORIGIN=https://example.com \
        "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
    docker run --rm -v "$infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$image" caddy fmt /etc/caddy/Caddyfile \
        | diff -u "$infra/caddy/Caddyfile" - || {
        echo "The Caddyfile is not formatted the way caddy fmt writes it."
        return 1
    }
}

# systemd-analyze complains that the programs a unit starts are not on this machine; they
# are on the box, once the first release is there. Anything else it says is a real problem.
systemd_units() {
    if ! command -v systemd-analyze >/dev/null 2>&1; then
        echo "(systemd-analyze is not installed: skipped)"
        return 0
    fi
    local problems
    problems="$(systemd-analyze verify "$infra"/systemd/*.service "$infra"/systemd/*.timer 2>&1 | grep -v 'is not executable: No such file or directory' || true)"
    if [ -n "$problems" ]; then
        printf '%s\n' "$problems"
        return 1
    fi
}

# The nightly backup and a deploy's jobs never run at the same time: the memory budget counts
# them as groups that never meet (compose-policy.jq). So the backup's unit must start it through
# flock, on the file deploy.sh locks, and give up waiting for it before systemd's own timeout
# ends the unit. test-deploy.sh runs the unit's command beside a real deploy; this reads the unit.
backup_takes_the_deploy_lock() {
    local unit="$infra/systemd/lb-backup.service" index wait_seconds="" timeout_minutes
    local -a command
    read -ra command <<<"$(sed -n 's/^ExecStart=//p' "$unit")"
    if [ "${command[0]:-}" != /usr/bin/flock ]; then
        echo "lb-backup.service does not start the backup through /usr/bin/flock, so it could run beside a deploy."
        return 1
    fi
    # deploy.sh locks $root/deploy.lock, and its root is /opt/lb unless LB_ROOT says otherwise.
    # shellcheck disable=SC2016 # the dollar signs are deploy.sh's own text, not to be expanded here
    if ! grep -qF 'root="${LB_ROOT:-/opt/lb}"' "$here/deploy.sh" || ! grep -qF 'exec 9> "$root/deploy.lock"' "$here/deploy.sh"; then
        echo "deploy.sh no longer locks /opt/lb/deploy.lock, the file lb-backup.service waits for: change the two together."
        return 1
    fi
    if ! printf '%s\n' "${command[@]}" | grep -qxF /opt/lb/deploy.lock; then
        echo "lb-backup.service does not lock /opt/lb/deploy.lock, the file deploy.sh holds."
        return 1
    fi
    for index in "${!command[@]}"; do
        if [ "${command[$index]}" = --wait ]; then wait_seconds="${command[index + 1]:-}"; fi
    done
    timeout_minutes="$(sed -n 's/^TimeoutStartSec=\([0-9][0-9]*\)min$/\1/p' "$unit")"
    if ! [[ "$wait_seconds" =~ ^[0-9]+$ && "$timeout_minutes" =~ ^[0-9]+$ ]] || [ "$wait_seconds" -ge $((timeout_minutes * 60)) ]; then
        echo "lb-backup.service must wait for the lock with --wait <seconds>, for less than its TimeoutStartSec=<minutes>min."
        return 1
    fi
}

# copy_sources <COPY line>: the paths a COPY instruction reads from the build context, one a
# line: every word after the flags and before the last word, which is the destination.
copy_sources() {
    local -a words=() paths=()
    local word
    read -ra words <<<"$1"
    for word in "${words[@]:1}"; do
        case "$word" in
            --*) ;;
            *) paths+=("$word") ;;
        esac
    done
    if [ "${#paths[@]}" -gt 1 ]; then
        printf '%s\n' "${paths[@]:0:${#paths[@]}-1}"
    fi
}

# Every image's .dockerignore excludes everything and then admits the files the image needs, so
# a COPY of a file the list forgot fails only in the image build, after every other check has
# passed. This checks the lists against the Dockerfiles instead: every source a COPY names (a
# copy out of another stage, --from, reads nothing from the repository) must match an admitted
# pattern. Patterns are matched the way bash matches them, where `**` and `*` alike cross
# slashes, which is what these lists need; a copied directory is admitted when a pattern admits
# a file inside it.
dockerignore_admits_every_copy() {
    local file ignore line source pattern admitted problems=0
    for file in "$infra"/docker/*.Dockerfile; do
        ignore="$file.dockerignore"
        if [ ! -f "$ignore" ]; then
            echo "${file#"$repo"/} has no .dockerignore beside it."
            problems=1
            continue
        fi
        while IFS= read -r line; do
            while IFS= read -r source; do
                admitted=0
                while IFS= read -r pattern; do
                    # shellcheck disable=SC2053 # the admitted path is a pattern, and is matched as one
                    if [[ "$source" == $pattern || "${source%/}/file" == $pattern ]]; then
                        admitted=1
                        break
                    fi
                done < <(sed -n 's/^!//p' "$ignore")
                if [ "$admitted" = 0 ]; then
                    echo "${file#"$repo"/} copies $source, which ${ignore#"$repo"/} does not admit."
                    problems=1
                fi
            done < <(copy_sources "$line")
        done < <(grep -E '^COPY ' "$file" | grep -v -- '--from=')
    done
    return "$problems"
}

secrets_folder() {
    local file
    for file in "$infra"/secrets/*; do
        case "$file" in
            */README.md | */*.example.env) ;;
            */*.enc.env)
                if ! grep -q '^sops_mac=ENC\[' "$file"; then
                    echo "${file#"$repo"/} is not encrypted with SOPS."
                    return 1
                fi
                ;;
            *)
                echo "${file#"$repo"/} does not belong in infra/secrets (only README.md, *.example.env and *.enc.env do)."
                return 1
                ;;
        esac
    done
}

echo "Infrastructure checks"
check "shell scripts pass shellcheck" shell_scripts
check "shell scripts are executable" executable_scripts
check "Dockerfiles pass hadolint" dockerfiles
check "every file a Dockerfile copies is admitted by its .dockerignore" dockerignore_admits_every_copy
check "workflows pass actionlint" workflows
check "every image is pinned by digest or built here" "$here/pin-images.sh" --check
check "Compose files follow the security rules" "$here/check-compose.sh"
check "the policy rules themselves can fail" "$here/test-compose-policy.sh"
check "the Caddyfile is valid and formatted" caddyfile
check "systemd units parse" systemd_units
check "the nightly backup takes the deploy's lock, for less than its unit's timeout" backup_takes_the_deploy_lock
check "infra/secrets holds only templates and encrypted files" secrets_folder

echo
if [ "$failures" -eq 0 ]; then
    echo "All checks passed."
else
    echo "$failures check(s) failed." >&2
    exit 1
fi
