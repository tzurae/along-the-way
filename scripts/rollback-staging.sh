#!/usr/bin/env sh
set -eu

staging_host="${STAGING_HOST:?Set STAGING_HOST}"
ssh_key_file="${STAGING_SSH_KEY_FILE:?Set STAGING_SSH_KEY_FILE}"
ssh_user="${STAGING_SSH_USER:-ubuntu}"

ssh -i "$ssh_key_file" "${ssh_user}@${staging_host}" \
  "sh /opt/along-the-way/current/infra/lightsail/rollback-release.sh"
