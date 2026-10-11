#!/usr/bin/env sh
set -eu

repository="${GITHUB_REPOSITORY:-tzurae/along-the-way}"
environment_name="staging"

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI is required" >&2
  exit 1
}

printf '%s' '{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}' | gh api \
  --method PUT \
  "repos/$repository/environments/$environment_name" \
  --input - >/dev/null

main_policy=$(gh api \
  "repos/$repository/environments/$environment_name/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.name == "main") | .id')

if [ -z "$main_policy" ]; then
  gh api \
    --method POST \
    "repos/$repository/environments/$environment_name/deployment-branch-policies" \
    --field name=main >/dev/null
fi

printf 'Restricted the %s environment to the main branch.\n' "$environment_name"
