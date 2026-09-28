#!/usr/bin/env sh
set -eu

app_root="${APP_ROOT:-/opt/along-the-way}"

[ -L "$app_root/current" ] || {
  echo "No current release" >&2
  exit 1
}
[ -L "$app_root/previous" ] || {
  echo "No previous release to restore" >&2
  exit 1
}
[ -L "$app_root/current-env" ] || {
  echo "No current environment" >&2
  exit 1
}
[ -L "$app_root/previous-env" ] || {
  echo "No previous environment to restore" >&2
  exit 1
}

current_release=$(readlink -f "$app_root/current")
previous_release=$(readlink -f "$app_root/previous")
current_env=$(readlink -f "$app_root/current-env")
previous_env=$(readlink -f "$app_root/previous-env")

image_tag() {
  sed -n 's/^RELEASE_IMAGE_TAG=//p' "$1" | tail -n 1
}

compose_for_release() {
  release="$1"
  environment_file="$2"
  shift 2

  env \
    -u POSTGRES_DB \
    -u POSTGRES_ADMIN_USER \
    -u POSTGRES_ADMIN_PASSWORD \
    -u APP_DATABASE_USER \
    -u APP_DATABASE_PASSWORD \
    -u SITE_ADDRESS \
    -u BOOTSTRAP_OWNER_EMAIL \
    -u SMTP_HOST \
    -u SMTP_PORT \
    -u EMAIL_FROM \
    -u SMTP_SECURE \
    -u SMTP_REQUIRE_TLS \
    -u SMTP_USERNAME \
    -u SMTP_PASSWORD \
    -u TOKEN_SECRET \
    -u RELEASE_IMAGE_TAG \
    docker compose \
      --env-file "$environment_file" \
      --file "$release/compose.yaml" \
      "$@"
}

require_release_images() {
  tag=$(image_tag "$1")
  case "$tag" in
    ""|*[!A-Za-z0-9._-]*)
      echo "Invalid or missing RELEASE_IMAGE_TAG in $1" >&2
      return 1
      ;;
  esac
  docker image inspect \
    "along-the-way-api:$tag" \
    "along-the-way-web:$tag" >/dev/null
}

start_without_migrations() {
  release="$1"
  environment_file="$2"
  services="api web caddy"

  if compose_for_release \
    "$release" "$environment_file" config --services | grep -qx worker; then
    services="$services worker"
  fi

  compose_for_release \
    "$release" "$environment_file" \
    run --rm --no-deps provision-app-role &&
    compose_for_release \
      "$release" "$environment_file" \
      up --detach --no-build --no-deps --wait --wait-timeout 180 \
      $services
}

stop_worker_if_present() {
  release="$1"
  environment_file="$2"
  if compose_for_release \
    "$release" "$environment_file" config --services | grep -qx worker; then
    compose_for_release "$release" "$environment_file" stop worker
  fi
}

check_ready() {
  site_address=$(sed -n 's/^SITE_ADDRESS=//p' "$1" | tail -n 1)
  [ -n "$site_address" ] && curl \
    --connect-timeout 5 \
    --max-time 10 \
    --fail \
    --retry 20 \
    --retry-all-errors \
    --retry-delay 3 \
    --silent \
    --show-error \
    "$site_address/ready" >/dev/null
}

restore_current() {
  echo "Rollback failed; restoring the current release" >&2
  start_without_migrations "$current_release" "$current_env" &&
    check_ready "$current_env"
}

# Verify both directions before changing the managed application-role password.
require_release_images "$previous_env"
require_release_images "$current_env"

stop_worker_if_present "$current_release" "$current_env"

if ! start_without_migrations "$previous_release" "$previous_env"; then
  restore_current || true
  exit 1
fi

if ! check_ready "$previous_env"; then
  restore_current || true
  exit 1
fi

ln -sfn "$previous_release" "$app_root/current"
ln -sfn "$current_release" "$app_root/previous"
ln -sfn "$previous_env" "$app_root/current-env"
ln -sfn "$current_env" "$app_root/previous-env"

printf 'Rolled back to %s\n' "$(basename "$previous_release")"
