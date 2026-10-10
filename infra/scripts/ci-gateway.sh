#!/usr/bin/env bash
# Runs the AI gateway inside a GitHub Actions job for Eval Lab's commands (.github/workflows/evals.yml).
#
#   infra/scripts/ci-gateway.sh start    make a throwaway key pair for flask-systems, start the gateway on
#                                        loopback with the provider keys the job's environment holds, wait
#                                        until it answers
#   infra/scripts/ci-gateway.sh stop     stop it and remove the key
#
# The gateway reads the provider keys from its environment (GROQ_API_KEY, CLOUDFLARE_ACCOUNT_ID,
# CLOUDFLARE_API_TOKEN, OPENROUTER_API_KEY), which the workflow sets from the repository's secrets and
# this script never prints. The service key is made here and lives for the job: it is the one
# LB_SERVICE_KEY_FILE names, and its public half is the one entry of LB_SERVICE_KEYS.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
key_dir="${LB_EVAL_KEY_DIR:-$root/.lb-eval}"
key_file="${LB_SERVICE_KEY_FILE:-$key_dir/flask-systems.jwk.json}"
pid_file="$key_dir/gateway.pid"
log_file="$key_dir/gateway.log"
url="${LB_GATEWAY_URL:-http://127.0.0.1:8080}"

start() {
  mkdir -p "$key_dir"
  rm -f "$key_file"
  local keys
  # keygen prints two lines: a sentence, then the JSON entry for LB_SERVICE_KEYS.
  keys="$(cd "$root/services/gateway" && node src/cli/service-token.ts keygen flask-systems "$key_file" | tail -n 1)"
  (
    cd "$root/services/gateway"
    LB_GATEWAY_PROFILE=production \
    LB_GATEWAY_HOST=127.0.0.1 \
    LB_GATEWAY_PORT="${url##*:}" \
    LB_GATEWAY_LOG_LEVEL=warn \
    LB_REDIS_URL="${LB_REDIS_URL:-redis://127.0.0.1:6379}" \
    LB_SERVICE_KEYS="$keys" \
    nohup node src/main.ts > "$log_file" 2>&1 &
    echo $! > "$pid_file"
  )
  local tries=0
  until curl -fsS "$url/healthz" > /dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "The gateway did not answer at $url/healthz in time; its log:" >&2
      cat "$log_file" >&2
      exit 1
    fi
    sleep 1
  done
  echo "The gateway answers at $url."
}

stop() {
  if [ -f "$pid_file" ]; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    rm -f "$pid_file"
  fi
  rm -f "$key_file"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "Usage: ci-gateway.sh start|stop" >&2; exit 2 ;;
esac
