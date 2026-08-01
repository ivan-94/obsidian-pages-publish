#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
mode="blank"
action="${1:-info}"

print_summary() {
  local status="$1"
  cat <<EOF
HAT_PREPARE_SUMMARY
mode=$mode
status=$status
app_url=Obsidian desktop manual launch
database=not-applicable
schema_version=site.yml v1; publication v1
seed_records=not-applicable; use a new local Vault
cleanup=manual: remove the created test Vault and release/ package when finished
guide=./guide.md
END_HAT_PREPARE_SUMMARY
EOF
}

case "$action" in
  info)
    printf 'HAT S17 release candidate\n'
    printf 'repo=%s\n' "$repo_root"
    printf 'node=%s\n' "$(node --version)"
    printf 'package_command=npm run package\n'
    printf 'external_actions=none\n'
    print_summary "not-run"
    ;;
  prepare)
    (
      cd "$repo_root"
      npm run package
    )
    print_summary "prepared"
    ;;
  cleanup)
    printf 'No external or user-Vault data is removed automatically.\n'
    printf 'Manually delete only the dedicated test Vault and the generated release/ directory if desired.\n'
    print_summary "manual-cleanup-required"
    ;;
  *)
    printf 'Usage: %s [info|prepare|cleanup]\n' "$0" >&2
    exit 64
    ;;
esac
