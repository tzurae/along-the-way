#!/usr/bin/env sh
set -eu

app_root="${APP_ROOT:-/opt/along-the-way}"
backup_dir="$app_root/backups"
current_release=$(readlink -f "$app_root/current")
current_env=$(readlink -f "$app_root/current-env")

[ -f "$current_release/compose.yaml" ] || {
  echo "Current release is incomplete" >&2
  exit 1
}
[ -f "$current_env" ] || {
  echo "Current environment file is missing" >&2
  exit 1
}
[ -d "$backup_dir" ] || {
  echo "Backup directory is missing" >&2
  exit 1
}

read_env() {
  key="$1"
  sed -n "s/^${key}=//p" "$current_env" | tail -n 1
}

admin_user=$(read_env POSTGRES_ADMIN_USER)
database=$(read_env POSTGRES_DB)
[ -n "$admin_user" ] || {
  echo "POSTGRES_ADMIN_USER is missing" >&2
  exit 1
}
[ -n "$database" ] || {
  echo "POSTGRES_DB is missing" >&2
  exit 1
}

umask 077
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$backup_dir/along-the-way-$timestamp.dump"
temporary="$backup.tmp.$$"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

# The custom pg_dump format is compressed and remains directly consumable by
# pg_restore, unlike a compressed stream that can be mistaken for plain SQL.
docker compose \
  --env-file "$current_env" \
  --file "$current_release/compose.yaml" \
  exec --no-TTY db \
  pg_dump \
    --username "$admin_user" \
    --dbname "$database" \
    --format custom \
    --compress 9 \
    --no-password >"$temporary"

chmod 600 "$temporary"
mv "$temporary" "$backup"
trap - EXIT HUP INT TERM

# find rounds age down to whole days; +13 removes files once they are at least
# fourteen complete days old.
find "$backup_dir" -type f -name 'along-the-way-*.dump' -mtime +13 -delete
printf 'Created %s\n' "$backup"
