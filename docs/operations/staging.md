# Staging operations

The staging stack runs the same `compose.yaml` used locally. Caddy, Web, and API
share an edge network; API, worker, and PostgreSQL/PostGIS share the stable
`private` data network retained for rollback compatibility; only the worker gets
a separate outbound network for Gmail. Caddy cannot address the database,
worker, or local Mailpit service.

## Local stack

1. Copy `.env.example` to `.env`, replace both database passwords, set a random
   `TOKEN_SECRET` of at least 32 bytes, and set `BOOTSTRAP_OWNER_EMAIL`.
2. Run `docker compose --profile local up --detach --build --wait`.
3. Open `http://localhost`, request a sign-in link for that Owner, and open the
   captured message at `http://localhost:8025`.
4. Check liveness at `/health` and database readiness at `/ready`.

Migrations and the idempotent Owner bootstrap run with the administrative role
before the API starts. The API and worker receive a separate non-superuser role
with application-table privileges but no access to Kysely migration bookkeeping
and no write access to PostGIS `spatial_ref_sys`. The worker claims PostgreSQL
email jobs, publishes a durable heartbeat used by `/ready`, and sends them
through Mailpit locally. Mailpit exists only in the `local` Compose profile and
does not bypass magic-link authentication. Raw magic-link and invitation tokens
are derived only while sending and are never persisted.

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
refuses to deploy a commit until a successful **Verify** run covers its exact
content: some verified commit (usually the release pull request head) must have
the same Git tree. Verify no longer runs on pushes to `main`; when `main`'s tree
matches no verified pull request head, run Verify on `main` manually
(`gh workflow run verify.yml --ref main`) before deploying.

Add these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `STAGING_HOST` | Lightsail static IPv4 address |
| Secret | `STAGING_SSH_PRIVATE_KEY` | Entire private key file |
| Secret | `STAGING_SSH_KNOWN_HOSTS` | Verified `known_hosts` line from the server console |
| Secret | `STAGING_POSTGRES_ADMIN_PASSWORD` | Long URL-safe random value |
| Secret | `STAGING_APP_DATABASE_PASSWORD` | A different long URL-safe random value |
| Secret | `STAGING_TOKEN_SECRET` | Random value of at least 32 bytes used to derive one-time tokens |
| Optional variable | `STAGING_SITE_ADDRESS` | A custom `https://` hostname |
| Variable | `STAGING_BOOTSTRAP_OWNER_EMAIL` | Initial private Beta Owner email |
| Optional variable | `STAGING_SMTP_HOST` | Gmail SMTP host; defaults to `smtp.gmail.com` |
| Optional variable | `STAGING_SMTP_PORT` | Gmail SMTP port; defaults to `587` |
| Optional variable | `STAGING_SMTP_SECURE` | `true` for implicit TLS; defaults to `false` for STARTTLS |
| Optional variable | `STAGING_SMTP_REQUIRE_TLS` | Must remain `true` unless implicit TLS is enabled |
| Secret | `STAGING_SMTP_USERNAME` | Gmail SMTP username |
| Secret | `STAGING_SMTP_PASSWORD` | Gmail app password |
| Optional variable | `STAGING_EMAIL_FROM` | Sender address; defaults to the Gmail SMTP username |
| Optional secret | `STAGING_GOOGLE_MAPS_API_KEY` | Server-side Google key with Places API (New) and Routes API enabled; without it place search and Google routes are unavailable |
| Optional secret | `STAGING_OPENAI_API_KEY` | OpenAI API key for AI 建議; without it AI research is unavailable |
| Optional variable | `STAGING_OPENAI_MODEL` | OpenAI model ID for AI 建議; defaults to the Compose default when unset |
| Optional secret | `STAGING_RAPIDAPI_KEY` | RapidAPI key subscribed to NAVITIME Route (totalnavi); without it Japan transit routes are unavailable |

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

Run the **Deploy staging** workflow from `main` and choose `deploy`. Each
deployment is stored under `/opt/along-the-way/releases/<commit-and-run>`.
Activation removes the unprofiled Mailpit container left by pre-hardening
releases after the production stack passes readiness; production email continues
through Gmail. Release environment files live under
`/opt/along-the-way/shared/env/` with mode `0600`, outside the source archive.
Activation keeps only three environment files while protecting the current and
previous configurations needed for rollback.

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
and `--no-deps`; it also starts the worker and Mailpit when that retained
release defines them in its default profile. It does not invoke the older
release's migrator. Do not prune images belonging to the `current` or
`previous` release.

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

## Backups and routine checks

Every activation idempotently installs and starts
`along-the-way-backup.timer`. It runs at 03:15 UTC with up to 30 minutes of
jitter, writes compressed custom-format `pg_dump` files under
`/opt/along-the-way/backups` with mode `0600`, and deletes files after 14 days.
The backup is on the same server and protects against application/operator
mistakes, not loss of the instance; enable Lightsail snapshots or encrypted
off-host copies separately.

### Owner action: enable off-instance snapshots

The on-server dumps do not survive instance deletion or storage failure. The
AWS account owner must enable Lightsail automatic snapshots:

1. Sign in to the [Lightsail console](https://lightsail.aws.amazon.com/).
2. In the left navigation, choose **Instances**.
3. Choose the staging instance (`along-the-way-staging` unless provisioning used
   a different `INSTANCE_NAME`).
4. Choose the **Snapshots** tab.
5. Under **Automatic snapshots**, switch the toggle on.
6. At the prompt, choose **Yes, enable**.
7. After the configured daily snapshot window, return to **Snapshots** and
   confirm a current automatic snapshot is listed.

Lightsail retains the latest seven automatic snapshots and deletes them when the
source instance is deleted. For a longer-lived recovery point, choose the
ellipsis beside a snapshot, choose **Keep snapshot**, then **Yes, save**; the
manual copy remains until explicitly deleted. See AWS's official
[automatic snapshot](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html)
and [Keep snapshot](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-keeping-automatic-snapshots.html)
guides.

`/ready` returns success only while PostgreSQL is reachable and the email
worker's durable heartbeat is fresh. Check the timer and force a backup after
the first deployment:

```sh
curl --fail https://YOUR-STAGING-HOST/health
curl --fail https://YOUR-STAGING-HOST/ready
curl --head --fail https://YOUR-STAGING-HOST/ |
  grep -i 'strict-transport-security\|content-security-policy'
ssh ubuntu@STATIC_IP 'sudo systemctl list-timers along-the-way-backup.timer &&
  sudo systemctl start along-the-way-backup.service &&
  sudo journalctl -u along-the-way-backup.service -n 20 --no-pager &&
  sudo ls -l /opt/along-the-way/backups'
```

Test a backup before relying on it:

```sh
sudo sh -c 'cat /opt/along-the-way/backups/along-the-way-TIMESTAMP.dump' |
  docker compose \
    --env-file /opt/along-the-way/current-env \
    --file /opt/along-the-way/current/compose.yaml \
    run --rm --no-deps --no-TTY provision-app-role pg_restore --list >/dev/null
```

To restore, first copy the selected dump somewhere safe and take a fresh
backup. Then run the following on the server during a maintenance window,
replacing `BACKUP.dump`. The restore recreates the database, reapplies the
restricted runtime-role grants, and starts the application only after
`pg_restore` succeeds:

```sh
release=/opt/along-the-way/current
environment=/opt/along-the-way/current-env
backup=/opt/along-the-way/backups/BACKUP.dump
admin=$(sudo sed -n 's/^POSTGRES_ADMIN_USER=//p' "$environment" | tail -n 1)
database=$(sudo sed -n 's/^POSTGRES_DB=//p' "$environment" | tail -n 1)

sudo systemctl stop along-the-way-backup.timer
sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
  stop api worker
sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
  exec --no-TTY db dropdb --username "$admin" --maintenance-db postgres \
    --force --if-exists "$database"
sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
  exec --no-TTY db createdb --username "$admin" --maintenance-db postgres \
    --owner "$admin" "$database"
sudo sh -c "cat '$backup'" |
  sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
    exec --no-TTY db pg_restore --username "$admin" --dbname "$database" \
      --no-owner --no-privileges --exit-on-error
sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
  run --rm --no-deps provision-app-role
sudo docker compose --env-file "$environment" --file "$release/compose.yaml" \
  up --detach --no-build --wait --wait-timeout 180 api worker web caddy
sudo systemctl start along-the-way-backup.timer
curl --fail https://YOUR-STAGING-HOST/ready
```

Do not run `docker compose down --volumes` on staging.
