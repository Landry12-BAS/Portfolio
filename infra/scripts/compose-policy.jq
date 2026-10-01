# The platform's security rules for a Compose configuration, as a jq program. Fed the output
# of `docker compose config --format json`, it prints one line for every rule a service (or a
# network) breaks, and nothing when the configuration follows them all. check-compose.sh runs
# it on the real files, and test-compose-policy.sh runs it on small made-up ones to show that
# each rule can fail. $dev says which stack it is looking at: the local stack publishes
# Caddy's port (on 127.0.0.1), and Caddy then also joins `outbound`, which Docker needs to
# publish a port.

def long_running: (.restart // "no") != "no";
def has_healthcheck: ((.healthcheck // null) != null) and ((.healthcheck.disable // false) != true);
def outbound_members: if $dev then ["egress-gateway", "egress-systems", "cloudflared", "caddy"]
                      else ["egress-gateway", "egress-systems", "cloudflared"] end;

# The networks: every one but `outbound` has no route out.
( .networks | to_entries[]
  | select(.key != "outbound" and ((.value.internal // false) != true))
  | "network \(.key) is not internal: a container on it could reach the internet" ),

# Each service.
( .services | to_entries[] | .key as $name | .value as $s
  | (
      ( if $s.read_only != true then "the root filesystem is not read-only" else empty end ),
      ( if (($s.cap_drop // []) | index("ALL")) == null then "capabilities are not all dropped" else empty end ),
      ( if (($s.cap_add // []) | length) > 0 and (($name == "caddy" and $s.cap_add == ["NET_BIND_SERVICE"]) | not)
        then "adds capabilities back: \($s.cap_add | join(", "))" else empty end ),
      ( if (($s.security_opt // []) | index("no-new-privileges:true")) == null then "does not set no-new-privileges" else empty end ),
      ( if ($s.privileged // false) then "is privileged" else empty end ),
      ( if ($s.network_mode // "") == "host" or ($s.pid // "") == "host" or ($s.ipc // "") == "host"
        then "shares the host's network, PID or IPC namespace" else empty end ),
      ( if (($s.devices // []) | length) > 0 then "is given host devices" else empty end ),
      ( if ($s.user // "") | IN("0", "root", "0:0", "root:root") then "runs as root" else empty end ),
      ( if ($s.mem_limit // null) == null then "has no memory limit" else empty end ),
      ( if ($s.cpus // null) == null then "has no CPU limit" else empty end ),
      ( if ($s.pids_limit // null) == null then "has no process limit" else empty end ),
      ( if ($s | long_running) and (($s | has_healthcheck) | not) then "runs all the time but has no health check" else empty end ),
      ( if ($s | long_running) and $s.restart != "unless-stopped" then "restarts with \($s.restart), not unless-stopped" else empty end ),
      ( if ($s.logging.options["max-size"] // null) == null then "does not rotate its logs" else empty end ),
      ( ($s.ports // [])[]
        | if $dev then ( if (.host_ip // "") != "127.0.0.1" then "publishes port \(.published) on \(.host_ip // "every address"), not on 127.0.0.1" else empty end )
          else "publishes port \(.published): the box has no inbound ports" end ),
      ( ($s.volumes // [])[]
        | select(.type == "bind")
        | ( if .read_only != true then "mounts \(.source) read-write" else empty end ),
          ( if (.source | test("docker\\.sock")) then "mounts the Docker socket" else empty end ) ),
      ( if (($s.networks // {}) | has("outbound")) and (outbound_members | index($name) == null)
        then "joins the outbound network, which only the egress proxies and the tunnel may" else empty end ),
      ( if ($name == "postgres" or $name == "redis") and ((($s.networks // {}) | keys) != ["data"])
        then "is on networks other than data" else empty end )
    )
  | "\($name): \(.)" )
