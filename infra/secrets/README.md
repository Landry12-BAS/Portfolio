# Secrets

Every secret the platform needs, encrypted with [SOPS](https://github.com/getsops/sops)
and [age](https://github.com/FiloSottile/age), committed next to the code that reads it.
The repository holds only ciphertext. Plain text exists in two places and no others: the
owner's editor while a file is open, and a memory-backed folder on the box (`/run/lb/
secrets`) while the stack runs. Why this design: [`docs/STACK.md`](../../docs/STACK.md)
and [`docs/SECURITY.md`](../../docs/SECURITY.md), section 7.

## The files

One encrypted file per service, plus one for the settings that name the deployment. Each
has a template beside it that lists its variables and says where every value comes from.

| File | Read by | Holds |
|---|---|---|
| `compose` | Compose, Caddy, the Django systems | The API's hostname, the site's origin, the hosts the Django systems may reach |
| `postgres` | `postgres` | The superuser's password (nothing logs in with it) |
| `postgres-roles` | `postgres-provision`, `backup` | One password per Postgres login role |
| `redis` | `redis` | One password per Redis user |
| `gateway` | `gateway` | The services' public keys, and the provider keys (the only ones on the platform) |
| `django-systems` | `django-api`, `django-worker`, `django-migrate` | Django's signing key, the site's public key, the service's own gateway key |
| `cloudflared` | `cloudflared` | The Cloudflare Tunnel's token |
| `backup` | `backup` | The backup's age public keys, and the R2 credentials it uploads with |

Each is `<name>.enc.env` (the secrets) with a `<name>.example.env` (the template). The
deploy refuses a release in which a template has no encrypted file.

## Reading a template

```sh
NAME=                  # required: the encrypted file must set it, and the check fails while it is empty
NAME=some-default      # required, and `just secrets-new` starts the file with this value
NAME=@token            # required, and `just secrets-new` makes a random 48-hex-character value
NAME=@token:32         # the same, with 32 random bytes (64 characters)
# NAME=                # optional: the file may set it
```

Any other name in an encrypted file is a typo, and `just secrets-check` says so. The
check names variables and line numbers only: a value never reaches its output.

## Keys

| Key | Where its private half lives | What it is for |
|---|---|---|
| Owner's age key | `~/.config/sops/age/keys.txt` on the owner's machine, backed up in a password manager | Creating and editing the files |
| The box's age key | `/etc/lb/age.key` on the VM (root only), made there by the first deploy | Decrypting the files at deploy time |
| The backup age key | Off the box, on the owner's machine | Opening the nightly database dumps. A separate key, so a stolen box cannot read its own backups |

`.sops.yaml` lists the public halves of the first two, and every file is encrypted to
both. A public key is not a secret; a private key is never committed, pasted into a chat,
or copied anywhere but where the table says. If the box is lost, its key is removed from
`.sops.yaml` and every secret it could read is changed (`docs/DEPLOY.md`, Rotating a key).

## Commands

All of them run from the repository root. They need `sops`, `age` and `openssl`.

| Command | What it does |
|---|---|
| `just secrets-init` | Makes your age key outside the repository, and lists its public half in `.sops.yaml` |
| `just secrets-new <name>` | Creates `<name>.enc.env` from its template: random values made, then your editor opens for the values only you have |
| `just secrets-edit <name>` | Opens a file in your editor (`$EDITOR`), and checks it afterwards. A path such as `infra/secrets/gateway.enc.env` works too |
| `just secrets-check` | Decrypts every file in memory and compares it with its template |
| `just secrets-add-recipient <label> <key>` | Lets one more age public key (the box's) open every file |
| `just secrets-rekey` | After a key is removed from `.sops.yaml`, locks every file to the keys left, with a new data key |
| `just secret-token [bytes]` | Prints a random hex token, for a value you edit in by hand |

`infra/scripts/test-secrets.sh` (`just secrets-test`) tests all of this with the real
`sops` and `age`, in a throwaway copy, with throwaway keys.

## On the box

`infra/scripts/decrypt-secrets.sh` turns the encrypted files of the release being deployed
into `/run/lb/secrets/<name>.env`, mode 600, using the box's key. It refuses a folder that
is not a tmpfs, a key other users can read, a missing file, and a file that does not match
its template, and it checks everything before it replaces anything. Compose then reads
those files (`infra/scripts/compose.sh`). After a reboot `/run` is empty, and the
`lb-secrets` systemd unit decrypts them again.

## Adding a variable or a service

- A new variable: add it to the template, in the same change as the code that reads it.
  The next deploy stops until the encrypted file has it, which is the point. Run
  `just secrets-edit <name>` first.
- A new service: add `<service>.example.env`, run `just secrets-new <service>`, and give
  the service `env_file: ${LB_SECRETS_DIR}/<service>.env` in `docker-compose.yml`
  (`docs/DEPLOY.md`, Adding a service).

## If a secret leaks

Treat it as spent. Replace it at its source (the provider's console, Cloudflare), put the
new value in with `just secrets-edit`, and deploy. Removing it from the repository does
not help: git keeps history, and the old ciphertext stays decryptable by whoever held a
key that was listed when it was written. `docs/DEPLOY.md`, Rotating a key, has the steps for
each kind of secret.
