# Staging operations

The staging stack runs the same `compose.yaml` used locally: Caddy is the only
public entry point, while the Web, API, and PostgreSQL/PostGIS services remain on
the private Docker network.

## Local stack

1. Copy `.env.example` to `.env` and replace both database passwords.
2. Run `docker compose up --detach --build --wait`.
3. Open `http://localhost`.
4. Check liveness at `/health`, readiness at `/ready`, and the sample data at
   `/api/trips/hong-kong-together/summary`.

Migrations and the seed run with the administrative role before the API starts.
Both are safe to run again. The API receives a separate non-superuser role with
only application-schema privileges.
The database and Caddy state live in named Docker volumes, so a container or host
restart does not discard them. `docker compose down` preserves data;
`docker compose down --volumes` intentionally removes it.

## One-time Lightsail provisioning

Prerequisites:

- AWS CLI v2 authenticated to an account with the Hong Kong region enabled.
- A Lightsail SSH key pair downloaded locally.
- Your current public IP in CIDR form, such as `203.0.113.10/32`.

From a POSIX shell, run:

```sh
AWS_REGION=ap-east-1 \
ADMIN_CIDR=203.0.113.10/32 \
KEY_PAIR_NAME=your-lightsail-key \
sh infra/lightsail/provision.sh
```

The script is idempotent. It creates an Ubuntu 24 instance, a static IP, Docker,
a 2 GB swap file, and replaces the Lightsail firewall rules with only:

- TCP 22 from the administrator CIDR and Lightsail's browser SSH service.
- TCP 80 and 443 from the public internet.

Ports 3000, 4173, and 5432 are never published. The default `micro_3_0` bundle is
the practical floor for building this Compose stack; set `BUNDLE_ID` to choose a
larger plan without changing the script.

Wait for cloud-init before the first deployment:

```sh
ssh -i /path/to/key.pem ubuntu@STATIC_IP \
  'cloud-init status --wait && docker compose version'
```

## GitHub staging environment

After this workflow is present on `main`, run
`sh scripts/configure-github-staging-environment.sh`. It creates the GitHub
environment and restricts its deployment policy to `main`. The workflow also
refuses to deploy a commit until its **Verify** workflow has succeeded.

Add these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `STAGING_HOST` | Lightsail static IPv4 address |
| Secret | `STAGING_SSH_PRIVATE_KEY` | Entire private key file |
| Secret | `STAGING_SSH_KNOWN_HOSTS` | Verified `known_hosts` line from the server console |
| Secret | `STAGING_POSTGRES_ADMIN_PASSWORD` | Long URL-safe random value |
| Secret | `STAGING_APP_DATABASE_PASSWORD` | A different long URL-safe random value |
| Optional variable | `STAGING_SITE_ADDRESS` | A custom `https://` hostname |

Get the SSH host key from a trusted Lightsail console session on the instance,
not from an unauthenticated network scan:

```sh
sudo ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key |
  awk -v host="STATIC_IP" '{print host " " $1 " " $2}'
```

Store that complete output line in `STAGING_SSH_KNOWN_HOSTS`.

If `STAGING_SITE_ADDRESS` is absent, deployment uses
`https://STATIC-IP-WITH-DASHES.sslip.io`; Caddy obtains and renews its public TLS
certificate automatically.

Run the **Deploy staging** workflow from `main` and choose `deploy`. Each deployment is stored
under `/opt/along-the-way/releases/<commit-and-run>`. Every release gets its own
environment file under `/opt/along-the-way/shared/env/` with mode `0600`, outside
the source archive, so a failed deployment can restore both the previous code and
its configuration.

## Rollback

Run the same **Deploy staging** workflow and choose `rollback`. It starts the
previous release against the same persistent database volume, verifies `/ready`,
and swaps the `current` and `previous` release pointers. A failed deployment also
attempts this rollback automatically.

Database migrations are forward-only and must follow the expand/contract rules
in [`docs/engineering/database-migrations.md`](../engineering/database-migrations.md).
Rollback verifies that the previous application remains compatible with the
forward schema; it never performs a risky automatic down migration.

Rollback starts the retained, commit-tagged API and Web images with `--no-build`
and `--no-deps`; it does not invoke the older release's migrator. Do not prune
images belonging to the `current` or `previous` release.

## Rotate the administrative database password

Changing `STAGING_POSTGRES_ADMIN_PASSWORD` alone does not change a credential in
an existing PostgreSQL volume. Generate a new URL-safe password, send it over
standard input to the trusted current release, and then update the GitHub secret:

```sh
printf '%s\n' "$NEW_PASSWORD" | ssh ubuntu@STATIC_IP \
  'sh /opt/along-the-way/current/infra/postgres/rotate-admin-password.sh'
printf '%s' "$NEW_PASSWORD" |
  gh secret set STAGING_POSTGRES_ADMIN_PASSWORD --env staging
```

The rotation script changes PostgreSQL and atomically updates the current and
previous versioned environment files, keeping emergency rollback available. The
runtime application password can be changed through a normal deployment because
the managed app-role step is repeatable and rollback restores its prior value.

## Routine checks

```sh
curl --fail https://YOUR-STAGING-HOST/health
curl --fail https://YOUR-STAGING-HOST/ready
ssh ubuntu@STATIC_IP 'docker compose \
  --env-file /opt/along-the-way/current-env \
  --file /opt/along-the-way/current/compose.yaml ps'
```

Do not run `docker compose down --volumes` on staging. Automated backups,
monitoring, authentication, email, and background workers are intentionally
outside this foundation ticket.
