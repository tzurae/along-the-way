#!/usr/bin/env sh
set -eu

umask 077
app_root="${APP_ROOT:-/opt/along-the-way}"
current_stage=""
current_backup=""
previous_stage=""
previous_backup=""

cleanup() {
  [ -z "$current_stage" ] || rm -f "$current_stage"
  [ -z "$current_backup" ] || rm -f "$current_backup"
  [ -z "$previous_stage" ] || rm -f "$previous_stage"
  [ -z "$previous_backup" ] || rm -f "$previous_backup"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -n "${NEW_POSTGRES_ADMIN_PASSWORD:-}" ]; then
  new_password="$NEW_POSTGRES_ADMIN_PASSWORD"
else
  IFS= read -r new_password
fi

case "$new_password" in
  ""|*[!A-Za-z0-9._-]*)
    echo "The new password must be non-empty and URL-safe" >&2
    exit 1
    ;;
esac

[ -L "$app_root/current" ] || {
  echo "No current release" >&2
  exit 1
}
[ -L "$app_root/current-env" ] || {
  echo "No current environment" >&2
  exit 1
}

current_release=$(readlink -f "$app_root/current")
current_env=$(readlink -f "$app_root/current-env")
admin_user=$(sed -n 's/^POSTGRES_ADMIN_USER=//p' "$current_env" | tail -n 1)
database_name=$(sed -n 's/^POSTGRES_DB=//p' "$current_env" | tail -n 1)
old_password=$(sed -n 's/^POSTGRES_ADMIN_PASSWORD=//p' "$current_env" | tail -n 1)
previous_env=""

[ -n "$admin_user" ] && [ -n "$database_name" ] && [ -n "$old_password" ] || {
  echo "Current environment is missing database administration settings" >&2
  exit 1
}

if [ -L "$app_root/previous-env" ]; then
  previous_env=$(readlink -f "$app_root/previous-env")
  if [ "$previous_env" = "$current_env" ]; then
    previous_env=""
  fi
fi

validate_environment_path() {
  case "$1" in
    "$app_root/shared/env/"*) ;;
    *)
      echo "Refusing to edit an environment outside $app_root/shared/env" >&2
      exit 1
      ;;
  esac
}

stage_environment() {
  source_file="$1"
  staged_file="$2"

  awk -v password="$new_password" '
    /^POSTGRES_ADMIN_PASSWORD=/ {
      print "POSTGRES_ADMIN_PASSWORD=" password
      found += 1
      next
    }
    { print }
    END { if (found != 1) exit 1 }
  ' "$source_file" >"$staged_file"
  chmod 600 "$staged_file"
}

rotate_database_password() {
  password="$1"

  {
    printf "\\set new_password '%s'\n" "$password"
    printf '%s\n' \
      "SELECT format('ALTER ROLE %I PASSWORD %L', current_user, :'new_password')" \
      '\gexec'
  } | docker compose \
    --env-file "$current_env" \
    --file "$current_release/compose.yaml" \
    exec --no-TTY db psql \
    --username "$admin_user" \
    --dbname "$database_name" \
    --set ON_ERROR_STOP=1
}

validate_environment_path "$current_env"
current_stage=$(mktemp "${current_env}.rotate.XXXXXX")
current_backup=$(mktemp "${current_env}.backup.XXXXXX")
cp "$current_env" "$current_backup"
stage_environment "$current_env" "$current_stage"

if [ -n "$previous_env" ]; then
  validate_environment_path "$previous_env"
  previous_stage=$(mktemp "${previous_env}.rotate.XXXXXX")
  previous_backup=$(mktemp "${previous_env}.backup.XXXXXX")
  cp "$previous_env" "$previous_backup"
  stage_environment "$previous_env" "$previous_stage"
fi

rotate_database_password "$new_password"

replacement_failed=0
if ! mv "$current_stage" "$current_env"; then
  replacement_failed=1
else
  current_stage=""
fi

if [ -n "$previous_env" ]; then
  if ! mv "$previous_stage" "$previous_env"; then
    replacement_failed=1
  else
    previous_stage=""
  fi
fi

if [ "$replacement_failed" -ne 0 ]; then
  echo "Environment replacement failed; restoring the prior credential" >&2
  rotate_database_password "$old_password" || true
  cp "$current_backup" "$current_env"
  if [ -n "$previous_env" ]; then
    cp "$previous_backup" "$previous_env"
  fi
  exit 1
fi

printf '%s\n' \
  "Database credential rotated. Update STAGING_POSTGRES_ADMIN_PASSWORD before the next deployment."
