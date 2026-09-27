#!/usr/bin/env sh
set -eu

export POSTGRES_DB="${POSTGRES_DB:-along_the_way_test}"
export POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-along_the_way_admin_test}"
export POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-ci-only-admin-secret}"
export APP_DATABASE_USER="${APP_DATABASE_USER:-along_the_way_app_test}"
export APP_DATABASE_PASSWORD="${APP_DATABASE_PASSWORD:-ci-only-app-secret}"
export SITE_ADDRESS="${SITE_ADDRESS:-http://localhost}"
smoke_project="along-the-way-smoke-${GITHUB_RUN_ID:-$$}"
export RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-$smoke_project}"
rollback_root=""
rollback_previous_tag="$smoke_project-previous"
rollback_previous_password="ci-previous-app-secret"

compose() {
  docker compose --project-name "$smoke_project" "$@"
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

cleanup() {
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
    http://localhost/ready >/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      compose ps
      compose logs api db
      return 1
    fi
    sleep 2
  done
}

compose up --detach --build --wait --wait-timeout 180
wait_for_ready

curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  http://localhost/health |
  grep --fixed-strings '"status":"ok"' >/dev/null
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  http://localhost/api/trips/hong-kong-together/summary |
  grep --fixed-strings '"title":"一起走的香港四日"' >/dev/null

# Simulate a newer release having recorded an additive migration unknown to this
# release. Its migrator must reject the state, while the migration-free rollback
# path still starts the retained application image successfully.
compose exec --no-TTY db psql \
  --username "$POSTGRES_ADMIN_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --command "INSERT INTO kysely_migration (name, timestamp) VALUES ('999_future_expand', '2099-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING"

if compose run --rm --no-deps migrate >/dev/null 2>&1; then
  echo "Expected the old migrator to reject a future migration" >&2
  exit 1
fi

compose stop api

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

ln -s "$rollback_root/releases/current-test" "$rollback_root/current"
ln -s "$rollback_root/releases/previous-test" "$rollback_root/previous"
ln -s "$current_env" "$rollback_root/current-env"
ln -s "$previous_env" "$rollback_root/previous-env"

COMPOSE_PROJECT_NAME="$smoke_project" APP_ROOT="$rollback_root" \
  sh infra/lightsail/rollback-release.sh

[ "$(readlink -f "$rollback_root/current")" = \
  "$(readlink -f "$rollback_root/releases/previous-test")" ]

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

app_password_connects "$rollback_previous_password" >/dev/null

if app_password_connects "$APP_DATABASE_PASSWORD" >/dev/null 2>&1; then
  echo "Rollback left the current app password active" >&2
  exit 1
fi

curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  http://localhost/api/trips/hong-kong-together/summary |
  grep --fixed-strings '"title":"一起走的香港四日"' >/dev/null

if [ "${RUN_BROWSER_TESTS:-0}" = "1" ]; then
  bun run test:e2e
fi

compose restart db api
wait_for_ready

curl --connect-timeout 2 --max-time 5 --fail --silent --show-error \
  http://localhost/api/trips/hong-kong-together/summary |
  grep --fixed-strings '"title":"一起走的香港四日"' >/dev/null
