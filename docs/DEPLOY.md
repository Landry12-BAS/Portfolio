# Deploying the platform

The owner's runbook: how the platform gets from this repository to a live site, in the
order to do it, with the exact commands and names. Why it is built this way is in
[`STACK.md`](STACK.md) and [`SECURITY.md`](SECURITY.md); how each secret is handled is in
[`infra/secrets/README.md`](../infra/secrets/README.md).

**Status of this runbook.** Everything that runs inside this repository was run and
tested (the images, the Compose stack through Caddy, the Postgres roles, the Redis ACL,
the secrets tooling, the deploy script's decisions, an encrypted backup and its restore).
The steps that need Oracle Cloud, Cloudflare, Tailscale, GitHub's registry and signing, or
Vercel were written from those products' documentation and have not been run: if a menu
is named differently by the time you get there, the intent of the step is what counts.
Part 12 lists exactly what is unverified.

## What runs where

| Where | What | Reached by |
|---|---|---|
| Vercel | The site (`apps/web`) | `https://example.com` |
| The box (one Oracle Cloud VM) | The whole back end, as one Docker Compose project named `lb`: Caddy, `cloudflared`, the gateway, the Django, Flask and Node systems, LB-07's browser sandbox, Postgres, Redis, two egress proxies | Visitors only through Cloudflare's tunnel to Caddy; you only over Tailscale |
| Cloudflare | DNS, the tunnel, the WAF, Turnstile, and R2 (the backup bucket, and LB-03's uploads bucket) | |
| GitHub | The code, CI, and GHCR (the signed images) | |
| Tailscale | The private network that CI and you use to reach the box | |

The box opens no inbound port. Visitors come in through the tunnel the box dials out to
Cloudflare; the API answers on its own hostname, `https://api.example.com`, and the site
calls it from the visitor's browser. Replace `example.com` with your domain everywhere
below. A release is a git commit: its 40-character hash is the tag of its images and the
name of its folder on the box.

## Contents

1. [Accounts and tools](#1-accounts-and-tools)
2. [The box: Oracle Cloud](#2-the-box-oracle-cloud)
3. [The box: Tailscale, then close SSH](#3-the-box-tailscale-then-close-ssh)
4. [The box: system, Docker, folders, tools, keys](#4-the-box-system-docker-folders-tools-keys)
5. [Cloudflare: tunnel, DNS, Turnstile, R2](#5-cloudflare-tunnel-dns-turnstile-r2)
6. [Provider keys and service keys](#6-provider-keys-and-service-keys)
7. [Secrets](#7-secrets)
8. [GitHub](#8-github)
9. [The first deploy](#9-the-first-deploy)
10. [Vercel](#10-vercel)
11. [Verification checklist](#11-verification-checklist)
12. [What is not verified](#12-what-is-not-verified)
13. [Day to day](#13-day-to-day): deploying, rolling back, logs, backups, rotating a key, adding a service, upgrading images, replacing the box

## 1. Accounts and tools

Accounts, all on free plans: Oracle Cloud (Always Free), Cloudflare, GitHub, Tailscale,
Vercel, and the three model providers (Groq, Cloudflare Workers AI, OpenRouter). A domain
whose DNS is on Cloudflare.

On your own machine, from a clone of this repository, you need `just`, `git`, Node and
pnpm, `uv`, Docker, `age`, `openssl`, `jq`, and `sops` (Linux:
`sudo infra/scripts/install-tool.sh sops`; macOS: `brew install sops age`), plus the
Tailscale client, signed in to your tailnet. Check the secrets tooling works before you
rely on it:

```sh
just install
just secrets-test        # real sops and age, throwaway keys: ends with "All checks passed."
```

## 2. The box: Oracle Cloud

The box is one Always Free Ampere A1 VM: ARM64, **2 OCPUs and 12 GB of RAM**, the whole
allowance since Oracle's June 2026 cut (`STACK.md`, Infrastructure and hosting).

1. **Home region.** Sign up for Oracle Cloud and choose your home region with care. Always
   Free compute only runs in the home region, and it cannot be changed later. Keep the
   tenancy on Always Free: pay-as-you-go adds billing risk and gains nothing here.
2. **Create the instance** (Compute, Instances, Create instance):
   - Image: Canonical Ubuntu 24.04, the `aarch64` build.
   - Shape: Ampere, `VM.Standard.A1.Flex`, 2 OCPUs, 12 GB.
   - Boot volume: 100 GB is plenty (Always Free allows 200 GB of block storage in all).
   - Networking: the default VCN and a public subnet, with a public IPv4 address assigned.
     The box needs the address to reach the internet; once SSH is closed (part 3), nothing
     can reach it.
   - SSH keys: paste your public key. You use it once, to get in and install Tailscale.
3. **The capacity trap.** Oracle often answers "Out of host capacity" for Ampere shapes.
   It is a temporary shortage in your region, not a limit on your account: wait and
   launch again (early morning and late night local time tend to work), and try each
   availability domain in turn if your region has several. Do not switch region.
   Creating the VM with 1 OCPU and 6 GB and editing the shape to 2 and 12 afterwards is a
   known way around a shortage; it needs a reboot.
4. **Mind the reclaim rule.** Oracle reclaims an Always Free VM whose CPU, network and
   memory all stay under 20% (at the 95th percentile) for 7 days. In testing, the stack
   used about 0.7 GB when idle, which is 6% of 12 GB, so memory alone does not clear the
   line, and a quiet portfolio will not clear it on CPU or network either. In the first
   week, read the instance's metrics (Compute, Instance, Metrics). If all three stay
   under 20%, decide before Oracle does: keep memory above 2.4 GB on purpose (a larger
   Postgres `shared_buffers` and a small always-on job that holds memory are the usual
   ways), or move the tenancy to pay-as-you-go, which Oracle does not reclaim and which
   keeps the same free allowance at the price of billing risk.
5. Note the instance's public IP, and connect once:

   ```sh
   ssh ubuntu@<public ip>
   sudo apt-get update && sudo apt-get -y full-upgrade && sudo reboot
   ```

**The memory budget.** Every container has a memory limit (`infra/docker-compose.yml`,
Resources), and the limits are budgeted against the box's 12 GiB, of which the host keeps 1. They
are counted as they run, in one rule: what runs all the time counts in full, and beside it the
largest group of one-shot jobs that can run at the same moment, which is a deploy's biggest wave or
the nightly backup, since the two never meet; the sum must fit in 11 GiB (11264 MiB).
`just infra-check` fails a change that breaks it, prints the sums when it passes, and refuses
what would make the count wrong: a job that could run beside a job of an earlier wave (it names
the two), and a one-shot job that is in no group. A limit is a ceiling, not a reservation: it is
what a service may reach before the kernel kills it.

| Service | Limit, MiB | Runs | What the number rests on |
|---|---|---|---|
| `flask-api` | 2048 | always | DuckDB's 1 GB limit, and LB-03's OCR worker, measured at 692 to 837 MiB |
| `postgres` | 2048 | always | Its settings: about 640 MiB for itself (`shared_buffers` 256 MB, three autovacuum workers at `maintenance_work_mem` 128 MB), and the rest for up to 100 connections, a few MiB each and `work_mem` 8 MB for every sort |
| `django-worker` | 1024 (was 768) | always | Two Celery processes, each recycled at 300 MB, and LB-09's private transcriber (faster-whisper, Whisper's base model in int8). **Measured** on a development machine (x86-64, not the box's Ampere A1): the child that ran a one-minute private meeting peaked at 472 to 484 MiB and the whole worker at 638 MiB; two meetings at once reached 974 MiB, so private transcriptions take turns (a file lock, `lb09/transcribers.py`), and 1024 MiB leaves about 380 MiB beside the one that runs, for the decoder child and the tickets |
| `node-worker` | 768 | always | LB-04's PDF threads: measured at 291 MiB for two 30-page contracts at once, about 760 MiB if hostile files take every limit they are given |
| `django-api` | 512 | always | Not measured |
| `redis` | 512 | always | `maxmemory` 384 MB, and room beside it |
| `gateway`, `node-api` | 384 each | always | V8's default heap (259 MB), and room beside it |
| `lb07-sandbox` | 384 | always | **Measured:** the runner and Chromium over five runs in a row of the heaviest golden plan peaked at 263 to 271 MiB under this limit (three measurements, the kernel's count with page cache) and at 327 to 332 MiB with none; idle, 96 to 127 MiB (x86-64; `just test-lb07-sandbox` repeats the runs) |
| `caddy`, `cloudflared`, the two egress proxies | 128 each | always | Not measured |
| **What runs all the time** | **8576** | | Counted in full |
| `postgres-provision` | 128 | a deploy, wave 1 | `psql` |
| `django-migrate` | 384 | a deploy, wave 2 | Not measured |
| `flask-migrate` | 256 | a deploy, wave 2 | Not measured |
| `node-migrate` | 256 | a deploy, wave 2 | Measured: 215 MiB resident (the four Node systems, x86-64) |
| `flask-seed` | 1280 | a deploy, wave 3 (it makes the data only when it must) | Measured at 923 MB; DuckDB's limit is 1 GB |
| `node-seed` | 256 | a deploy, wave 3 | Measured: 209 MiB resident (the four Node systems, x86-64) |
| **A deploy's waves** | **128, 896, 1536** | | Each job waits for every job of the waves before it to finish, so the waves never overlap, and the biggest counts: wave 3 |
| `backup` | 768 | 02:30, under the deploy's lock | `pg_dump`, `age` and `rclone`, and the encrypted dump in a 512 MB tmpfs: the database holds synthetic data and none of the visitors' rows, a few MiB |
| **At the peak** | **10112** | | 8576 and wave 3's 1536 (more than the backup's 768): 1152 MiB, about 1.1 GiB, under the 11264 |

**The decision: count the jobs as they run.** LB-09's private transcriber took `django-worker`
from 768 to 1024 MiB when the budget was already full: LB-07's sandbox had taken its last quarter
GiB by trimming Postgres (2048 to 1920 MiB) and the nightly backup (768 to 512 MiB, its tmpfs from
512 to 256 MB). The rule then had two sums, every limit added up and what runs all the time apart,
and both failed (11520 of 11264, and 8448 of 8192). Of the four options that were open, **the lead
engineer chose the third, in the owner's place; the owner can still revisit it.** Why: the old
sums counted every job as if all of them ran at once. They mostly did not, but nothing kept them
apart either (`flask-seed` waited for nothing and ran beside the provision and the migrations, and
`node-seed` waited for one migration of three). Now the order is enforced and the count follows
it: a deploy runs its jobs in three waves that never
overlap (`flask-seed` and `node-seed` wait for all three migrations), the backup takes the deploy's
lock, and the policy proves both. One budget is then enough, and the separate one for what runs all
the time is gone: it protected nothing the single rule does not, and two budgets that are really
one are how the last decision went wrong, by filling one of them to the last MiB. Postgres and the
backup have their old ceilings back (2048, and 768 with a 512 MB tmpfs).

What it costs:

- **A deploy waits for the migrations before it seeds.** LB-05's data job used to start at once;
  now it starts after the three migrations. On a first deploy that adds its tens of seconds to the
  wait; later deploys find the warehouse in place and skip it in seconds.
- **A deploy that starts while the backup runs is refused**, for the few minutes the backup takes
  after 02:30 UTC (part 13, Deploying): it changes nothing and says `another deploy or the nightly
  backup is running on this box`; re-run it a few minutes later.
- **The backup waits for a deploy that is running**, 20 minutes at most; past that it fails without
  a dump, `systemctl status lb-backup` shows it, and the next night tries again.
- The backup's unit changed (it runs under `flock`): install it again from the release that brings
  this change (part 9, step 5).

**The room left** is 1152 MiB (about 1.1 GiB) under the 11264. LB-10 needs no new container, so
the room stays for what comes after; a system that needs more needs a decision again (a smaller
limit elsewhere, or a heavy job given a wave of its own), not a bigger number.

The roads not taken:

- **Option 1, keep the trims** (Postgres at 1920 MiB, the backup at 512) and find LB-09's 256 MiB
  by trimming a third service, though every other ceiling is a measured peak with its margin, or unmeasured.
- **Option 2, give the ceilings back and raise both budgets** to fit (to 8576 and 11904 MiB): the
  limits would then add up to more than the box has, and at a peak the kernel would choose what to kill.
- **Option 4, run the sandbox only while LB-07 is used**: it would save 384 MiB most of the day, but
  needs something that starts containers, which nothing on the box may (none gets the Docker socket).

## 3. The box: Tailscale, then close SSH

Oracle's default security list opens SSH (port 22) to the whole internet. Install
Tailscale first, prove you can get in through it, and only then delete that rule.

1. **Tailnet policy.** In the Tailscale admin console (Access controls), add these entries
   to your policy file. They define the box's tag, CI's tag, who may reach the box, and
   who may SSH to it as which user. Tailscale SSH replaces SSH keys: the tailnet
   authenticates the connection, so no key for the box is stored in GitHub.

   ```json
   {
     "tagOwners": {
       "tag:lb-box": ["autogroup:admin"],
       "tag:ci": ["autogroup:admin"]
     },
     "grants": [
       { "src": ["autogroup:member"], "dst": ["tag:lb-box"], "ip": ["*"] },
       { "src": ["tag:ci"], "dst": ["tag:lb-box"], "ip": ["tcp:22"] }
     ],
     "ssh": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:lb-box"], "users": ["ubuntu", "deploy"] },
       { "action": "accept", "src": ["tag:ci"], "dst": ["tag:lb-box"], "users": ["deploy"] }
     ]
   }
   ```

   CI can then reach the box's SSH as `deploy`, and nothing else.
2. **Install Tailscale on the box** and join it as a tagged, SSH-enabled node:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --ssh --advertise-tags=tag:lb-box --hostname=lb-box
   ```

   Open the login URL it prints. The name `lb-box` is what you put in the GitHub variable
   `LB_BOX_HOST` later. A tagged node's key does not expire.
3. **Get in through Tailscale**, from your machine. Do this before the next step:

   ```sh
   tailscale ssh ubuntu@lb-box
   ```

4. **Delete the SSH rule.** In the OCI console: Networking, Virtual cloud networks, your
   VCN, Security Lists, the default one, Ingress Rules: delete the rule for TCP port 22
   from `0.0.0.0/0`, and the ICMP rules too. The list now admits nothing inbound.
5. **Make the host firewall agree**, so that nothing but Tailscale is let in. Oracle's
   Ubuntu image has no `ufw`. It ships iptables rules of its own in `/etc/iptables/rules.v4`,
   which `netfilter-persistent` loads at boot: they let in replies, ICMP, the loopback
   interface, NTP and new SSH connections on port 22, and reject the rest. Delete the SSH
   line and nothing else. The `InstanceServices` chain in the same file keeps the box's
   boot volume, metadata and clock reachable, and Oracle says never to remove it:

   ```sh
   grep -n -- '--dport 22' /etc/iptables/rules.v4    # one line: -A INPUT ... --dport 22 -j ACCEPT
   sudo sed -i '/-A INPUT .*--dport 22 -j ACCEPT/d' /etc/iptables/rules.v4
   grep -c -- '--dport 22' /etc/iptables/rules.v4    # 0
   sudo reboot
   ```

   After the reboot, `sudo iptables -S INPUT` has no `--dport 22` rule, and `tailscale ssh`
   still works: Tailscale adds its own rules when it starts, which accept what comes in on
   `tailscale0`. Apply the file only by rebooting, never with `netfilter-persistent reload`
   or `iptables-restore` on a running box: either replaces the whole table, and with it the
   rules Tailscale and Docker added when they started, which lose their network until they
   restart. Docker publishes no port here, so it needs no rule of its own. (On an Ubuntu image
   without that file, `ufw` does the same: `sudo ufw allow in on tailscale0`,
   `sudo ufw default deny incoming`, `sudo ufw --force enable`.)
6. **Check from outside** (your phone on mobile data, or any machine that is not on the
   tailnet): `ssh -o ConnectTimeout=8 ubuntu@<public ip>` must time out, and
   `tailscale ssh ubuntu@lb-box` must still work.

## 4. The box: system, Docker, folders, tools, keys

All of this runs as `ubuntu` (`tailscale ssh ubuntu@lb-box`).

**The `deploy` user.** CI and you operate the stack as `deploy`. It is in the `docker`
group, which is root-equivalent on the box, so it is reachable only through the Tailscale
SSH rules above, with no password and no key:

```sh
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-lb.conf
sudo systemctl reload ssh
```

**Automatic security updates**, with a reboot at 04:30 UTC, after the 02:30 backup:

```sh
sudo apt-get install -y unattended-upgrades
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades
printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:30";\n' | sudo tee /etc/apt/apt.conf.d/52lb-reboot
```

**A kernel setting Redis asks for** (without it Redis warns at every start):

```sh
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-lb.conf
sudo sysctl --system
```

**Docker and Compose**, from Docker's own apt repository:

```sh
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Then keep containers running while the Docker daemon restarts, publish nothing by
default, and rotate logs:

```sh
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
docker compose version      # 2.20 or later (the stack uses depends_on "required"); tested on 5.1
```

**Tools.** `age` and `jq` come from Ubuntu; `sops` and `cosign` are pinned releases that
`infra/scripts/install-tool.sh` checks against their published SHA-256 before installing.
Run it from your clone, so the box needs no copy of the repository yet:

```sh
sudo apt-get install -y age jq
```

and from your machine, in the repository:

```sh
tailscale ssh ubuntu@lb-box 'sudo bash -s -- sops cosign' < infra/scripts/install-tool.sh
```

**Folders.** `/opt/lb` holds the releases; `/etc/lb` holds the box's age key; `/run/lb`
(memory) holds the decrypted secrets and is recreated at every boot by systemd:

```sh
sudo install -d -o deploy -g deploy -m 0755 /opt/lb /opt/lb/releases
sudo install -d -o deploy -g deploy -m 0700 /etc/lb
```

and from your machine, in the repository:

```sh
tailscale ssh ubuntu@lb-box 'sudo tee /etc/tmpfiles.d/lb.conf > /dev/null && sudo systemd-tmpfiles --create /etc/tmpfiles.d/lb.conf' < infra/systemd/lb.tmpfiles.conf
```

**The box's age key.** The box decrypts the secrets with its own key, made here and used
nowhere else. Its public half is not secret; you need it in part 7:

```sh
sudo -u deploy age-keygen -o /etc/lb/age.key      # prints: Public key: age1...
sudo -u deploy chmod 600 /etc/lb/age.key
```

Copy the `age1...` line it prints (`sudo -u deploy age-keygen -y /etc/lb/age.key` prints it
again). If the box is ever lost, remove this key from `.sops.yaml` and rotate every secret
(part 13, Rotating a key).

## 5. Cloudflare: tunnel, DNS, Turnstile, R2

**The domain.** Add your domain to Cloudflare and point its nameservers at Cloudflare. In
SSL/TLS, set the minimum TLS version to 1.3. Keep the records that point your site at
Vercel DNS-only (grey cloud), as Vercel recommends; the API record below is proxied.

**The tunnel** (Zero Trust, Networks, Tunnels):

1. Create a tunnel of type Cloudflared, named `lb`.
2. On the install page, do not run the connector command. Copy the **token**: the long
   string after `--token`. It goes into `cloudflared.enc.env` in part 7, and nowhere else.
3. Add a Public Hostname: subdomain `api`, domain `example.com`, service type `HTTP`,
   URL `caddy:8080`. Cloudflare creates the DNS record for you:

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | CNAME | `api` | `<tunnel id>.cfargotunnel.com` | proxied |

   The `cloudflared` container reaches `caddy` by name on the `edge` network, and Caddy
   is the only thing it talks to.

**Rate limiting.** Do not make the rate-limiting rule per IP address for the API hostname
as a whole. The site's server makes every visitor's call to the API from Vercel, so the API
sees a few addresses that all visitors share, and a per-IP rule sees the site, not the
visitor. One visitor, or an ordinary busy minute, trips "more than N requests in 10 seconds
from one IP", Cloudflare blocks Vercel's address, and every demo stops for everyone until the
block ends. A higher number only makes the rule harder to trip by accident; a visitor who
wants to trip it can still do so deliberately, from the site's address. The box's real limits
are per session and per system, and they see the visitor: each system's quotas (LB-01's 20
tickets a day, LB-02's 10 conversations, LB-05's 25 questions, LB-08's runs, LB-04's 3
contracts, LB-06's incident), the gateway's
per-session calls and its per-system and per-provider budgets, the Turnstile check before a
live run, and the gateway's limit on how often one run's trace is read.

What to use instead:

1. **The one thing visitors' browsers send straight to the API hostname is LB-02's WebSocket,
   at `/ws/`.** The address Cloudflare sees there is the visitor's own, so a per-IP rule is
   right there, and only there. In Security, WAF, Rate limiting rules, add one rule: when the
   host is `api.example.com` and the URI path starts with `/ws/`, more than 20 requests in 10
   seconds from one IP address, block.
2. **For the rest of the API hostname, which the site relays, no per-IP rule.** Leave
   Cloudflare's managed WAF rules and DDoS protection on: they judge a request by what it is,
   not by how many its address sent. Caddy serves only the routes it lists (part 11 checks
   this), and everything past it is limited per session and per system as above.
3. **Bot Fight Mode off** (Security, Bots). It judges who is calling, and on this hostname the
   caller is the site's own server: `fetch` from Vercel's data-centre addresses, which it can
   take for a bot and challenge. A challenged call is a `403` with `cf-mitigated: challenge`,
   and then every demo fails. On the free plan no WAF rule can exempt a path or a caller from
   it. What it would guard is guarded already: the routes Caddy lists want a visitor token,
   which the site mints only after Turnstile.
4. **If you want a per-IP limit on what the site relays, put it where the visitor's address is
   visible: on the site.** Vercel's Firewall can rate-limit `/api/*` by the visitor's address
   (check what your plan allows; that menu has not been run here). The site's own server has
   no limiter on purpose: one per serverless instance would not see all requests.

**Turnstile.** Turnstile, Add widget: hostname `example.com`, mode Managed. Keep the two
keys: the **site key** (public) and the **secret key**. They go to Vercel in part 10.

**R2, for the backups.**

1. R2, Create bucket: `lb-backups`.
2. In the bucket's settings, add an object lifecycle rule that deletes objects after 30
   days, or whatever retention you want.
3. R2, Manage API tokens, Create API token: permission Object Read and Write, scoped to
   the `lb-backups` bucket only. Keep the **access key ID**, the **secret access key**, and
   the endpoint `https://<account id>.r2.cloudflarestorage.com` (your account ID is on the
   R2 overview page).

**R2, for LB-03's uploads.** The visitors' invoices, and a picture of each of their pages,
for an hour. A second bucket, because its token must not be able to read the backups.

1. R2, Create bucket: `lb-uploads`. Leave it **private**: do not turn on public access, the
   `r2.dev` address or a custom domain for it. Nothing in the service makes a public address
   for a file or sets an access rule on one, and the only way a visitor gets anything back is
   a page's picture through the API, to the visitor who uploaded it.
2. In the bucket's settings, add an object lifecycle rule that deletes objects after 1 day.
   **This is the backstop, not the promise.** R2's lifecycle rules work in whole days, so a
   rule alone would keep a file for a day or more. The one-hour life is the service's own: it
   deletes each document and its files at their hour, sweeping every minute
   (`services/flask-systems/lb03/sweeper.py`), and `just sweep-lb03` does the same by hand.
   The rule only catches what a service that was not running left behind.
3. R2, Manage API tokens, Create API token: permission Object Read and Write, scoped to the
   `lb-uploads` bucket only, and a token of its own. Keep the **access key ID** and the
   **secret access key**: they go in `flask-systems` (part 7). The endpoint is the same as the
   backups'. The service reaches the bucket through the systems' egress proxy, so that host must
   be in `LB_EGRESS_SYSTEMS_ALLOW` (part 7). The S3 client was tested against moto's fake S3 and
   never against R2 itself (part 12).

## 6. Provider keys and service keys

**Provider keys.** Only the gateway holds these, and they go only into `gateway.enc.env`:

| Provider | What to create |
|---|---|
| Groq | An API key, from the Groq console |
| Cloudflare Workers AI | Your account ID, and an API token with the Workers AI permission |
| OpenRouter | A key made for this gateway alone, with a small credit limit, such as $1: the gateway only calls free (`:free`) models, and the limit is what stops a leaked key from spending the account's balance |

There is no NVIDIA key: its trial terms forbid production use, and production leaves it
off every chain.

**Service keys.** Services prove who they are to each other with Ed25519 signatures;
nothing here is a shared password. Make one pair for each of these, in a private folder
that is not in the repository:

```sh
mkdir -p ~/lb-keys && chmod 700 ~/lb-keys
just gateway-token keygen django-systems ~/lb-keys/django-systems.jwk.json
just gateway-token keygen flask-systems ~/lb-keys/flask-systems.jwk.json
just gateway-token keygen node-systems ~/lb-keys/node-systems.jwk.json
just gateway-token keygen web ~/lb-keys/web.jwk.json
just gateway-token keygen site ~/lb-keys/site.jwk.json
```

Each prints a line such as `{"django-systems":"<public key>"}`: the **public** half, a
base64url string. The private half stays in the file. Where each goes:

| Key | Public half | Private half |
|---|---|---|
| `django-systems`: the Django systems calling the gateway | An entry of `LB_SERVICE_KEYS` in the gateway's secrets | `LB_SERVICE_KEY_JWK_B64` in the Django secrets: the file, as one line of base64 |
| `flask-systems`: the Flask systems (LB-05) calling the gateway | An entry of `LB_SERVICE_KEYS` | `LB_SERVICE_KEY_JWK_B64` in the Flask secrets |
| `node-systems`: the Node systems (LB-08, LB-04, LB-06, LB-07) calling the gateway | An entry of `LB_SERVICE_KEYS` | `LB_SERVICE_KEY_JWK_B64` in the Node secrets, for the API (describing a workflow, writing a redline, LB-06's injection screen) and the worker (LB-04's reviews, LB-06's agents, LB-07's test runs): both start only with it. LB-07's browser sandbox gets no key: it makes no model call |
| `web`: the site's server calling the gateway (the run-spans route) | An entry of `LB_SERVICE_KEYS` | Vercel: `NUXT_LB_GATEWAY_SERVICE_KEY` |
| `site`: the site signing its visitors' tokens | `LB_WEB_TOKEN_KEY` in the compose settings: the public key alone, which all three back ends verify visitor tokens against | Vercel: `NUXT_LB_WEB_SIGNING_KEY` |

`LB_SERVICE_KEYS` is one JSON object holding every entry:
`{"django-systems":"<public key>","flask-systems":"<public key>","node-systems":"<public key>","web":"<public key>"}`.
The `site` pair is not a gateway service: only its public key is used, and by the Django,
Flask and Node systems alike, from the one value in the compose settings. To get the one-line
base64 of a key file without it ever reaching your terminal's scrollback, copy it
straight to the clipboard:

```sh
base64 -w0 ~/lb-keys/django-systems.jwk.json | xclip -selection clipboard      # Linux
base64 -i ~/lb-keys/django-systems.jwk.json | tr -d '\n' | pbcopy              # macOS
```

Keep the five private key files in your password manager and delete them from disk
once the secrets and Vercel have them. The gateway serves the run-spans route
(`GET /v1/runs/<id>/spans`) when the Scope arrives; Caddy already lets exactly that path
through, so the `web` key is ready for it.

## 7. Secrets

Every secret is a SOPS file in `infra/secrets`, encrypted with age. Read
[`infra/secrets/README.md`](../infra/secrets/README.md) once: it explains the templates,
which values are made for you, and what each key can do. The sequence:

```sh
just secrets-init              # makes your key in ~/.config/sops/age/keys.txt, lists its public half
```

**Back up `~/.config/sops/age/keys.txt` now**, in a password manager. It is the only way
to open the secrets, and it exists nowhere else.

Each `just secrets-new <name>` makes the random values itself (passwords, Django's key)
and opens your editor for the rest. The values are the ones from parts 5 and 6:

```sh
just secrets-new compose         # LB_API_HOST=api.example.com, LB_SITE_ORIGIN=https://example.com,
                                 #   LB_WEB_TOKEN_KEY (the site key's public half),
                                 #   LB_EGRESS_SYSTEMS_ALLOW=<account id>.r2.cloudflarestorage.com,
                                 #   LB_LB03_BUCKET=lb-uploads,
                                 #   LB_R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
just secrets-new postgres        # nothing to type
just secrets-new postgres-roles  # nothing to type
just secrets-new redis           # nothing to type
just secrets-new gateway         # LB_SERVICE_KEYS, GROQ_API_KEY, CLOUDFLARE_ACCOUNT_ID,
                                 #   CLOUDFLARE_API_TOKEN, OPENROUTER_API_KEY
just secrets-new django-systems  # LB_SERVICE_KEY_JWK_B64 (the django-systems file, in base64)
just secrets-new flask-systems   # LB_SERVICE_KEY_JWK_B64 (the flask-systems file, in base64),
                                 #   LB03_S3_ACCESS_KEY_ID and LB03_S3_SECRET_ACCESS_KEY (the
                                 #   lb-uploads token from part 5)
just secrets-new node-systems    # LB_SERVICE_KEY_JWK_B64 (the node-systems file, in base64)
just secrets-new lb07-sandbox    # nothing to type: LB-07's shop key, 64 random hex digits
just secrets-new cloudflared     # TUNNEL_TOKEN
just secrets-new backup          # see below
```

`LB_EGRESS_SYSTEMS_ALLOW` lists the hosts the Django systems, the Flask API (LB-03's files go
to R2) and the backup may reach, comma separated; add Sentry's ingest host
(`.ingest.sentry.io`) when a system sends errors there.

`LB_LB03_REQUIRE_LANDLOCK` is optional in `compose`, and starts off. LB-03's OCR worker puts a
cage round itself before it reads a visitor's file, and Landlock is one wall of it that the
kernel and the container must allow. Where it is missing the worker still reads, with one wall
less, and says so. After the first deploy (part 11) check that the box has it, and then make
the service insist: `just secrets-edit compose`, add `LB_LB03_REQUIRE_LANDLOCK=true`, deploy.
From then on a box that loses Landlock reads nothing, which is the better failure.

`lb07-sandbox` holds one value, `LB07_SHOP_TOKEN_KEY`: the key LB-07's bug tokens are signed
with. The Node worker signs a token for each test run and the staging shop, inside the browser's
container, verifies it, so Compose hands that one value to `node-worker` and to `lb07-sandbox`,
and nothing else from the file reaches either: it is the sandbox's only secret. A box that was
set up before LB-07 needs this file before its next deploy (the deploy refuses a release with a
template that has no encrypted file), and `postgres-roles` needs its new line,
`LB_PG_PASSWORD_LB07`: `just secrets-edit postgres-roles` and paste a `just secret-token`.

The site's public key, `LB_WEB_TOKEN_KEY`, used to be a line of `django-systems`. It is one
value in `compose` now, so that the three back ends cannot hold different ones; an older
`django-systems` file that still has it fails `just secrets-check` with "LB_WEB_TOKEN_KEY is
not a variable of the template": move the line to `just secrets-edit compose`.

**The backup's own key.** Backups are encrypted to a key that is not on the box, so a
stolen box cannot read its own backups:

```sh
age-keygen -o ~/lb-backup.key       # prints the public key; keep the file in your password manager
```

In `backup`: `LB_BACKUP_AGE_RECIPIENTS` is that public key, `LB_BACKUP_DESTINATION` is
`r2:lb-backups/postgres`, and `RCLONE_CONFIG_R2_ENDPOINT`, `RCLONE_CONFIG_R2_ACCESS_KEY_ID` and
`RCLONE_CONFIG_R2_SECRET_ACCESS_KEY` are the R2 values from part 5.

**Let the box in**, with the public key from part 4, and check everything:

```sh
just secrets-add-recipient box age1...        # the box's public key
just secrets-check                            # eleven lines of "ok"
```

Commit the encrypted files and `.sops.yaml` through a pull request, as for any change:
they hold no plaintext, and the box's key is the second recipient.

## 8. GitHub

**The Tailscale OAuth client.** Tailscale admin, Settings, OAuth clients, Generate: scope
`auth_keys` with write access, and the tag `tag:ci`. Keep the client ID and the secret.

**Environment and secrets.** Repository Settings, Environments, New environment:
`production`. Optionally add yourself as a required reviewer: every deploy then waits for
your approval before it touches the box. In that environment, add the two secrets:

| Name | Kind | Value |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | environment secret | The Tailscale OAuth client ID |
| `TS_OAUTH_SECRET` | environment secret | The Tailscale OAuth client secret |

And one variable, in Settings, Secrets and variables, Actions, Variables:

| Name | Kind | Value |
|---|---|---|
| `LB_BOX_HOST` | repository variable | `lb-box`, the box's name on the tailnet |

That is everything the workflows need. There is no cosign key (signing is keyless), no
registry password (GHCR uses the job's own token), no SSH key and no age key.

**Actions permissions.** Settings, Actions, General: allow GitHub Actions to run, and
leave the default `GITHUB_TOKEN` permission at read-only; every workflow here asks for
what it needs.

**Branch protection.** Protect `main`: require a pull request and the CI checks. The
deploy runs after CI passes on `main`, so this is what stands between an unreviewed
change and the box.

## 9. The first deploy

1. Merge the infrastructure change to `main`. CI runs; when it passes, **Deploy** starts
   by itself.
2. The `images` job builds the seven images for amd64 and arm64 under QEMU (the first time
   it takes a while, since nothing is cached), pushes them to GHCR, scans them, signs
   them, and checks its own signature.
3. **The first run stops at the box's pull.** GHCR creates each package private. Make the
   seven packages public (GitHub, your profile, Packages, each `lb-*` package, Package
   settings, Change visibility): the images hold the code of this public repository and
   its synthetic data, and no secret. Then, in the failed Deploy run, choose **Re-run
   failed jobs**. (If you would rather keep them private, log the `deploy` user in once
   with a read-only token: `echo <token> | sudo -u deploy docker login ghcr.io -u <you>
   --password-stdin`; the token then lives in that user's `~/.docker/config.json`.)
4. The `deploy` job sends the commit's `infra/` folder to `/opt/lb/releases/<commit>` and
   runs `deploy.sh`. It decrypts the secrets, pulls, checks the signatures, starts
   everything, waits for every health check, runs the smoke test (through the public
   hostname too), and marks the release current. The first one takes several minutes:
   Postgres initialises, then the deploy's jobs run in three waves (part 2, The memory
   budget): the roles and schemas are provisioned; the Django, Flask and Node systems'
   tables are migrated (the Django systems' data seeded with them); then the Node systems'
   data is seeded and LB-05's warehouse (about two million orders) is generated into its
   volume, which takes some tens of seconds. Later deploys find the warehouse there and
   skip it.
5. **Install the units**, once, from the release that is now live:

   ```sh
   sudo install -m 0644 /opt/lb/current/infra/systemd/lb-secrets.service /opt/lb/current/infra/systemd/lb-backup.service /opt/lb/current/infra/systemd/lb-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable lb-secrets.service
   sudo systemctl enable --now lb-backup.timer
   ```

   `lb-secrets` decrypts the secrets again after a reboot, when `/run` is empty; the timer
   starts the nightly backup. Repeat this step whenever a release changes
   `infra/systemd`.
6. Test the backup now rather than at 02:30:

   ```sh
   sudo systemctl start lb-backup.service
   journalctl -u lb-backup.service -n 20 --no-pager      # "backup: uploaded lb-postgres-....dump.age"
   ```

   Check that the file is in the R2 bucket.
7. Work through the checklist in part 11.

## 10. Vercel

Create a project from this repository, then:

| Setting | Value |
|---|---|
| Framework Preset | Nuxt |
| Root Directory | `apps/web` (leave "Include source files outside of the Root Directory" on: the site uses the workspace packages `@lb/ui` and `@lb/icons`) |
| Node.js Version | 24.x |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | the default (`nuxt build`) |
| Function region | The Vercel region nearest the box (`fra1` for Oracle's Frankfurt region; Settings, Functions). The site's server calls the API for every demo, so this keeps those calls short |
| Domains | `example.com`, and `www.example.com` set to redirect to it with a `308` (in the domain's settings), with the DNS records Vercel shows (kept DNS-only in Cloudflare). `example.com` is the site's one address: Vercel sends `www` on to it, and the site sends any other host (below) |
| Deployment Protection | Vercel Authentication on everything except the custom domains (Standard Protection): the project's `*.vercel.app` addresses then ask for a Vercel login, so the public reaches the site only at `example.com` |

Environment variables, for **Production** (Preview deployments need no API access, and
the API refuses their origin on purpose: it answers cross-origin calls from
`LB_SITE_ORIGIN` only):

| Name | Value |
|---|---|
| `NUXT_LB_API_URL` | `https://api.example.com`: where the Django, Flask and Node systems answer |
| `NUXT_LB_GATEWAY_URL` | `https://api.example.com`: the same host; Caddy lets through the one gateway route |
| `NUXT_LB_WEB_SIGNING_KEY` | The private key of the `site` pair (the contents of `site.jwk.json`): signs visitor tokens |
| `NUXT_LB_GATEWAY_SERVICE_KEY` | The private key of the `web` pair (the contents of `web.jwk.json`) |
| `NUXT_LB_SESSION_SECRET` | A random secret for the visitors' anonymous sessions: `just secret-token 32` |
| `NUXT_TURNSTILE_SECRET_KEY` | Turnstile's secret key |
| `NUXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile's site key (public) |
| `NUXT_LB_SITE_ORIGIN` | `https://example.com`: the site's one address. Any other host that reaches the site (`www.example.com`, the project's `*.vercel.app` addresses) is sent on to it with a permanent redirect |
| `NUXT_PUBLIC_I18N_BASE_URL` | `https://example.com` too: the language links (`hreflang`) must be absolute |

Mark everything except `NUXT_LB_API_URL`, `NUXT_LB_GATEWAY_URL` and
`NUXT_PUBLIC_TURNSTILE_SITE_KEY` as Sensitive. The site reads exactly these names
(`apps/web/nuxt.config.ts`; `apps/web/.env.example` lists them with a line each) and checks
them when it starts: with none set it serves the catalog and the datasheets and answers every
demo with "not connected", as a preview does; with some set it refuses to start unless every
one is right, and the log names the variable that is wrong and never its value. Turnstile's
widget mode stays Managed: the site draws it with `appearance: interaction-only`, so a visitor
sees it only when Cloudflare needs them to do something.

Why `NUXT_LB_SITE_ORIGIN` matters: a visitor's session is a cookie that belongs to one host, and the
quotas follow the session, so `www.example.com` and the `*.vercel.app` addresses of the production
deployment would each be a separate site with a separate quota for the same person. With the variable
set, the site answers a request for any other host with `308` and the same path and query on
`https://example.com`, before it reads a cookie, calls a back end or renders a page; the redirect is
never cached, so a wrong value is cured by changing it. Leave it unset only on a deployment that has
no API access (a preview), which then answers on any host. The host is the one Vercel reports in
`X-Forwarded-Host`, which Vercel sets itself.

Never set `LB_TEST_BUILD` in Vercel. It makes the end-to-end test build, which accepts a fixed
stand-in for a Turnstile token and shows recordings made on the mock, and CI's check of the
production bundle cannot see a build made on Vercel. So the build refuses it: where `VERCEL` is
set (Vercel sets it), `LB_TEST_BUILD=1` stops `nuxt build` with an error that names the variable,
and a server built that way refuses to start. If a deployment fails with that error, remove the
variable from the project's environment (Settings, Environment Variables) and deploy again.

The site's server calls LB-05, LB-08 and LB-04 and waits up to 95 seconds for them
(`apps/web/server/lib/policy.ts`), so the Vercel plan must let a function run that long. Check
the plan's maximum function duration (it is a Vercel setting, not something the repository
sets), and read part 12 before relying on it.

## 11. Verification checklist

From a machine **outside** the tailnet:

- [ ] `ssh -o ConnectTimeout=8 ubuntu@<public ip>` times out. No port answers:
      `nmap -Pn -p- <public ip>` shows every port filtered.
- [ ] `curl -si https://api.example.com/` is a JSON `404`, with `strict-transport-security`
      in the headers and no `server: Caddy` or `x-powered-by` (Cloudflare adds its own
      `server: cloudflare`).
- [ ] `curl -si https://api.example.com/api/lb01/customers` is `401`: LB-01's API is
      reached, and asks for a visitor token. So are `/api/lb02/offerings` (LB-02),
      `/api/lb03/quota` (LB-03), `/api/lb05/quota` (LB-05), `/api/lb08/limits` (LB-08), `/api/lb04/limits` (LB-04), `/api/lb06/limits` (LB-06) and `/api/lb07/limits` (LB-07).
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/api/healthz` is `404`,
      and so are `/api/openapi.json` and `/v1/models`: only the routes in the Caddyfile
      exist.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' https://api.example.com/ws/lb02/x`
      is `403`: a WebSocket from another origin is refused.
- [ ] In Cloudflare, Security, WAF, Rate limiting rules: the only per-IP rule for
      `api.example.com` is the one for the `/ws/` path. None covers the whole hostname (the
      site relays everything else from Vercel's addresses, shared by every visitor).
- [ ] `https://example.com` loads, in both languages, in both themes.
- [ ] `curl -sI https://www.example.com/systems/lb-01?x=1` is `308` with `location:
      https://example.com/systems/lb-01?x=1` and no `set-cookie` (Vercel's domain redirect).
      The same request to the project's `https://<project>.vercel.app` address is `401` from
      Vercel Authentication; with that protection off, it is the site's own `308` to the same
      place, with no `set-cookie` and `cache-control: no-store`. And
      `curl -si https://example.com/api` is the JSON `404` the API's other unknown paths give,
      not a `503`.
- [ ] `curl -si https://example.com/api/session` carries one `set-cookie`, `__Host-lb_session`
      with `HttpOnly`, `Secure` and `SameSite=Strict`, and no `access-control-allow-origin`;
      `curl -si https://example.com/systems/lb-01` carries none.
- [ ] `curl -si -X POST -H 'content-type: application/json' -d '{}' https://example.com/api/lb01/tickets`
      is `403` `forbidden_origin`: a change that does not say it comes from the site is refused.
- [ ] `https://example.com/systems/lb-01/board` opens with the console clean (no policy
      violation, no error), the samples list says which have a recording, and a recorded
      sample replays under a "Replay" badge with nothing sent to the API.
- [ ] A live run from your own text: the check passes (Turnstile's widget loads under the
      page's policy, which only the board pages relax), the ticket is worked through the nine
      steps, the cited draft appears, the Scope fills in, and `https://example.com/runs/<id>`
      shows the same trace in a private window.

On the box (`tailscale ssh deploy@lb-box`; `compose` below is
`/opt/lb/current/infra/scripts/compose.sh`):

- [ ] `compose ps` lists every service `healthy`, and the one-shot jobs
      (`postgres-provision`, `django-migrate`, `flask-migrate`, `flask-seed`,
      `node-migrate`, `node-seed`) exited `0`.
- [ ] LB-05's data is in place and cannot be written by its API: `compose exec flask-api
      ls -l /warehouse/lb05` shows `lb05.duckdb` and `meta.json`, and `compose exec
      flask-api touch /warehouse/lb05/x` fails with "Read-only file system".
- [ ] LB-03's cage and its bucket, with the board's own upload of a sample file of your own
      (Turnstile passed, a file of under 4 MB): the document reaches `ready`; in its trace
      (`/runs/<id>`) the `read pages` span says `seccomp` true and `landlock_abi` above 0 (then
      set `LB_LB03_REQUIRE_LANDLOCK=true`, part 7); the file was in the bucket while it was read
      (R2, `lb-uploads`, `docs/<id>/original.<ext>` and `page-1.jpg`) and is gone a minute after
      its hour, and `compose exec flask-api python manage.py sweep_lb03` says it found nothing
      to delete. The bucket is private: a request for a file with no signature, `curl -s -o
      /dev/null -w '%{http_code}\n' https://<account id>.r2.cloudflarestorage.com/lb-uploads/docs/x`,
      must not answer `200` (expect `403`; if it ever does, public access is on and must be turned off).
      Then try a file of 9 MB through the site: the board refuses it before sending anything, at 4 MB.
- [ ] `/opt/lb/current/infra/scripts/smoke.sh --public` ends with "All checks passed.": the
      routes through Caddy, no way out except through the proxies, LB-07's browser sandbox
      reaching nothing but its own shop, an empty Redis ACL log, and the public hostname.
- [ ] LB-07's browser sandbox on the box's own kernel and cores: `compose exec lb07-sandbox
      /nodejs/bin/node -e "console.log(require('node:fs').readFileSync('/proc/self/status','utf8').match(/^(CapEff|NoNewPrivs|Seccomp):.*$/gm).join(' | '))"`
      prints `CapEff: 0000000000000000 | NoNewPrivs: 1 | Seccomp: 2`; then a sample run on
      `https://example.com/systems/lb-07/board` ends with its report, and `compose logs
      lb07-sandbox` shows no browser crash. Its memory under a real run is in `docker stats
      --no-stream` (384 MiB is its limit; it was measured at about 270 MiB on x86).
- [ ] `findmnt -T /run/lb/secrets` shows `tmpfs`, and `ls -l /run/lb/secrets` shows every
      file `-rw-------` and owned by `deploy`.
- [ ] `cat /opt/lb/deploys.log` has one line for the release, and `readlink /opt/lb/current`
      is `releases/<commit>`.
- [ ] A container cannot reach the internet directly: `compose exec gateway /nodejs/bin/node -e
      "require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>{console.log('CONNECTED');process.exit()}).on('error',e=>{console.log('error',e.code);process.exit()})"`
      prints `error ENETUNREACH`, never `CONNECTED`. (`smoke.sh` checks this too.)
- [ ] `systemctl list-timers lb-backup.timer` shows the next run, and the test backup from
      part 9 is in the bucket.
- [ ] The installed backup unit takes the deploy's lock: `systemctl cat lb-backup.service`
      shows `ExecStart=/usr/bin/flock --verbose --wait 1200 /opt/lb/deploy.lock ...`, and
      `journalctl -u lb-backup.service` has `flock: getting lock took ...` for the test backup.
- [ ] A backup restores (part 13, Backups) into a scratch database, with the row counts
      you expect.
- [ ] `cosign verify --certificate-identity-regexp '^https://github\.com/<owner>/<repo>/\.github/workflows/(images|deploy)\.yml@refs/heads/main$' --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/<owner>/lb-gateway:<commit>`
      succeeds (the owner in lowercase in the image name).

In GitHub: the Deploy run is green, and the seven packages show the commit's tag.

## 12. What is not verified

Run and tested in this repository: the six images build and run hardened (non-root,
read-only filesystem, no capabilities, limits); the Compose stack comes up through Caddy
with real visitor tokens, the real database roles and the egress proxies, and LB-01, LB-02
(its calls and a WebSocket conversation through the Redis channel layer), LB-05 (from the
read-only warehouse) and LB-08 (a workflow run through BullMQ to its worker) answer
through it; every Compose service passes the security rules and the memory budget, a deploy's
jobs wait for each other in waves that never overlap, and every one-shot job is in a group the
budget counts (`infra/scripts/check-compose.sh`, which also has tests that show each rule can
fail); the Postgres roles cannot reach each other's schemas, for every pair of the systems
(`infra/postgres/test-roles.sh`); the Redis ACL passes the gateway's, lb-common's, LB-02's
consumer, the Flask systems' integration (LB-03's and LB-05's) and the Node systems' unit and
integration suites (LB-08's, LB-04's, LB-06's and LB-07's) and a Celery worker's, with an empty ACL log
(`infra/redis/test-acl.sh`); Caddy's routes, headers, streaming, timeouts, the upload limits
of LB-03 and LB-04, a quiet WebSocket (LB-02's and LB-06's) and bypass attempts (`infra/caddy/test.sh`); a backup is encrypted,
restores into a scratch database and over the live one, and a wrong key cannot open it; the
secrets tooling with the real `sops` and `age` (`infra/scripts/test-secrets.sh`); the deploy
script's order, signature check, rollback and clean-up, and the lock it shares with the backup
unit's own command (a deploy is refused while the backup runs, and the backup waits for a deploy
and gives up in its time), with stand-ins for Docker and cosign
(`infra/scripts/test-deploy.sh`); image pinning against the real registries; `docker compose
config`, hadolint, shellcheck and actionlint. LB-07's browser sandbox image was built (amd64)
and started by Compose from the real file, with every flag of the policy: Chromium ran golden
plans called from a second container on the sandbox network, the container reached no public
address or name, no other container and not the host, five runs of the heaviest plan stayed
inside its memory limit, and after its share of runs it exited and Docker started a fresh one,
the run in flight having finished (`infra/sandbox/test.sh`, which CI runs too).

**Not verified, because it needs the real thing:**

- Building and running on **arm64**: the box's architecture. The images are built for
  both, but only amd64 was built and run in development, since the machine here has no
  QEMU. The first arm64 build runs in CI. The two new images carry native wheels (DuckDB,
  numpy, cryptography, psycopg) and BullMQ's optional speed-up: all publish arm64 builds,
  but nobody has run them on one.
- LB-04 in the **Compose stack and in its image**: its module, queue, extraction thread and
  worker run as real processes against the real gateway on a fake provider, through the
  Redis ACL, the Postgres roles and Caddy's routes, but the Node image could not be built
  where this was written (the base images were out of reach). It has been built since (amd64,
  with LB-07's data in it), and its migration and seed jobs ran in it against a Postgres, read-only
  and with no capability; but nothing proves that the
  image's production install runs LB-04's extraction thread under the
  distroless Node, or that the worker holds in the 768 MiB it is given (two extractions of
  a 30-page contract at once measured 291 MiB on a development machine, with the process's
  own working set about 400 MiB).
- **LB-07's browser sandbox on arm64 and on the box**: the image's arm64 build (a different
  Chrome Headless Shell zip, pinned by its own SHA-256, and Debian's arm64 libraries) is made
  by CI under QEMU and has never been run; its memory was measured on x86 only; and the
  sandbox network's bridge with no address on the host (`inhibit_ipv4`) was proved on Docker
  29 here, not on the box's Docker. The whole of LB-07 (the API, the worker and the sandbox
  together, with a model) has not run in the Compose stack: the worker's side was stood in for
  by a client that calls the runner as the worker does.
- On **Oracle Cloud**, parts 2 and 3 have been run on the box, in Frankfurt: the first
  availability domain was out of Ampere capacity and the second was not, the boot volume was
  grown to 100 GB, Tailscale joined with its tag, and port 22 was closed in the host's
  firewall (which is how step 5 came to describe Oracle's own rules rather than `ufw`). Not
  yet: the security list's ingress rules removed, the reclaim rule, and the 2 OCPU and 12 GB
  sizing under real load. The memory
  limits of what runs all the time add up to 8576 MiB, and to 10112 at the peak with a
  deploy's biggest wave of jobs (the sums are at the top of `infra/docker-compose.yml`, and
  the table is in part 2); idle, the stack used about 0.7 GiB here (without `cloudflared`
  and the proxies), LB-05's data job peaked at 923 MB, and the service's warehouse code at
  452 MB while it answered the 100 reference questions on the full dataset, and LB-03's OCR
  worker at 692 to 837 MiB (a three-page PDF, five pages, the biggest image it accepts), on a
  four-core x86 machine; nothing was measured under visitor traffic or on the box's cores. LB-05's
  questions, LB-08's descriptions and LB-03's documents need a model, so their answers through
  the stack were not tried; everything that does not call one was.
- **LB-03 on the box**: the OCR on **arm64** and two cores (its seconds a document were
  measured on four x86 cores: `services/flask-systems/README.md`); **Landlock** in the container
  on the box's kernel (the worker says whether it has it, and the first check on the box
  is in part 11); the S3 client against **R2 itself** (it was run against moto's fake S3 and a
  local folder); and the Flask image's new native wheels (ONNX Runtime, OpenCV, pdfium) on
  arm64: all publish arm64 builds, and nobody has run them there.
- **Cloudflare**: the tunnel actually carrying traffic (`cloudflared` was not started),
  the DNS records, the WAF and rate-limit rule, Turnstile, R2 (the upload was tested
  against a local folder). That Bot Fight Mode would challenge the site's calls from Vercel
  (part 5) comes from what it judges and what the free plan lets a rule exempt; it was not
  observed, and the guide keeps it off either way.
- **Tailscale**: the OAuth client, the tags and policy, `tailscale ssh` from a runner,
  the `ping` wait before it.
- **The deploy's waves and the backup's lock on the box**: the waves were checked in the
  resolved Compose file, not timed in a real deploy, so how much longer a deploy takes now
  that it seeds after the migrations is not measured; and the backup unit's command was run
  beside `deploy.sh` with stand-ins, not by systemd with the unit's own sandboxing.
- **GitHub**: the workflows have been linted (actionlint) but never run. That includes
  pushing to GHCR, the Trivy scan, cosign's keyless signing, and above all the
  **certificate identity**: `deploy.sh` and `images.yml` both expect the signer to be
  `.github/workflows/images.yml` or `deploy.yml` of this repository on `main`. The image
  workflow checks its own signature with the same pattern, so if GitHub's certificate
  names something else, the first `images` job fails right after signing, with the
  identity in the error, and nothing is deployed.
- **Vercel**, and the site's side of the keys. The site's server (session, Turnstile check,
  proxy, trace route) and LB-01's board are run and tested here against the mock back end, in
  a real browser with the production policy. The board was also run, in a real browser,
  against the **real Django API, the real gateway's trace route and the real tracer's spans**,
  with the Django tests' fake models standing in for the models (that run found that Django
  names a ticket's run only when its pipeline has finished, which the board now handles). The
  production build was run with the **real Turnstile widget** and Cloudflare's published
  always-pass test keys: the loader, the frame, the token and the server's check with
  Cloudflare worked under the policy. The build Vercel makes (`VERCEL=1 pnpm --filter @lb/web
  build`, which uses Nitro's Vercel preset and writes `apps/web/.vercel/output`) was run once
  here, by hand: it stopped with `EEXIST` because two routes of the API made the same function,
  which is fixed, and `test/unit/api-routes.test.ts` now checks the route list for it; no CI step
  makes that build. They were never deployed and never run with a real Turnstile site key,
  challenge and hostname. The **recordings** the boards replay were made on 2026-10-07 against
  the platform running locally on a development machine, with the real providers behind the
  gateway (`apps/web/recordings/README.md` lists them and the samples still without one). Not
  checked either: whether the Vercel plan lets a function wait the 95 seconds the proxy allows
  LB-05, LB-08 and LB-04.
- Real provider traffic from the box: none. Groq, Workers AI and OpenRouter have only been called
  from a development machine's local stack, through the gateway (the recordings, LB-01's recorded
  vectors and the measurements the services' READMEs date).
- LB-09's image with the Whisper weights: the build fetches them from Hugging Face
  (`infra/docker/django-systems.Dockerfile`, with `faster_whisper.utils.download_model`). The
  same call was run in the development session, which reached Hugging Face through its proxy, and
  private mode then transcribed the six committed recordings with those weights (word error rate
  0.106, measured on an x86-64 development machine: `services/django-systems/README.md`); no image
  with them was built there; GitHub's image job built it (the `django-systems` image of the CI run on 1852093 passed, weights step included). Nothing was measured on the box's
  Ampere A1. Fast mode transcribed the three sample meetings through the gateway (Groq's
  whisper-large-v3-turbo) when their recordings were made; its word error rate is not measured
  yet (`just wer-lb09 --mode fast`). The shared `lb09-audio` volume and the 5 MB upload route
  through Caddy are checked by the Compose rules and `infra/caddy/test.sh`, not by a deployed
  stack.

## 13. Day to day

### Deploying

Merge to `main`. When CI passes, **Deploy** runs by itself: build, push, scan and sign,
send the commit's `infra/` folder to the box, run `deploy.sh`. A deploy that you want to
approve first waits at the `production` environment. To deploy the same commit again,
re-run the Deploy workflow from the Actions page.

`deploy.sh`'s exit status tells you what happened: **0** the release is live; **1** it was
refused or did not come up, and the previous release is running again (or was never
touched); **2** the rollback failed too and the box needs you. The log of the last
deploys is `/opt/lb/deploys.log`; the full output is in the Actions run.

A deploy and the nightly backup take turns: both hold `/opt/lb/deploy.lock` while they work,
so the backup never runs beside a deploy's jobs (part 2, The memory budget). A deploy that
starts while the backup runs, from 02:30 UTC for a few minutes, is refused before it changes
anything, with `deploy: another deploy or the nightly backup is running on this box (it holds
/opt/lb/deploy.lock); try again in a few minutes.`: re-run the Deploy workflow a little later.
The backup, the other way round, waits for a deploy that is running. Inside a deploy, Compose
runs the jobs in three waves, each after the one before has finished: the provision, then the
three migrations, then the two seeds.

Every release runs from a folder of its own, so a deploy recreates the three containers
that bind-mount files from it (Postgres, Redis, Caddy): expect a few seconds of errors
from the API, which the services' reconnect logic absorbs. Changed secrets recreate the
containers that read them.

### Rolling back

It is automatic: if the new release does not become healthy or fails the smoke test, the
script starts the previous release from its own folder, with its own secrets and the
images already on the box, and fails the workflow. To go back by hand, from the box:

```sh
ls -t /opt/lb/releases                                       # newest first
/opt/lb/releases/<previous commit>/infra/scripts/deploy.sh <previous commit>
```

It verifies the release again, so it works the same way. The box keeps the newest three
releases, and the live one and the one before it whatever their age.

**A rollback does not undo database migrations.** Write every migration so that the
previous release's code still works with it (add a column before code uses it, stop using
a column before dropping it). A migration that cannot work that way needs a backup
restore, not a rollback.

Going back to a release from before a service existed removes that service (`up
--remove-orphans`), and keeps its data: the Flask warehouse volume stays on the box. LB-05's
data job also runs when a release is rolled back, and regenerates the warehouse if the
volume holds one that release's API would not accept (a newer generator version, say), so a
rollback does not strand LB-05 on data it cannot read.

### Logs and a shell on the box

```sh
tailscale ssh deploy@lb-box
alias compose=/opt/lb/current/infra/scripts/compose.sh
compose ps
compose logs --since 30m gateway django-api flask-api node-api node-worker caddy
compose exec -u postgres postgres psql -d lb
compose exec redis sh -c 'REDISCLI_AUTH="$LB_REDIS_PASSWORD_ADMIN" redis-cli --user admin --no-auth-warning acl log'
```

`compose` always means the live release: the script reads the release's name from the
`RELEASE` file in its own folder.

**LB-05's data.** The warehouse (Parquet and a DuckDB file, about 80 MB) is generated, not
backed up: it lives in the `lb05-warehouse` volume, which only `flask-seed` can write. To
make it again with today as its last day, for example after the months have made "last
quarter" look old, make it on purpose and restart the API. The job runs under the deploy's
lock, so that it never runs beside a deploy's jobs or the backup (`-n`: it is refused at once
if one is running), and with `--no-deps`, because in a deploy it waits for the three
migrations, which `run` would otherwise run first. `flock` starts a program, not the alias, so
the script is named in full:

```sh
flock -n /opt/lb/deploy.lock /opt/lb/current/infra/scripts/compose.sh run --rm --no-deps flask-seed python seed_warehouse.py --force
compose up -d --force-recreate flask-api
```

### Backups

A systemd timer runs the `backup` job at 02:30 UTC: `pg_dump` is piped straight into
`age`, so the dump never exists unencrypted, and only the encrypted file is uploaded to
`r2:lb-backups/postgres`. A failed dump uploads nothing. The job runs under the deploy's
lock (`flock` on `/opt/lb/deploy.lock`, in `infra/systemd/lb-backup.service`): if a deploy
is running, it waits for it, 20 minutes at most, and then fails without a dump and tries
again the next night; the journal says how long it waited. The dump leaves out the rows of
the tables that hold what visitors upload (`infra/backup/excluded-data.txt`: LB-04's
contracts, their files, their text, their reports and their redlines; LB-06's incidents, their
logs and the scenario cache; LB-07's test runs, their steps, findings, evidence and reports),
because a visitor's file or test run is kept for an hour, an incident for a day, and a backup
for weeks. A restore makes those tables empty, which
is what they are an hour after any restore. `infra/postgres/test-roles.sh` proves it: no
word of a contract or of a test run's goal is in the dump. Look at the last run:

```sh
journalctl -u lb-backup.service -n 30 --no-pager
```

**Restoring** needs the backup key (`~/lb-backup.key`) that is not on the box. Download
the file from R2, then check it opens and what is in it, in a scratch database, from your
machine:

```sh
age -d -i ~/lb-backup.key lb-postgres-<date>.dump.age \
  | tailscale ssh deploy@lb-box 'docker exec -i -u postgres lb-postgres-1 sh -c "createdb lb_restore_test && pg_restore --exit-on-error -d lb_restore_test"'
tailscale ssh deploy@lb-box 'docker exec -u postgres lb-postgres-1 psql -d lb_restore_test -c "\dt lb01.*"'
tailscale ssh deploy@lb-box 'docker exec -u postgres lb-postgres-1 dropdb lb_restore_test'
```

To **replace the live data** with a backup (a bad migration, a lost volume), stop what uses
the database, restore over it as the superuser, and start again. The plaintext dump only
travels inside the encrypted SSH connection:

```sh
tailscale ssh deploy@lb-box '/opt/lb/current/infra/scripts/compose.sh stop django-api django-worker gateway'
age -d -i ~/lb-backup.key lb-postgres-<date>.dump.age \
  | tailscale ssh deploy@lb-box 'docker exec -i -u postgres lb-postgres-1 pg_restore --clean --if-exists --exit-on-error -d lb'
tailscale ssh deploy@lb-box '/opt/lb/current/infra/scripts/compose.sh up -d --wait'
```

### Rotating a key

Rotating means: make the new value, put it where it is used, deploy, and only then revoke
the old one. Edit secrets with `just secrets-edit <name>`, merge, and the deploy
recreates every container whose settings changed.

| Secret | Make the new one | Where it goes | Then |
|---|---|---|---|
| A provider key (Groq, Workers AI, OpenRouter) | In the provider's console | `just secrets-edit gateway` | Revoke the old key |
| A Postgres role's password | `just secret-token` | `just secrets-edit postgres-roles`: the provision job applies it on the deploy, and the services that use it restart | |
| A Redis user's password | `just secret-token` | `just secrets-edit redis`: Redis restarts, and so do the services | |
| A service key pair (`django-systems`, `flask-systems`, `node-systems`, `web`) | `just gateway-token keygen <name> <new file>` | The public entry in `LB_SERVICE_KEYS` (`just secrets-edit gateway`), the private half where part 6 says | Delete the old file. The gateway and the service restart in the same deploy; calls fail for the seconds between |
| The site's pair (`site`) | `just gateway-token keygen site <new file>` | `LB_WEB_TOKEN_KEY` (`just secrets-edit compose`) and `NUXT_LB_WEB_SIGNING_KEY` in Vercel, together | Visitor tokens live five minutes |
| Django's secret key | `just secret-token 32` | `just secrets-edit django-systems` | |
| LB-07's shop key | `just secret-token 32` | `just secrets-edit lb07-sandbox`: the worker and the sandbox restart with it | A test run in flight fails its bug token and is run again |
| The tunnel token | Cloudflare, the tunnel, refresh the token | `just secrets-edit cloudflared` | |
| The R2 token | Cloudflare, R2, a new API token | `just secrets-edit backup` | Delete the old token |
| The backup key | `age-keygen -o ~/lb-backup-2.key` | Add its public key to `LB_BACKUP_AGE_RECIPIENTS` (comma separated) | Keep the old private key for old dumps |
| The Tailscale OAuth client | Tailscale admin | The two environment secrets in GitHub | Delete the old client |
| Turnstile, the session secret | Cloudflare, `just secret-token 32` | Vercel's environment variables | |
| **Your age key** | `just secrets-init` on a machine without a key, or `age-keygen` | `just secrets-add-recipient owner2 <public key>`, then delete the old line from `.sops.yaml` and `just secrets-rekey` | **Rotate every other secret too**: the old key could open every old copy in git's history |
| **The box's age key** | `sudo -u deploy age-keygen -o /etc/lb/age.key.new` on the box | `just secrets-add-recipient box2 <public key>`, deploy, move the new key into place, then remove the old line and `just secrets-rekey` | Rotate every secret if the old key was exposed |

If the box itself is compromised, treat every secret as spent: rotate all of them, rebuild
the box (below), and check Cloudflare's security events.

### Adding a service

Adding a system is one small block in each of a few files. The Flask systems (LB-05) and
the Node systems (LB-08) are the examples to copy: `flask-api` for a web service with data
of its own, `node-api` and `node-worker` for a service with a queue. A new system on a
runtime that is already there (LB-03 and LB-05 on Flask, LB-08 on Node) is a module of that
service and needs only steps 3 to 6, and 7 and 8 when it has secrets or calls out (LB-03's
R2 token and its egress); a new runtime needs all of them. The order that works:

1. **Image.** A Dockerfile in `infra/docker/<name>.Dockerfile` with its own
   `<name>.Dockerfile.dockerignore`, in the shape of `flask-systems.Dockerfile` (Python) or
   `node-systems.Dockerfile` (Node): pinned base by digest (`just pin-images`), a non-root
   user, and the key-file entrypoint if the service calls the gateway. Add one line to the
   matrix in `.github/workflows/images.yml`:
   `- { name: <name>, dockerfile: infra/docker/<name>.Dockerfile }`. The image is then
   `ghcr.io/<owner>/lb-<name>`, pull requests build it for amd64 and arm64, and the deploy
   signs it and checks the signature on the box (it reads the image list from Compose).
2. **Compose blocks.** In `infra/docker-compose.yml`, one block for the service and one for
   each job it needs before it starts (a migration, a seed; `restart: "no"`, which is also
   how `smoke.sh` knows to expect them to have exited): `<<: *hardening` (or an anchor like
   `x-flask` and `x-node`), the image `${LB_REGISTRY:-ghcr.io/landry12-bas}/lb-<name>:${LB_TAG:?...}`,
   an `environment` that names only what that block needs, `env_file:
   ${LB_SECRETS_DIR:-/run/lb/secrets}/<name>.env` for the service that holds a secret and
   nobody else, the networks it needs (`app` for an API, `data` for Postgres and Redis,
   `egress-systems` only if it calls out, none for a job that needs no network), a health
   check, and memory, CPU and process limits. The memory budget at the top of the file is
   enforced: `just infra-check` fails when the new limits make the peak too big, and the
   fix is a decision about the box, not an edit of the budget (the table and the last such
   decision are in part 2). A new job waits, with `condition: service_completed_successfully`,
   for every job of the waves before its own (a seed for all three migrations), or the check
   names the job it could run beside; a job the host starts by itself goes behind a profile,
   runs under the deploy's lock as the backup does, and carries the
   `lb.runs-under-deploy-lock` label. Add the build blocks to
   `infra/docker-compose.dev.yml`, and give Caddy's `depends_on` the new API. The `sandbox`
   network is LB-07's browser and its worker's alone: the policy refuses any other member.
3. **Caddy.** In `infra/caddy/Caddyfile`, a system on an existing runtime adds its prefix
   to that runtime's matcher (`@flask path /api/lb05/* /api/lb03/*`); a new runtime gets a
   matcher and a line in the ordered `route`, before the final 404:
   `import proxy @<name> <service>:<port> <time to the first byte>`. The time is a minute
   for a service that answers quickly, and 95 seconds for one that waits for a model (under
   Cloudflare's 100). Add the routes to `infra/caddy/test.sh` (a stand-in service per
   upstream), and add the first-byte check if the time differs.
4. **Postgres.** Add the system's name (`lb03`) to `infra/postgres/systems.txt`, add
   `LB_PG_PASSWORD_LB03=@token` to `infra/secrets/postgres-roles.example.env`, run
   `just secrets-edit postgres-roles` and put a new `just secret-token` value there, and
   give the service its database URL in its Compose block, built from that password, and
   named `LB03_DATABASE_URL`. `infra/postgres/test-roles.sh` then proves the new role
   against every other.
5. **Redis.** Add the service's user to `infra/redis/users.acl.tmpl`, limited to the key
   prefixes and commands its code uses (record them with `MONITOR` while its own tests
   run against a dev Redis, as the existing users were, and keep the rules as tight as
   theirs), with its password variable in `redis.example.env` and in `start_redis` and the
   ownership table of `infra/redis/test-acl.sh`. Add the service's own integration tests to
   that script's second proof, so an ACL that is too tight fails a real test.
6. **Gateway key.** `just gateway-token keygen <service> <file>`: the public entry goes into
   `LB_SERVICE_KEYS`, the private half into the service's secrets, and the system is tied
   to the service in `services/gateway/routing.yaml`. A service that makes no model call
   needs none.
7. **Secrets.** `infra/secrets/<name>.example.env` lists the service's variables (only what
   is secret: the site's public key and the hostnames come from `compose`); then
   `just secrets-new <name>`. The deploy refuses a release whose template has no
   encrypted file, which is the reminder. `infra/scripts/dev-secrets.sh` makes the same
   files for a local stack and for the Compose checks, so teach it the new variables too.
8. **Egress.** If it calls an outside host, add the host to `LB_EGRESS_SYSTEMS_ALLOW`
   (`just secrets-edit compose`) and put the service on `egress-systems`.
9. Update the table of what runs where, if the service changes it, and run
   `just infra-check` and `just infra-test` before the pull request.

### LB-07's browser sandbox

LB-07 drives a headless Chromium over a staging shop, with a plan a model wrote. The browser
runs in `lb07-sandbox`, a container of its own (`infra/docker/lb07-sandbox.Dockerfile`): one Node
process with the shop on the container's loopback interface, the only place the browser may go,
and the runner's API on the `sandbox` network, which `node-worker` alone joins to call it. The
network is internal and its bridge has no address on the host, so the container reaches neither
the internet nor the box's own services; it holds one secret, the shop key (`lb07-sandbox`,
part 7), and no database or Redis login. Why it is one long-lived container and not one per run
is in `docs/SECURITY.md`, section 6.

**It restarts itself, on purpose.** Each browser session is one pass of a test run (a run opens
up to three: its plan, the plan behind Firefox's user agent, and the green pass with the bugs
off). After `LB07_RUNS_PER_LIFE` sessions (20, set in its Compose block) the runner refuses new
ones, waits for the last to close, and exits, and Docker's `unless-stopped` starts a fresh
process with a fresh browser in a second or two. A session in flight is never cut short by it. A
run whose next pass asks for a session during those seconds waits for the new process (ten tries,
two seconds apart) instead of failing. So `compose ps` shows
`lb07-sandbox` restarting now and then, and its log says why:

```sh
compose logs --since 1h lb07-sandbox | grep "served its share"     # one line for each fresh start
docker inspect -f '{{.RestartCount}}' "$(compose ps -q lb07-sandbox)"
```

A restart that is not one of those (an out-of-memory kill: `docker inspect -f
'{{.State.OOMKilled}}'`, or `dmesg | grep -i oom`) means a run needed more than its 384 MiB: see
part 2, The memory budget. To prove the container again after a change (Docker on any machine,
about five minutes): `just test-lb07-sandbox`.

### LB-09's audio and model

LB-09 (the Django systems) needs two things no other system does, both in the files above:

- **A place for recordings between the API and the worker.** `django-api` writes a visitor's
  recording to the `lb09-audio` volume, a tmpfs of 64 MiB mounted at `/var/lib/lb/audio` in
  `django-api` and `django-worker` only (`LB09_AUDIO_DIR`), and the worker deletes it once it is
  transcribed, on success and on failure. Nothing reaches the disk; a restart empties it, which
  only fails the meetings in flight (their rows say `stale` after the worker's sweep). Caddy lets
  the one upload route, `POST /api/lb09/meetings`, carry 5 MB; everything else keeps the 1 MB cap.
- **The private transcriber's weights.** `infra/docker/django-systems.Dockerfile` downloads
  Whisper's base model, converted for CTranslate2, from Hugging Face at build time into
  `/app/whisper/base`, which `LB09_WHISPER_DIR` names, and the service loads it with local files
  only: a running container never downloads anything. The build host must reach
  `huggingface.co` (GitHub's runners do; a sandbox without a route fails the build, on purpose).
  To change the model, change the name in the Dockerfile and the folder in `docker-compose.yml`
  together. The worker's 1 GiB limit was measured with the base model in int8: one private
  meeting takes 638 MiB of it, two at once 974 MiB, which is why private transcriptions take
  turns (`lb09/transcribers.py`); a different model needs the measurement made again.
- **Its role and secrets.** `lb09` is in `infra/postgres/systems.txt`, so the provision job makes
  the role; `LB_PG_PASSWORD_LB09` is new in `postgres-roles.example.env`, so `just secrets-edit
  postgres-roles` must be given a value with `just secret-token` before the next deploy, or the
  secrets check refuses the release. `routing.yaml` ties `lb-09` to the `django-systems` service
  key that already exists; nothing new is needed at the gateway, and the Redis role is unchanged.

### Upgrading images and tools

Base images and the third-party images are pinned by digest. To take a newer release of
one, change its tag in the Compose file or Dockerfile, run `just pin-images`, read the
diff, and open a pull request: CI builds it for both architectures. To take the current
build of a tag you already use (a security patch), run `just pin-images` alone. CI's scan
fails a release whose image has a fixable high or critical vulnerability, which is the
prompt to do this. `sops`, `cosign`, `hadolint` and `actionlint` are pinned in
`infra/scripts/install-tool.sh`, with their SHA-256; change a version and both checksums
together, and keep cosign's version the same in `images.yml`. LB-07's Chromium follows
playwright-core: after an upgrade of it in the lockfile, the sandbox image's build stops until
`infra/docker/lb07-sandbox-browser.sh` names the Chrome Headless Shell version the new
playwright-core's `browsers.json` names, with the SHA-256 of both architectures' zips. The
Debian libraries it needs are taken from Debian 13 at each build, so a rebuild takes their
security fixes.

If the repository is renamed or moved, set `LB_SIGNER_REPOSITORY` (`owner/repository`) for
the deploy, or change the default in `infra/scripts/deploy.sh`: the box accepts only
signatures made by this repository's workflows.

### Replacing the box

The box can be rebuilt anywhere from this repository, the signed images, and the
encrypted backups. Repeat parts 2 to 4 on the new machine (a Hetzner CAX21 runs the same
images unchanged), add its new age key with `just secrets-add-recipient` and merge, move
the tunnel by creating the connector there (the same token works: stop the old box
first), re-run **Deploy**, and restore the latest backup (Backups, above).

### When something fails

| You see | Likely cause |
|---|---|
| `decrypt-secrets: ... cannot be decrypted` | The box's key is not a recipient of that file: `just secrets-add-recipient box <key>`, merge, deploy |
| `decrypt-secrets: ... is not complete` | A template gained a variable that the encrypted file does not have: `just secrets-edit <name>` |
| `the signature of ... does not verify` | The image was not built by this repository's workflow from `main`, or `LB_SIGNER_REPOSITORY` is wrong, or the box's cosign is older than the one that signed (`infra/scripts/install-tool.sh cosign`) |
| `docker compose pull` says `denied` | The GHCR packages are private and the box is not logged in (part 9, step 3) |
| A container is `unhealthy` in `compose ps` | `compose logs <service>`. For Redis, `acl log` shows what the ACL refused |
| `502` or `503` from the API | A back-end container is unhealthy or restarting; Caddy answers 5xx while it is |
| `deploy: another deploy or the nightly backup is running on this box` | A deploy, or the backup that starts at 02:30 UTC, holds `/opt/lb/deploy.lock`: nothing was changed. `journalctl -u lb-backup.service -n 5` shows whether the backup is running; re-run the Deploy workflow when it is done |
| `flask-api` is `unhealthy`, and its log says the data isn't ready | The warehouse volume is empty or from another generator version: `compose logs flask-seed`, then make the data again as part 13 says (LB-05's data: `flock -n /opt/lb/deploy.lock /opt/lb/current/infra/scripts/compose.sh run --rm --no-deps flask-seed python seed_warehouse.py --force`) and recreate `flask-api` |
| `node-worker` is `unhealthy` | Its heartbeat file is older than 30 seconds: the worker's event loop is stuck or it is crash-looping. `compose logs node-worker`; Redis's `acl log` shows a command its user may not run |
| `lb07-sandbox` restarts now and then | Expected: it starts afresh after every 20 browser sessions, and its log says "has served its share of runs" (part 13, LB-07's browser sandbox). Anything else in its log before a restart is a crash |
| Every LB-07 test run ends `runner_unavailable` | The worker cannot reach the runner: `compose ps lb07-sandbox` (is it healthy?), and the worker's `LB07_RUNNER_URL` and network (`sandbox`). A worker started without `LB07_RUNNER_URL` or the shop key logs "no browser runner is configured" at start |
| LB-07's runs find no bug they switched on | The worker and the sandbox hold different shop keys, so the shop ignores the bug token: both read `LB07_SHOP_TOKEN_KEY` from `lb07-sandbox.env`; recreate both after editing it |
| A WebSocket to LB-02 is refused with `403` | The `Origin` is not `LB_SITE_ORIGIN` (Caddy checks it); with `1009` or a drop, a frame was over 8192 bytes (`--ws-max-size`) |
| A WebSocket to LB-02 gets `too_many_connections` and closes with `1013` | The visitor already holds four connections to this server process: two tabs, the installed app, and one the network cut that the server has not noticed yet (it goes when uvicorn's ping times out, about 40 seconds). Closing a tab frees a place; the page retries by itself |
| `cloudflared` keeps restarting | The `TUNNEL_TOKEN` is wrong or was refreshed in Cloudflare |
| Backups stop appearing | `journalctl -u lb-backup.service`; usually `LB_EGRESS_SYSTEMS_ALLOW` lacks the R2 host, or the R2 token changed. `flock: timeout while waiting to get lock` means a deploy held the lock for the 20 minutes the backup waits: it tries again the next night, or now with `sudo systemctl start lb-backup.service` |
| The box is slow or killed processes | `docker stats --no-stream`, then `dmesg \| grep -i oom`: a container hit its memory limit; raise it in the Compose file, within the budget at its top (part 2, The memory budget) |
| Every LB-03 upload ends `failed` with `ocr_failed` | With `LB_LB03_REQUIRE_LANDLOCK=true` a box with no Landlock reads nothing: take the line out of `compose` and upload again, and the trace's `read pages` span shows `landlock_abi` 0; then check the kernel (`uname -r`, 5.13 or later) and Docker's seccomp profile. Otherwise the worker was probably killed for memory (`dmesg`), which is what its OOM score is for |
| LB-03's upload is `503` `unavailable` | The file store can't be reached: the R2 host is missing from `LB_EGRESS_SYSTEMS_ALLOW` (the same fix as for backups), or the `lb-uploads` token or bucket name is wrong; `compose logs flask-api` names the problem by type, never by value |
| Files stay in the bucket past their hour | The service sweeps every minute and says nothing when it finds none: run `compose exec flask-api python manage.py sweep_lb03` and read its counts; the bucket's one-day rule is only the backstop |
