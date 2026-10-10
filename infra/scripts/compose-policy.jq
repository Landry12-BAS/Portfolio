# The platform's security rules for a Compose configuration, as a jq program. Fed the output
# of `docker compose config --format json`, it prints one line for every rule a service (or a
# network) breaks, and nothing when the configuration follows them all. check-compose.sh runs
# it on the real files, and test-compose-policy.sh runs it on small made-up ones to show that
# each rule can fail. $dev says which stack it is looking at: the local stack publishes
# Caddy's port (on 127.0.0.1), and Caddy then also joins `outbound`, which Docker needs to
# publish a port. Given `--argjson sums true`, it prints the memory budget's sums instead, in
# one line, which check-compose.sh shows for a configuration that passes.

def long_running: (.restart // "no") != "no";
def has_healthcheck: ((.healthcheck // null) != null) and ((.healthcheck.disable // false) != true);
def outbound_members: if $dev then ["egress-gateway", "egress-systems", "cloudflared", "caddy"]
                      else ["egress-gateway", "egress-systems", "cloudflared"] end;
# LB-07's browser sandbox: the one container that runs a browser, and the one service that calls it.
def sandbox_members: ["lb07-sandbox", "node-worker"];

# --- The memory budget ---------------------------------------------------------------------
# The box's memory, in MiB (docker-compose.yml, Resources; docs/DEPLOY.md, "The memory
# budget"). A limit is a ceiling, not a reservation, but the ceilings of everything that can
# run at once must fit in what the host leaves: 12 GiB, less 1 for the host. They are counted
# as they run. What runs all the time counts in full. A deploy runs its one-shot jobs in waves,
# each job waiting for every job of the waves before it to finish, so only the biggest wave
# counts. The nightly backup runs under the deploy's lock, alone beside the services, so it is
# a group of its own. The jobs add the larger of the two. A service that does not fit fails
# here, and the fix is a decision, not an edit of this number.
def budget_mib: 11264;

# A service's memory limit, in MiB (Compose writes it in bytes).
def limit_mib: (.mem_limit // "0" | tonumber) / 1048576;

# Whether every `up` starts the service, a deploy's included: it is behind no profile.
def started_by_up: ((.profiles // []) | length) == 0;

# Whether the service carries the label that marks a job the host starts under the deploy's
# lock: the nightly backup, whose unit takes it (infra/systemd/lb-backup.service; check.sh and
# test-deploy.sh hold the unit to it).
def under_deploy_lock: ((.labels // {})["lb.runs-under-deploy-lock"] // "") == "true";

# A job of a deploy: a one-shot service that every `up` starts.
def deploy_job: (long_running | not) and (under_deploy_lock | not) and started_by_up;

# A job the host starts under the deploy's lock, so never beside a deploy's jobs.
def lock_job: (long_running | not) and under_deploy_lock;

# The names of a deploy's jobs. The input is the whole configuration.
def deploy_job_names: [ .services | to_entries[] | select(.value | deploy_job) | .key ];

# The services that have finished before the named one can start: those it waits for with
# service_completed_successfully, and whatever those it waits for (on any condition) wait for
# in turn, since a service that has started has seen its own waits through. The input is the
# whole configuration; Compose refuses a cycle, so the walk ends.
def finished_before($name):
  . as $config
  | [ (.services[$name].depends_on // {}) | to_entries[]
      | .key as $dependency
      | ( if .value.condition == "service_completed_successfully" then $dependency else empty end ),
        ( $config | finished_before($dependency)[] ) ]
  | unique;

# The wave a job of a deploy runs in: one more than the highest wave among the deploy's jobs it
# waits to see finished, so 1 for a job that waits for none.
def wave($name):
  . as $config
  | deploy_job_names as $jobs
  | [ finished_before($name)[] | select(IN($jobs[])) | . as $job | $config | wave($job) ]
  | (max // 0) + 1;

# A deploy's jobs, each with its wave and its limit: [{name, wave, mib}].
def deploy_jobs:
  . as $config
  | [ .services | to_entries[] | select(.value | deploy_job)
      | .key as $name
      | {name: $name, wave: ($config | wave($name)), mib: (.value | limit_mib)} ];

# A deploy's waves, in the order they run, each with its jobs and the sum of their limits.
def waves:
  deploy_jobs | group_by(.wave) | map({wave: .[0].wave, jobs: map(.name), mib: (map(.mib) | add)});

# The jobs under the deploy's lock, and the sum of their limits. Each runs alone, so the sum is
# exact for the one there is, and too much rather than too little if there are ever more.
def lock_group:
  [ .services | to_entries[] | select(.value | lock_job) ]
  | {jobs: map(.key), mib: (map(.value | limit_mib) | add // 0)};

# What the jobs add at their peak: the larger of the biggest wave and the group under the
# deploy's lock, with words that say which it is.
def jobs_peak:
  (waves | max_by(.mib)) as $wave
  | lock_group as $lock
  | if $wave == null and $lock.mib == 0 then {mib: 0, what: "no job"}
    elif $wave != null and $wave.mib >= $lock.mib
    then {mib: $wave.mib, what: "wave \($wave.wave) of a deploy (\($wave.jobs | join(", ")))"}
    else {mib: $lock.mib, what: "the jobs under the deploy's lock (\($lock.jobs | join(", ")))"} end;

# The memory the box must have at the peak: what runs all the time, and the jobs' peak beside it.
def memory_at_peak:
  { running: ([ .services[] | select(long_running) | limit_mib ] | add // 0), jobs: jobs_peak }
  | .total = .running + .jobs.mib;

# Two jobs of different waves that could run at the same time, because the later one does not
# wait to see the earlier one finished: counting a wave at a time would then count too little.
def overlapping_jobs:
  . as $config
  | deploy_jobs as $jobs
  | $jobs[] as $later
  | ($config | finished_before($later.name)) as $finished
  | $jobs[] as $earlier
  | select($earlier.wave < $later.wave and ($earlier.name | IN($finished[]) | not))
  | "\($later.name) (wave \($later.wave)) does not wait for \($earlier.name) (wave \($earlier.wave)) to finish: the two could run at the same time, and the memory budget counts a deploy's waves one at a time";

# The budget's sums in one line, for check-compose.sh to show when the rules pass.
def memory_sums:
  memory_at_peak as $peak
  | lock_group as $lock
  | "memory at the peak, in MiB: \($peak.running) for what runs all the time + \($peak.jobs.mib) for \($peak.jobs.what) = \($peak.total), of the \(budget_mib) the box has to give (\(budget_mib - $peak.total) to spare); a deploy's waves: \(waves | map(.mib | tostring) | join(", ")); the jobs under the deploy's lock: \($lock.mib)";

# --- The rules -----------------------------------------------------------------------------
if ($ARGS.named.sums // false) then memory_sums else (

( memory_at_peak
  | if .total > budget_mib
    then "the memory limits come to \(.total) MiB at the peak, over the \(budget_mib) MiB the box has to give (12 GiB less 1 for the host): \(.running) MiB for what runs all the time, and \(.jobs.mib) MiB for \(.jobs.what)"
    else empty end ),
overlapping_jobs,

# The networks: every one but `outbound` has no route out.
( .networks | to_entries[]
  | select(.key != "outbound" and ((.value.internal // false) != true))
  | "network \(.key) is not internal: a container on it could reach the internet" ),
# The browser's network gives the host no address either: an internal network's gateway address
# is the host's own, and through it a container reaches what the host listens on.
( .networks.sandbox // empty
  | select((.driver_opts["com.docker.network.bridge.inhibit_ipv4"] // "false") != "true")
  | "network sandbox gives the host an address: LB-07's browser could reach the box's own services" ),

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
      # The memory budget has a group for every service: what runs all the time, a deploy's
      # jobs (which every `up` starts), and the jobs under the deploy's lock.
      ( if ($s | long_running | not) and ($s | under_deploy_lock | not) and ($s | started_by_up | not)
        then "is a one-shot job that no deploy starts (profile \($s.profiles | join(", "))) and is not marked as running under the deploy's lock (lb.runs-under-deploy-lock): the memory budget has no group for it" else empty end ),
      ( if ($s | lock_job) and ($s | started_by_up)
        then "is marked as running under the deploy's lock, but every `up` starts it beside a deploy's jobs: it belongs behind a profile" else empty end ),
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
        then "is on networks other than data" else empty end ),
      ( if (($s.networks // {}) | has("sandbox")) and (sandbox_members | index($name) == null)
        then "joins the sandbox network, which only LB-07's browser sandbox and the Node worker may" else empty end ),
      ( if $name == "lb07-sandbox" and ((($s.networks // {}) | keys) != ["sandbox"])
        then "is on networks other than sandbox" else empty end ),
      ( ($s.environment // {}) | keys | map(select(startswith("LB07_") | not))
        | if $name == "lb07-sandbox" and length > 0
          then "is given settings that are not its own (LB07_*): \(join(", "))" else empty end )
    )
  | "\($name): \(.)" )

) end
