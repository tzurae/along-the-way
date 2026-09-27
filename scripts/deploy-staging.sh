#!/usr/bin/env sh
set -eu

staging_host="${STAGING_HOST:?Set STAGING_HOST}"
ssh_key_file="${STAGING_SSH_KEY_FILE:?Set STAGING_SSH_KEY_FILE}"
release_id="${RELEASE_ID:?Set RELEASE_ID}"
staging_env_file="${STAGING_ENV_FILE:?Set STAGING_ENV_FILE}"
ssh_user="${STAGING_SSH_USER:-ubuntu}"

case "$release_id" in
  *[!A-Za-z0-9._-]*)
    echo "Invalid release id" >&2
    exit 1
    ;;
esac

archive=$(mktemp "${TMPDIR:-/tmp}/along-the-way.XXXXXX.tar.gz")
archive_name="along-the-way-$release_id.tar.gz"
remote="${ssh_user}@${staging_host}"

cleanup() {
  rm -f "$archive"
}
trap cleanup EXIT

git archive --format=tar.gz --output "$archive" HEAD

ssh -i "$ssh_key_file" "$remote" \
  "test ! -e '/opt/along-the-way/releases/$release_id' && \
   test ! -e '/opt/along-the-way/shared/env/$release_id.env' && \
   install -d '/opt/along-the-way/releases/$release_id' '/opt/along-the-way/shared/env'"

scp -i "$ssh_key_file" "$archive" "$remote:/tmp/$archive_name"
scp -i "$ssh_key_file" "$staging_env_file" "$remote:/tmp/along-the-way.env"

ssh -i "$ssh_key_file" "$remote" \
  "tar -xzf '/tmp/$archive_name' -C '/opt/along-the-way/releases/$release_id' && \
   install -m 600 '/tmp/along-the-way.env' '/opt/along-the-way/shared/env/$release_id.env' && \
   rm -f '/tmp/$archive_name' '/tmp/along-the-way.env' && \
   sh '/opt/along-the-way/releases/$release_id/infra/lightsail/activate-release.sh' '$release_id'"
