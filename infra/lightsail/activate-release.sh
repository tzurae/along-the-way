#!/usr/bin/env sh
set -eu

release_id="${1:?Pass a release id}"
app_root="/opt/along-the-way"
release_dir="$app_root/releases/$release_id"
release_env="$app_root/shared/env/$release_id.env"

case "$release_id" in
  *[!A-Za-z0-9._-]*)
    echo "Invalid release id" >&2
    exit 1
    ;;
esac

[ -f "$release_dir/compose.yaml" ] || {
  echo "Release $release_id is incomplete" >&2
  exit 1
}
[ -f "$release_env" ] || {
  echo "Missing $release_env" >&2
  exit 1
}

old_release=""
old_env=""
if [ -L "$app_root/current" ]; then
  old_release=$(readlink -f "$app_root/current")
fi
if [ -L "$app_root/current-env" ]; then
  old_env=$(readlink -f "$app_root/current-env")
fi

restore_previous() {
  if [ -n "$old_release" ] && [ -f "$old_release/compose.yaml" ] && \
    [ -n "$old_env" ] && [ -f "$old_env" ]; then
    old_image_tag=$(sed -n 's/^RELEASE_IMAGE_TAG=//p' "$old_env" | tail -n 1)
    case "$old_image_tag" in
      ""|*[!A-Za-z0-9._-]*)
        echo "Invalid previous RELEASE_IMAGE_TAG" >&2
        return 1
        ;;
    esac
    if ! docker image inspect \
      "along-the-way-api:$old_image_tag" \
      "along-the-way-web:$old_image_tag" >/dev/null; then
      return 1
    fi

    if ! docker compose \
      --env-file "$old_env" \
      --file "$old_release/compose.yaml" \
      run --rm --no-deps provision-app-role; then
      return 1
    fi
    if ! docker compose \
      --env-file "$old_env" \
      --file "$old_release/compose.yaml" \
      up --detach --no-build --no-deps --wait --wait-timeout 180 \
      api web caddy; then
      return 1
    fi

    old_site_address=$(sed -n 's/^SITE_ADDRESS=//p' "$old_env" | tail -n 1)
    curl \
      --connect-timeout 5 \
      --max-time 10 \
      --fail \
      --retry 20 \
      --retry-all-errors \
      --retry-delay 3 \
      --silent \
      --show-error \
      "$old_site_address/ready" >/dev/null
  fi
}

if ! docker compose \
  --env-file "$release_env" \
  --file "$release_dir/compose.yaml" \
  up --detach --build --wait --wait-timeout 180; then
  restore_previous
  exit 1
fi

site_address=$(sed -n 's/^SITE_ADDRESS=//p' "$release_env" | tail -n 1)
if [ -z "$site_address" ] || ! curl \
  --connect-timeout 5 \
  --max-time 10 \
  --fail \
  --retry 20 \
  --retry-all-errors \
  --retry-delay 3 \
  --silent \
  --show-error \
  "$site_address/ready" >/dev/null; then
  restore_previous
  exit 1
fi

if [ -n "$old_release" ] && [ "$old_release" != "$release_dir" ]; then
  ln -sfn "$old_release" "$app_root/previous"
fi
if [ -n "$old_env" ] && [ "$old_env" != "$release_env" ]; then
  ln -sfn "$old_env" "$app_root/previous-env"
fi
ln -sfn "$release_dir" "$app_root/current"
ln -sfn "$release_env" "$app_root/current-env"

printf 'Activated %s at %s\n' "$release_id" "$site_address"
