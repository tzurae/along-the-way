#!/usr/bin/env sh
set -eu

export DEBIAN_FRONTEND=noninteractive
deploy_user="${DEPLOY_USER:-ubuntu}"

apt-get update
apt-get install --yes ca-certificates curl docker.io docker-compose-v2 ufw
systemctl enable --now docker
usermod --append --groups docker "$deploy_user"

install --directory --owner "$deploy_user" --group "$deploy_user" \
  /opt/along-the-way \
  /opt/along-the-way/releases \
  /opt/along-the-way/shared \
  /opt/along-the-way/shared/env

if [ ! -f /swapfile ]; then
  fallocate --length 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
