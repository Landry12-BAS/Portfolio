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
| The box (one Oracle Cloud VM) | The whole back end, as one Docker Compose project named `lb`: Caddy, `cloudflared`, the gateway, the Django, Flask and Node systems, Postgres, Redis, two egress proxies | Visitors only through Cloudflare's tunnel to Caddy; you only over Tailscale |
| Cloudflare | DNS, the tunnel, the WAF, Turnstile, and R2 (the backup bucket) | |
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
5. **Make the host firewall agree**, so that only Tailscale's interface accepts anything.
   Docker publishes no port here, so it does not interfere:

   ```sh
   sudo ufw allow in on tailscale0
   sudo ufw default deny incoming
   sudo ufw --force enable
   ```

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

**Rate limiting.** In Security, WAF, Rate limiting rules, add one rule for the API
hostname, such as: when the host is `api.example.com`, more than 50 requests in 10
seconds from one IP address, block. (The gateway and the Django systems have their own
per-visitor quotas; this one stops floods before they reach the box.) Leave Cloudflare's
managed WAF rules and Bot Fight Mode on.

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
| `node-systems`: the Node systems (LB-08) calling the gateway | An entry of `LB_SERVICE_KEYS` | `LB_SERVICE_KEY_JWK_B64` in the Node secrets, for the API only: the worker makes no model call and is given no key |
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
                                 #   LB_EGRESS_SYSTEMS_ALLOW=<account id>.r2.cloudflarestorage.com
just secrets-new postgres        # nothing to type
just secrets-new postgres-roles  # nothing to type
just secrets-new redis           # nothing to type
just secrets-new gateway         # LB_SERVICE_KEYS, GROQ_API_KEY, CLOUDFLARE_ACCOUNT_ID,
                                 #   CLOUDFLARE_API_TOKEN, OPENROUTER_API_KEY
just secrets-new django-systems  # LB_SERVICE_KEY_JWK_B64 (the django-systems file, in base64)
just secrets-new flask-systems   # LB_SERVICE_KEY_JWK_B64 (the flask-systems file, in base64)
just secrets-new node-systems    # LB_SERVICE_KEY_JWK_B64 (the node-systems file, in base64)
just secrets-new cloudflared     # TUNNEL_TOKEN
just secrets-new backup          # see below
```

`LB_EGRESS_SYSTEMS_ALLOW` lists the hosts the Django systems and the backup may reach, comma
separated; add Sentry's ingest host (`.ingest.sentry.io`) when a system sends errors there.

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
just secrets-check                            # ten lines of "ok"
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
2. The `images` job builds the six images for amd64 and arm64 under QEMU (the first time
   it takes a while, since nothing is cached), pushes them to GHCR, scans them, signs
   them, and checks its own signature.
3. **The first run stops at the box's pull.** GHCR creates each package private. Make the
   six packages public (GitHub, your profile, Packages, each `lb-*` package, Package
   settings, Change visibility): the images hold the code of this public repository and
   its synthetic data, and no secret. Then, in the failed Deploy run, choose **Re-run
   failed jobs**. (If you would rather keep them private, log the `deploy` user in once
   with a read-only token: `echo <token> | sudo -u deploy docker login ghcr.io -u <you>
   --password-stdin`; the token then lives in that user's `~/.docker/config.json`.)
4. The `deploy` job sends the commit's `infra/` folder to `/opt/lb/releases/<commit>` and
   runs `deploy.sh`. It decrypts the secrets, pulls, checks the signatures, starts
   everything, waits for every health check, runs the smoke test (through the public
   hostname too), and marks the release current. The first one takes several minutes:
   Postgres initialises, the roles and schemas are provisioned, the Django, Flask and Node
   systems' tables are migrated and their synthetic data seeded, and LB-05's warehouse
   (about two million orders) is generated into its volume, which takes some tens of
   seconds. Later deploys find the warehouse there and skip it.
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
| Domains | `example.com` and `www.example.com`, with the DNS records Vercel shows (kept DNS-only in Cloudflare) |

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

Mark everything except `NUXT_LB_API_URL`, `NUXT_LB_GATEWAY_URL` and
`NUXT_PUBLIC_TURNSTILE_SITE_KEY` as Sensitive. The site reads exactly these names
(`apps/web/nuxt.config.ts`; `apps/web/.env.example` lists them with a line each) and checks
them when it starts: with none set it serves the catalog and the datasheets and answers every
demo with "not connected", as a preview does; with some set it refuses to start unless every
one is right, and the log names the variable that is wrong and never its value. Turnstile's
widget mode stays Managed: the site draws it with `appearance: interaction-only`, so a visitor
sees it only when Cloudflare needs them to do something.

The site's server calls LB-05 and LB-08 and waits up to 95 seconds for them
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
      `/api/lb05/quota` (LB-05) and `/api/lb08/limits` (LB-08).
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/api/healthz` is `404`,
      and so are `/api/openapi.json` and `/v1/models`: only the routes in the Caddyfile
      exist.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' https://api.example.com/ws/lb02/x`
      is `403`: a WebSocket from another origin is refused.
- [ ] `https://example.com` loads, in both languages, in both themes.
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
- [ ] `/opt/lb/current/infra/scripts/smoke.sh --public` ends with "All checks passed.": the
      routes through Caddy, no way out except through the proxies, an empty Redis ACL
      log, and the public hostname.
- [ ] `findmnt -T /run/lb/secrets` shows `tmpfs`, and `ls -l /run/lb/secrets` shows every
      file `-rw-------` and owned by `deploy`.
- [ ] `cat /opt/lb/deploys.log` has one line for the release, and `readlink /opt/lb/current`
      is `releases/<commit>`.
- [ ] A container cannot reach the internet directly: `compose exec gateway /nodejs/bin/node -e
      "require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>{console.log('CONNECTED');process.exit()}).on('error',e=>{console.log('error',e.code);process.exit()})"`
      prints `error ENETUNREACH`, never `CONNECTED`. (`smoke.sh` checks this too.)
- [ ] `systemctl list-timers lb-backup.timer` shows the next run, and the test backup from
      part 9 is in the bucket.
- [ ] A backup restores (part 13, Backups) into a scratch database, with the row counts
      you expect.
- [ ] `cosign verify --certificate-identity-regexp '^https://github\.com/<owner>/<repo>/\.github/workflows/(images|deploy)\.yml@refs/heads/main$' --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/<owner>/lb-gateway:<commit>`
      succeeds (the owner in lowercase in the image name).

In GitHub: the Deploy run is green, and the six packages show the commit's tag.

## 12. What is not verified

Run and tested in this repository: the six images build and run hardened (non-root,
read-only filesystem, no capabilities, limits); the Compose stack comes up through Caddy
with real visitor tokens, the real database roles and the egress proxies, and LB-01, LB-02
(its calls and a WebSocket conversation through the Redis channel layer), LB-05 (from the
read-only warehouse) and LB-08 (a workflow run through BullMQ to its worker) answer
through it; every Compose service passes the security rules and the memory budgets
(`infra/scripts/check-compose.sh`, which also has tests that show each rule can fail); the
Postgres roles cannot reach each other's schemas, for every pair of the four systems
(`infra/postgres/test-roles.sh`); the Redis ACL passes the gateway's, lb-common's, LB-02's
consumer, LB-05's integration and LB-08's whole test suites and a Celery worker's, with an
empty ACL log (`infra/redis/test-acl.sh`); Caddy's routes, headers, streaming, timeouts, a
quiet WebSocket and bypass attempts (`infra/caddy/test.sh`); a backup is encrypted,
restores into a scratch database and over the live one, and a wrong key cannot open it; the
secrets tooling with the real `sops` and `age` (`infra/scripts/test-secrets.sh`); the deploy
script's order, signature check, rollback and clean-up with stand-ins for Docker and cosign
(`infra/scripts/test-deploy.sh`); image pinning against the real registries; `docker compose
config`, hadolint, shellcheck and actionlint.

**Not verified, because it needs the real thing:**

- Building and running on **arm64**: the box's architecture. The images are built for
  both, but only amd64 was built and run in development, since the machine here has no
  QEMU. The first arm64 build runs in CI. The two new images carry native wheels (DuckDB,
  numpy, cryptography, psycopg) and BullMQ's optional speed-up: all publish arm64 builds,
  but nobody has run them on one.
- Everything on **Oracle Cloud**: creating the VM, the capacity retries, the security
  list, the reclaim rule, and the 2 OCPU and 12 GB sizing under real load. The memory
  limits of what runs all the time add up to 7040 MiB (6.9 GiB; the sums are at the top of
  `infra/docker-compose.yml`); idle, the stack used about 0.7 GiB here (without `cloudflared`
  and the proxies), LB-05's data job peaked at 923 MB, and the service's warehouse code at
  452 MB while it answered the 100 reference questions on the full dataset, on a four-core
  x86 machine; nothing was measured under visitor traffic or on the box's cores. LB-05's questions and LB-08's descriptions need a model, so
  their answers through the stack were not tried; everything that does not call one was.
- **Cloudflare**: the tunnel actually carrying traffic (`cloudflared` was not started),
  the DNS records, the WAF and rate-limit rule, Turnstile, R2 (the upload was tested
  against a local folder).
- **Tailscale**: the OAuth client, the tags and policy, `tailscale ssh` from a runner,
  the `ping` wait before it.
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
  Cloudflare worked under the policy. They were never deployed, never run with a real Turnstile
  site key, challenge and hostname, and never run with a model behind LB-01. So no
  **recording** exists: `just record-sample lb-01 torn-bag` needs the live back end and
  records nothing until it has run there, and until it has the boards say "No recording yet"
  and offer the live run. Not checked either: whether the Vercel plan lets a function wait the
  95 seconds the proxy allows LB-05 and LB-08.
- Real provider traffic: no provider key was available.

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
quarter" look old, make it on purpose and restart the API:

```sh
compose run --rm flask-seed python seed_warehouse.py --force
compose up -d --force-recreate flask-api
```

### Backups

A systemd timer runs the `backup` job at 02:30 UTC: `pg_dump` is piped straight into
`age`, so the dump never exists unencrypted, and only the encrypted file is uploaded to
`r2:lb-backups/postgres`. A failed dump uploads nothing. Look at the last run:

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
runtime that is already there (LB-03 on Flask, LB-04 on Node) is a module of that service
and needs only steps 3 to 6; a new runtime needs all of them. The order that works:

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
   check, and memory, CPU and process limits. The memory budgets at the top of the file are
   enforced: `just infra-check` fails when the new limits make the sums too big, and the
   fix is a decision about the box, not an edit of the budget. Add the build blocks to
   `infra/docker-compose.dev.yml`, and give Caddy's `depends_on` the new API.
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

### Upgrading images and tools

Base images and the third-party images are pinned by digest. To take a newer release of
one, change its tag in the Compose file or Dockerfile, run `just pin-images`, read the
diff, and open a pull request: CI builds it for both architectures. To take the current
build of a tag you already use (a security patch), run `just pin-images` alone. CI's scan
fails a release whose image has a fixable high or critical vulnerability, which is the
prompt to do this. `sops`, `cosign`, `hadolint` and `actionlint` are pinned in
`infra/scripts/install-tool.sh`, with their SHA-256; change a version and both checksums
together, and keep cosign's version the same in `images.yml`.

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
| `flask-api` is `unhealthy`, and its log says the data isn't ready | The warehouse volume is empty or from another generator version: `compose logs flask-seed`, then `compose run --rm flask-seed python seed_warehouse.py --force` and recreate `flask-api` |
| `node-worker` is `unhealthy` | Its heartbeat file is older than 30 seconds: the worker's event loop is stuck or it is crash-looping. `compose logs node-worker`; Redis's `acl log` shows a command its user may not run |
| A WebSocket to LB-02 is refused with `403` | The `Origin` is not `LB_SITE_ORIGIN` (Caddy checks it); with `1009` or a drop, a frame was over 8192 bytes (`--ws-max-size`) |
| A WebSocket to LB-02 gets `too_many_connections` and closes with `1013` | The visitor already holds four connections to this server process: two tabs, the installed app, and one the network cut that the server has not noticed yet (it goes when uvicorn's ping times out, about 40 seconds). Closing a tab frees a place; the page retries by itself |
| `cloudflared` keeps restarting | The `TUNNEL_TOKEN` is wrong or was refreshed in Cloudflare |
| Backups stop appearing | `journalctl -u lb-backup.service`; usually `LB_EGRESS_SYSTEMS_ALLOW` lacks the R2 host, or the R2 token changed |
| The box is slow or killed processes | `docker stats --no-stream`, then `dmesg \| grep -i oom`: a container hit its memory limit; raise it in the Compose file and the budget at its top |
