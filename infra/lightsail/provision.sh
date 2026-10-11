#!/usr/bin/env sh
set -eu

aws_region="${AWS_REGION:-ap-east-1}"
instance_name="${INSTANCE_NAME:-along-the-way-staging}"
static_ip_name="${STATIC_IP_NAME:-along-the-way-staging-ip}"
bundle_id="${BUNDLE_ID:-micro_3_0}"
admin_cidr="${ADMIN_CIDR:?Set ADMIN_CIDR to your public IP, for example 203.0.113.10/32}"
key_pair_name="${KEY_PAIR_NAME:-}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

command -v aws >/dev/null 2>&1 || {
  echo "AWS CLI v2 is required" >&2
  exit 1
}

blueprint_id="${BLUEPRINT_ID:-}"
if [ -z "$blueprint_id" ]; then
  blueprint_id=$(aws lightsail get-blueprints \
    --region "$aws_region" \
    --query "blueprints[?isActive && contains(name, 'Ubuntu 24')].blueprintId | [0]" \
    --output text)
fi

if [ -z "$blueprint_id" ] || [ "$blueprint_id" = "None" ]; then
  echo "No active Ubuntu 24 Lightsail blueprint found in $aws_region" >&2
  exit 1
fi

if ! aws lightsail get-instance \
  --region "$aws_region" \
  --instance-name "$instance_name" >/dev/null 2>&1; then
  set -- aws lightsail create-instances \
    --region "$aws_region" \
    --instance-names "$instance_name" \
    --availability-zone "${aws_region}a" \
    --blueprint-id "$blueprint_id" \
    --bundle-id "$bundle_id" \
    --ip-address-type dualstack \
    --user-data "file://$script_dir/bootstrap.sh" \
    --tags key=project,value=along-the-way key=environment,value=staging

  if [ -n "$key_pair_name" ]; then
    set -- "$@" --key-pair-name "$key_pair_name"
  fi

  "$@" >/dev/null
fi

attempts=0
until [ "$(aws lightsail get-instance \
  --region "$aws_region" \
  --instance-name "$instance_name" \
  --query 'instance.state.name' \
  --output text)" = "running" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo "Timed out waiting for the Lightsail instance" >&2
    exit 1
  fi
  sleep 5
done

if ! aws lightsail get-static-ip \
  --region "$aws_region" \
  --static-ip-name "$static_ip_name" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip \
    --region "$aws_region" \
    --static-ip-name "$static_ip_name" >/dev/null
fi

attached_to=$(aws lightsail get-static-ip \
  --region "$aws_region" \
  --static-ip-name "$static_ip_name" \
  --query 'staticIp.attachedTo' \
  --output text)

if [ "$attached_to" != "$instance_name" ]; then
  if [ "$attached_to" != "None" ]; then
    echo "$static_ip_name is already attached to $attached_to" >&2
    exit 1
  fi
  aws lightsail attach-static-ip \
    --region "$aws_region" \
    --static-ip-name "$static_ip_name" \
    --instance-name "$instance_name" >/dev/null
fi

ports=$(printf '%s' "[
  {\"fromPort\":22,\"toPort\":22,\"protocol\":\"tcp\",\"cidrs\":[\"$admin_cidr\"],\"cidrListAliases\":[\"lightsail-connect\"]},
  {\"fromPort\":80,\"toPort\":80,\"protocol\":\"tcp\",\"cidrs\":[\"0.0.0.0/0\"],\"ipv6Cidrs\":[\"::/0\"]},
  {\"fromPort\":443,\"toPort\":443,\"protocol\":\"tcp\",\"cidrs\":[\"0.0.0.0/0\"],\"ipv6Cidrs\":[\"::/0\"]}
]")

aws lightsail put-instance-public-ports \
  --region "$aws_region" \
  --instance-name "$instance_name" \
  --port-infos "$ports" >/dev/null

static_ip=$(aws lightsail get-static-ip \
  --region "$aws_region" \
  --static-ip-name "$static_ip_name" \
  --query 'staticIp.ipAddress' \
  --output text)
sslip_host=$(printf '%s' "$static_ip" | tr '.' '-')

printf 'Instance: %s\nStatic IP: %s\nStaging URL: https://%s.sslip.io\n' \
  "$instance_name" "$static_ip" "$sslip_host"
