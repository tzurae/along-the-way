#!/usr/bin/env sh
set -eu

app_root="${APP_ROOT:-/opt/along-the-way}"
env_dir="$app_root/shared/env"
[ -d "$env_dir" ] || exit 0
env_dir=$(CDPATH= cd -- "$env_dir" && pwd -P)

protected_target() {
  link="$1"
  [ -L "$link" ] || return 0
  target=$(readlink -f "$link") || return 0
  case "$target" in
    "$env_dir"/*.env)
      [ -f "$target" ] && printf '%s\n' "$target"
      ;;
  esac
}

current_env=$(protected_target "$app_root/current-env")
previous_env=$(protected_target "$app_root/previous-env")

set -- "$env_dir"/*.env
[ -e "$1" ] || exit 0

# Pointer targets survive even when failed deployments created newer files.
# Fill the remaining slots with the newest unreferenced release environments.
kept=0
[ -n "$current_env" ] && kept=$((kept + 1))
if [ -n "$previous_env" ] && [ "$previous_env" != "$current_env" ]; then
  kept=$((kept + 1))
fi
LC_ALL=C ls -1t -- "$@" | while IFS= read -r env_file; do
  if [ "$env_file" = "$current_env" ] || [ "$env_file" = "$previous_env" ]; then
    continue
  fi
  if [ "$kept" -lt 3 ]; then
    kept=$((kept + 1))
  else
    rm -f -- "$env_file" "${env_file%.env}.gcp-monitoring.json"
  fi
done
