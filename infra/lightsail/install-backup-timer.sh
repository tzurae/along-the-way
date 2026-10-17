#!/usr/bin/env sh
set -eu

app_root="${APP_ROOT:-/opt/along-the-way}"
unit_dir="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
systemctl_command="${SYSTEMCTL_COMMAND:-systemctl}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin_dir="$app_root/bin"
backup_dir="$app_root/backups"
service_unit="$unit_dir/along-the-way-backup.service"
timer_unit="$unit_dir/along-the-way-backup.timer"

install -d -m 700 "$bin_dir" "$backup_dir"
install -m 700 "$script_dir/backup-database.sh" "$bin_dir/backup-database.sh"

service_tmp=$(mktemp "${TMPDIR:-/tmp}/along-the-way-backup.service.XXXXXX")
timer_tmp=$(mktemp "${TMPDIR:-/tmp}/along-the-way-backup.timer.XXXXXX")
cleanup() {
  rm -f "$service_tmp" "$timer_tmp"
}
trap cleanup EXIT HUP INT TERM

cat >"$service_tmp" <<EOF
[Unit]
Description=Along the Way nightly PostgreSQL backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
Environment=APP_ROOT=$app_root
ExecStart=$bin_dir/backup-database.sh
UMask=0077
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$backup_dir
EOF

cat >"$timer_tmp" <<'EOF'
[Unit]
Description=Run the Along the Way PostgreSQL backup nightly

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
RandomizedDelaySec=30m
AccuracySec=1m
Unit=along-the-way-backup.service

[Install]
WantedBy=timers.target
EOF

install -d -m 755 "$unit_dir"
install -m 644 "$service_tmp" "$service_unit"
install -m 644 "$timer_tmp" "$timer_unit"
cleanup
trap - EXIT HUP INT TERM

"$systemctl_command" daemon-reload
"$systemctl_command" enable --now along-the-way-backup.timer
