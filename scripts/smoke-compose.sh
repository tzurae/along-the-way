#!/usr/bin/env sh
set -eu

export POSTGRES_DB="${POSTGRES_DB:-along_the_way_test}"
export POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-along_the_way_admin_test}"
export POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-ci-only-admin-secret}"
export APP_DATABASE_USER="${APP_DATABASE_USER:-along_the_way_app_test}"
export APP_DATABASE_PASSWORD="${APP_DATABASE_PASSWORD:-ci-only-app-secret}"
export SITE_ADDRESS="${SITE_ADDRESS:-http://localhost}"
export BOOTSTRAP_OWNER_EMAIL="${BOOTSTRAP_OWNER_EMAIL:-owner@example.test}"
export SMTP_HOST="${SMTP_HOST:-mailpit}"
export SMTP_PORT="${SMTP_PORT:-1025}"
export EMAIL_FROM="${EMAIL_FROM:-Along the Way <along-the-way@example.test>}"
export SMTP_SECURE="${SMTP_SECURE:-false}"
export SMTP_REQUIRE_TLS="${SMTP_REQUIRE_TLS:-false}"
export SMTP_USERNAME="${SMTP_USERNAME:-}"
export SMTP_PASSWORD="${SMTP_PASSWORD:-}"
export TOKEN_SECRET="${TOKEN_SECRET:-ci-only-token-secret-at-least-thirty-two-bytes}"
export HTTP_PORT="${HTTP_PORT:-28055}"
export HTTPS_PORT="${HTTPS_PORT:-28455}"
export MAILPIT_HTTP_PORT="${MAILPIT_HTTP_PORT:-28855}"
tls_test_port="${TLS_TEST_PORT:-29255}"
smoke_address="http://localhost:$HTTP_PORT"
smoke_project="along-the-way-smoke-${GITHUB_RUN_ID:-$$}"
export RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-$smoke_project}"
rollback_root=""
header_caddy=""
header_file=""
operations_root=""
rollback_previous_tag="$smoke_project-previous"
rollback_previous_password="ci-previous-app-secret"

compose() {
  docker compose --profile local --project-name "$smoke_project" "$@"
}

app_password_connects() {
  password="$1"
  compose run --rm --no-deps \
    -e PGPASSWORD="$password" \
    provision-app-role psql \
      --host=db \
      --username="$APP_DATABASE_USER" \
      --dbname="$POSTGRES_DB" \
      --command='SELECT 1'
}

app_sql() {
  password="$1"
  sql="$2"
  compose run --rm --no-deps \
    -e PGPASSWORD="$password" \
    provision-app-role psql \
      --host=db \
      --username="$APP_DATABASE_USER" \
      --dbname="$POSTGRES_DB" \
      --set ON_ERROR_STOP=1 \
      --command="$sql"
}

assert_app_sql_rejected() {
  sql="$1"
  if app_sql "$APP_DATABASE_PASSWORD" "$sql" >/dev/null 2>&1; then
    echo "Application role unexpectedly ran protected SQL: $sql" >&2
    exit 1
  fi
}

cleanup() {
  if [ -n "$header_caddy" ]; then
    docker rm --force "$header_caddy" >/dev/null 2>&1 || true
  fi
  if [ -n "$header_file" ]; then
    rm -f "$header_file"
  fi
  if [ -n "$operations_root" ]; then
    case "$operations_root" in
      "${TMPDIR:-/tmp}/along-the-way-operations."*) rm -rf "$operations_root" ;;
      *) echo "Refusing to remove unexpected path $operations_root" >&2 ;;
    esac
  fi
  compose down --volumes --remove-orphans
  docker image rm \
    "along-the-way-api:$RELEASE_IMAGE_TAG" \
    "along-the-way-web:$RELEASE_IMAGE_TAG" \
    "along-the-way-api:$rollback_previous_tag" \
    "along-the-way-web:$rollback_previous_tag" >/dev/null 2>&1 || true
  if [ -n "$rollback_root" ]; then
    case "$rollback_root" in
      "${TMPDIR:-/tmp}/along-the-way-rollback."*) rm -rf "$rollback_root" ;;
      *) echo "Refusing to remove unexpected path $rollback_root" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

wait_for_ready() {
  attempts=0
  until curl \
    --connect-timeout 2 \
    --max-time 5 \
    --fail \
    --silent \
    --show-error \
    "$smoke_address/ready" >/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      compose ps
      compose logs api db
      return 1
    fi
    sleep 2
  done
}

assert_private_api() {
  attempts=0
  response=""
  while [ "$attempts" -lt 15 ]; do
    response=$(curl --connect-timeout 2 --max-time 5 --silent --show-error \
      "$smoke_address/api/trips") || true
    if printf '%s' "$response" |
      grep --fixed-strings '"code":"unauthenticated"' >/dev/null; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  echo "Private API did not return the unauthenticated contract: $response" >&2
  return 1
}

assert_header() {
  header_name="$1"
  expected="$2"
  if ! grep --ignore-case --fixed-strings \
    "$header_name: $expected" "$header_file" >/dev/null; then
    echo "Missing $header_name header with expected value" >&2
    cat "$header_file" >&2
    exit 1
  fi
}

operations_root=$(mktemp -d "${TMPDIR:-/tmp}/along-the-way-operations.XXXXXX")
mkdir -p "$operations_root/systemd" "$operations_root/shared/env"
APP_ROOT="$operations_root" \
  SYSTEMD_UNIT_DIR="$operations_root/systemd" \
  SYSTEMCTL_COMMAND=true \
  sh infra/lightsail/install-backup-timer.sh
APP_ROOT="$operations_root" \
  SYSTEMD_UNIT_DIR="$operations_root/systemd" \
  SYSTEMCTL_COMMAND=true \
  sh infra/lightsail/install-backup-timer.sh
[ -x "$operations_root/bin/backup-database.sh" ]
[ -f "$operations_root/systemd/along-the-way-backup.service" ]
[ -f "$operations_root/systemd/along-the-way-backup.timer" ]
grep --fixed-strings 'OnCalendar=*-*-* 03:15:00 UTC' \
  "$operations_root/systemd/along-the-way-backup.timer" >/dev/null

for release in 1 2 3 4 5; do
  printf 'release=%s\n' "$release" >"$operations_root/shared/env/$release.env"
  touch -t "2026100${release}0000" "$operations_root/shared/env/$release.env"
done
APP_ROOT="$operations_root" sh infra/lightsail/prune-release-env.sh
[ "$(find "$operations_root/shared/env" -type f -name '*.env' | wc -l | tr -d ' ')" = 3 ]
[ -f "$operations_root/shared/env/5.env" ]
[ -f "$operations_root/shared/env/4.env" ]
[ -f "$operations_root/shared/env/3.env" ]

failed_root="$operations_root/failed-deploy"
mkdir -p "$failed_root/shared/env"
for release in 1 2 3 4 5; do
  printf 'release=%s\n' "$release" >"$failed_root/shared/env/$release.env"
  touch -t "2026100${release}0000" "$failed_root/shared/env/$release.env"
done
ln -s "$failed_root/shared/env/1.env" "$failed_root/current-env"
ln -s "$failed_root/shared/env/2.env" "$failed_root/previous-env"
APP_ROOT="$failed_root" sh infra/lightsail/prune-release-env.sh
[ "$(find "$failed_root/shared/env" -type f -name '*.env' | wc -l | tr -d ' ')" = 3 ]
[ -f "$failed_root/shared/env/1.env" ]
[ -f "$failed_root/shared/env/2.env" ]
[ -f "$failed_root/shared/env/5.env" ]

if docker compose --project-name "$smoke_project" config --services |
  grep --quiet --line-regexp mailpit; then
  echo "Mailpit must not be part of the default production profile" >&2
  exit 1
fi
compose config --services | grep --quiet --line-regexp mailpit

# CI may build the images beforehand with a layer cache (SMOKE_PREBUILT_IMAGES=1).
if [ "${SMOKE_PREBUILT_IMAGES:-0}" = "1" ]; then
  compose up --detach --wait --wait-timeout 180
else
  compose up --detach --build --wait --wait-timeout 180
fi
wait_for_ready

curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  "$smoke_address/health" |
  grep --fixed-strings '"status":"ok"' >/dev/null
assert_private_api

header_file=$(mktemp "${TMPDIR:-/tmp}/along-the-way-headers.XXXXXX")
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  --dump-header "$header_file" --output /dev/null "$smoke_address/"
assert_header "Content-Security-Policy" \
  "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-eval' https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com blob:; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com; frame-src *.google.com; connect-src 'self' https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; worker-src 'self' blob:"
assert_header "Permissions-Policy" "camera=(), geolocation=(), microphone=()"
assert_header "Referrer-Policy" "strict-origin-when-cross-origin"
assert_header "X-Content-Type-Options" "nosniff"
assert_header "X-Frame-Options" "DENY"

curl --connect-timeout 2 --max-time 5 --silent --show-error \
  --dump-header "$header_file" --output /dev/null "$smoke_address/api/trips"
assert_header "Cache-Control" "no-store"

header_caddy="$smoke_project-header-caddy"
docker run --detach --name "$header_caddy" \
  --network "${smoke_project}_edge" \
  --publish "127.0.0.1:$tls_test_port:443" \
  --env SITE_ADDRESS=https://localhost \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --read-only \
  --tmpfs /tmp:size=32m,mode=1777 \
  --tmpfs /data:size=64m,mode=0700 \
  --tmpfs /config:size=16m,mode=0700 \
  --volume "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d \
  >/dev/null
attempts=0
until curl --insecure --connect-timeout 2 --max-time 5 --fail --silent \
  --dump-header "$header_file" --output /dev/null "https://localhost:$tls_test_port/"; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    docker logs "$header_caddy"
    exit 1
  fi
  sleep 1
done
assert_header "Strict-Transport-Security" "max-age=31536000"
docker rm --force "$header_caddy" >/dev/null
header_caddy=""

for service in api web worker caddy; do
  container=$(compose ps --quiet "$service")
  [ -n "$container" ] || {
    echo "$service container is missing" >&2
    exit 1
  }
  docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container" |
    grep --fixed-strings 'no-new-privileges:true' >/dev/null
  docker inspect --format '{{json .HostConfig.CapDrop}}' "$container" |
    grep --fixed-strings 'ALL' >/dev/null
  [ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ]
  [ "$(docker inspect --format '{{.HostConfig.Memory}}' "$container")" -gt 0 ]
  [ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" -gt 0 ]
done
caddy_container=$(compose ps --quiet caddy)
docker inspect --format '{{json .HostConfig.CapAdd}}' "$caddy_container" |
  grep --fixed-strings 'NET_BIND_SERVICE' >/dev/null
caddy_networks=$(docker inspect \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
  "$caddy_container")
case "$caddy_networks" in
  *"${smoke_project}_edge"*) ;;
  *) echo "Caddy is not attached to the edge network" >&2; exit 1 ;;
esac
case "$caddy_networks" in
  *"${smoke_project}_private"*)
    echo "Caddy must not be attached to the private data network" >&2
    exit 1
    ;;
esac

[ "$(compose exec --no-TTY api stat -c '%u:%g' /app/apps/api/src/server.ts)" = "0:0" ]
[ "$(compose exec --no-TTY web stat -c '%u:%g' /app/apps/web/server.ts)" = "0:0" ]

app_sql "$APP_DATABASE_PASSWORD" \
  "SELECT count(*) FROM spatial_ref_sys" >/dev/null
assert_app_sql_rejected "SELECT * FROM kysely_migration LIMIT 1"
assert_app_sql_rejected \
  "UPDATE spatial_ref_sys SET srtext = srtext WHERE srid = -999999"

backup_release="$operations_root/releases/smoke"
backup_env="$operations_root/shared/env/smoke.env"
mkdir -p "$backup_release/infra/postgres"
cp compose.yaml "$backup_release/compose.yaml"
cp infra/postgres/provision-app-role.sh "$backup_release/infra/postgres/"
{
  printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
  printf 'POSTGRES_ADMIN_USER=%s\n' "$POSTGRES_ADMIN_USER"
  printf 'POSTGRES_ADMIN_PASSWORD=%s\n' "$POSTGRES_ADMIN_PASSWORD"
  printf 'APP_DATABASE_USER=%s\n' "$APP_DATABASE_USER"
  printf 'APP_DATABASE_PASSWORD=%s\n' "$APP_DATABASE_PASSWORD"
  printf 'SITE_ADDRESS=%s\n' "$SITE_ADDRESS"
  printf 'BOOTSTRAP_OWNER_EMAIL=%s\n' "$BOOTSTRAP_OWNER_EMAIL"
  printf 'SMTP_HOST=%s\n' "$SMTP_HOST"
  printf 'SMTP_PORT=%s\n' "$SMTP_PORT"
  printf 'EMAIL_FROM=%s\n' "$EMAIL_FROM"
  printf 'SMTP_SECURE=%s\n' "$SMTP_SECURE"
  printf 'SMTP_REQUIRE_TLS=%s\n' "$SMTP_REQUIRE_TLS"
  printf 'SMTP_USERNAME=%s\n' "$SMTP_USERNAME"
  printf 'SMTP_PASSWORD=%s\n' "$SMTP_PASSWORD"
  printf 'TOKEN_SECRET=%s\n' "$TOKEN_SECRET"
  printf 'RELEASE_IMAGE_TAG=%s\n' "$RELEASE_IMAGE_TAG"
} >"$backup_env"
chmod 600 "$backup_env"
ln -s "$backup_release" "$operations_root/current"
ln -s "$backup_env" "$operations_root/current-env"
old_backup="$operations_root/backups/along-the-way-20200101T000000Z.dump"
printf 'expired\n' >"$old_backup"
touch -t 202001010000 "$old_backup"
COMPOSE_PROJECT_NAME="$smoke_project" APP_ROOT="$operations_root" \
  sh infra/lightsail/backup-database.sh >/dev/null
[ ! -e "$old_backup" ]
set -- "$operations_root"/backups/along-the-way-*.dump
[ -f "$1" ]
[ "$(find "$1" -perm 600 -print)" = "$1" ]
compose run --rm --no-deps --no-TTY provision-app-role pg_restore --list <"$1" >/dev/null

# The worker-heartbeat, future-migration and rollback drill below checks release operations.

compose stop worker
compose exec --no-TTY db psql \
  --username "$POSTGRES_ADMIN_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --command "UPDATE worker_heartbeats SET last_seen_at = now() - interval '10 minutes' WHERE worker_name = 'email_delivery'"
if curl --connect-timeout 2 --max-time 5 --fail --silent \
  "$smoke_address/ready" >/dev/null 2>&1; then
  echo "Readiness stayed healthy with a stale worker heartbeat" >&2
  exit 1
fi
compose start worker
wait_for_ready

# Exercise the production cutover from the pre-hardening release. Its
# unconditional Mailpit container must be removed by activation, then restored
# when rolling back to that retained release.
docker image tag \
  "along-the-way-api:$RELEASE_IMAGE_TAG" \
  "along-the-way-api:$rollback_previous_tag"
docker image tag \
  "along-the-way-web:$RELEASE_IMAGE_TAG" \
  "along-the-way-web:$rollback_previous_tag"

rollback_root=$(mktemp -d "${TMPDIR:-/tmp}/along-the-way-rollback.XXXXXX")
if [ "$APP_DATABASE_PASSWORD" = "$rollback_previous_password" ]; then
  echo "Current and previous app passwords must differ" >&2
  exit 1
fi
for release in current-test previous-test; do
  release_dir="$rollback_root/releases/$release"
  mkdir -p "$release_dir/infra/postgres"
  cp compose.yaml Caddyfile "$release_dir/"
  cp infra/postgres/provision-app-role.sh "$release_dir/infra/postgres/"
done
new_release="$rollback_root/releases/current-test"
old_release="$rollback_root/releases/previous-test"
mkdir -p "$new_release/infra/lightsail"
cp infra/lightsail/activate-release.sh \
  infra/lightsail/backup-database.sh \
  infra/lightsail/install-backup-timer.sh \
  infra/lightsail/prune-release-env.sh \
  "$new_release/infra/lightsail/"
cp package.json bun.lock tsconfig.json .dockerignore "$new_release/"
cp -R apps packages "$new_release/"
cp scripts/fixtures/pre-hardening-compose.yaml "$old_release/compose.yaml"
mkdir -p "$rollback_root/shared/env"

write_release_environment() {
  environment_file="$1"
  image_tag="$2"
  app_password="$3"
  {
    printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
    printf 'POSTGRES_ADMIN_USER=%s\n' "$POSTGRES_ADMIN_USER"
    printf 'POSTGRES_ADMIN_PASSWORD=%s\n' "$POSTGRES_ADMIN_PASSWORD"
    printf 'APP_DATABASE_USER=%s\n' "$APP_DATABASE_USER"
    printf 'APP_DATABASE_PASSWORD=%s\n' "$app_password"
    printf 'SITE_ADDRESS=%s\n' "$SITE_ADDRESS"
    printf 'BOOTSTRAP_OWNER_EMAIL=%s\n' "$BOOTSTRAP_OWNER_EMAIL"
    printf 'SMTP_HOST=%s\n' "$SMTP_HOST"
    printf 'SMTP_PORT=%s\n' "$SMTP_PORT"
    printf 'EMAIL_FROM=%s\n' "$EMAIL_FROM"
    printf 'SMTP_SECURE=%s\n' "$SMTP_SECURE"
    printf 'SMTP_REQUIRE_TLS=%s\n' "$SMTP_REQUIRE_TLS"
    printf 'SMTP_USERNAME=%s\n' "$SMTP_USERNAME"
    printf 'SMTP_PASSWORD=%s\n' "$SMTP_PASSWORD"
    printf 'TOKEN_SECRET=%s\n' "$TOKEN_SECRET"
    printf 'RELEASE_IMAGE_TAG=%s\n' "$image_tag"
  } >"$environment_file"
  chmod 600 "$environment_file"
}

current_env="$rollback_root/shared/env/current-test.env"
previous_env="$rollback_root/shared/env/previous-test.env"
write_release_environment \
  "$current_env" "$RELEASE_IMAGE_TAG" "$APP_DATABASE_PASSWORD"
write_release_environment \
  "$previous_env" "$rollback_previous_tag" "$rollback_previous_password"

old_compose() {
  docker compose \
    --project-name "$smoke_project" \
    --env-file "$previous_env" \
    --file "$old_release/compose.yaml" \
    "$@"
}

# Begin in the production state that existed before Mailpit gained a profile.
old_compose run --rm --no-deps provision-app-role
old_compose up --detach --no-build --no-deps --wait --wait-timeout 180 \
  api web caddy worker mailpit
wait_for_ready
legacy_mailpit_container=$(old_compose ps --quiet mailpit)
[ -n "$legacy_mailpit_container" ] || {
  echo "Pre-hardening stack did not start Mailpit" >&2
  exit 1
}
[ "$(docker inspect --format '{{.State.Running}}' "$legacy_mailpit_container")" = \
  "true" ]

ln -s "$old_release" "$rollback_root/current"
ln -s "$previous_env" "$rollback_root/current-env"

mkdir -p "$rollback_root/systemd" "$rollback_root/fake-bin"
cat >"$rollback_root/fake-bin/sudo" <<'EOF'
#!/usr/bin/env sh
# Activation uses non-interactive sudo; the stand-in runs the command as is.
[ "${1:-}" = "-n" ] && shift
exec "$@"
EOF
chmod 700 "$rollback_root/fake-bin/sudo"

activate_new_release() {
  COMPOSE_PROJECT_NAME="$smoke_project" \
    APP_ROOT="$rollback_root" \
    READY_ADDRESS="$smoke_address" \
    PATH="$rollback_root/fake-bin:$PATH" \
    SYSTEMD_UNIT_DIR="$rollback_root/systemd" \
    SYSTEMCTL_COMMAND=true \
    sh infra/lightsail/activate-release.sh current-test
}

activate_new_release

[ "$(readlink -f "$rollback_root/current")" = "$(readlink -f "$new_release")" ]
wait_for_ready
if docker inspect "$legacy_mailpit_container" >/dev/null 2>&1; then
  echo "Activation left the pre-hardening Mailpit container behind" >&2
  exit 1
fi
active_mailpit=$(docker compose \
  --profile local \
  --project-name "$smoke_project" \
  --env-file "$current_env" \
  --file "$new_release/compose.yaml" \
  ps --all --quiet mailpit)
[ -z "$active_mailpit" ] || {
  echo "Activation left a Mailpit service container in production" >&2
  exit 1
}

# Re-activation proves the targeted removal is harmless when Mailpit is absent.
activate_new_release
wait_for_ready

# Simulate a later additive migration that the retained release does not know.
# Its migrator rejects that state, while migration-free rollback still works.
compose exec --no-TTY db psql \
  --username "$POSTGRES_ADMIN_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO kysely_migration (name, timestamp) VALUES ('999_future_expand', '2099-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING"

if compose run --rm --no-deps migrate >/dev/null 2>&1; then
  echo "Expected the old migrator to reject a future migration" >&2
  exit 1
fi

COMPOSE_PROJECT_NAME="$smoke_project" APP_ROOT="$rollback_root" \
  READY_ADDRESS="$smoke_address" sh infra/lightsail/rollback-release.sh

[ "$(readlink -f "$rollback_root/current")" = "$(readlink -f "$old_release")" ]

rollback_api_container=$(compose ps --quiet api)
[ -n "$rollback_api_container" ] || {
  echo "Rollback did not leave an API container running" >&2
  exit 1
}
[ "$(docker inspect --format '{{.Config.Image}}' "$rollback_api_container")" = \
  "along-the-way-api:$rollback_previous_tag" ] || {
  echo "Rollback API is not using the previous release image" >&2
  exit 1
}
rollback_api_networks=$(docker inspect \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
  "$rollback_api_container")
case "$rollback_api_networks" in
  *"${smoke_project}_private"*) ;;
  *) echo "Legacy rollback API did not join the shared private network" >&2; exit 1 ;;
esac

rollback_mailpit_container=$(old_compose ps --quiet mailpit)
[ -n "$rollback_mailpit_container" ] || {
  echo "Rollback did not restore the previous release's Mailpit" >&2
  exit 1
}
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  "http://localhost:$MAILPIT_HTTP_PORT/" >/dev/null

app_password_connects "$rollback_previous_password" >/dev/null

if app_password_connects "$APP_DATABASE_PASSWORD" >/dev/null 2>&1; then
  echo "Rollback left the current app password active" >&2
  exit 1
fi

assert_private_api

compose restart db api worker
wait_for_ready

assert_private_api
