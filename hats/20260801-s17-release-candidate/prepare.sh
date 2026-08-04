#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
mode="blank"
action="${1:-info}"
requested_test_vault="${PAGES_PUBLISH_HAT_TEST_VAULT:-}"
if [[ -n "$requested_test_vault" ]]; then
  if [[ "${PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT:-}" != "1" ]]; then
    printf 'Refusing an external test Vault without PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT=1.\n' >&2
    exit 64
  fi
  if [[ -L "$requested_test_vault" ]]; then
    printf 'Refusing a symbolic-link test Vault: %s\n' "$requested_test_vault" >&2
    exit 64
  fi
  test_vault="$(cd -- "$(dirname -- "$requested_test_vault")" && pwd -P)/$(basename -- "$requested_test_vault")"
else
  test_vault="$script_dir/test-vault"
fi
if [[ -L "$test_vault" ]]; then
  printf 'Refusing a symbolic-link test Vault: %s\n' "$test_vault" >&2
  exit 64
fi
test_vault_marker="$test_vault/.pages-publish-s17-test-vault"
candidate_directory="${PAGES_PUBLISH_HAT_CANDIDATE_DIRECTORY:-}"
preflight_error=""

if [[ -z "$candidate_directory" ]]; then
  if candidate_version="$(node --input-type=module -e "import { readFile } from 'node:fs/promises'; process.stdout.write(JSON.parse(await readFile(process.argv[1], 'utf8')).version)" "$repo_root/manifest.json")"; then
    candidate_directory="$repo_root/release/pages-publish-$candidate_version"
  else
    candidate_directory=""
    preflight_error="Could not determine the candidate package version from manifest.json."
  fi
fi

prepared_environment_exists() {
  [[ -d "$test_vault" && ! -L "$test_vault" && -f "$test_vault_marker" && ! -L "$test_vault_marker" ]] || return 1
  local required_fixture
  for required_fixture in .obsidian/app.json notes/public.md notes/unlisted.md notes/private.md; do
    [[ -s "$test_vault/$required_fixture" && ! -L "$test_vault/$required_fixture" ]] || return 1
  done

  [[ -d "$candidate_directory" && ! -L "$candidate_directory" ]] || return 1
  local required_file
  for required_file in main.js manifest.json styles.css; do
    [[ -s "$candidate_directory/$required_file" && ! -L "$candidate_directory/$required_file" ]] || return 1
  done
  local entry_count
  entry_count="$(find "$candidate_directory" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')"
  [[ "$entry_count" == "3" ]] || return 1

  node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    const candidate = JSON.parse(await readFile(process.argv[1], "utf8"));
    const source = JSON.parse(await readFile(process.argv[2], "utf8"));
    const required = ["id", "version", "minAppVersion"];
    if (!required.every((key) => candidate[key] === source[key])) process.exit(1);
  ' "$candidate_directory/manifest.json" "$repo_root/manifest.json"
}

create_test_vault() {
  if [[ -e "$test_vault" && ! -f "$test_vault_marker" ]]; then
    printf 'Refusing to initialise an unrecognised test Vault: %s\n' "$test_vault" >&2
    return 1
  fi
  if [[ -f "$test_vault_marker" ]]; then
    printf 'S17 test Vault already exists; preserving its current contents.\n'
    return 0
  fi

  mkdir -p "$test_vault/.obsidian" "$test_vault/notes"
  printf '%s\n' \
    '{' \
    '  "alwaysUpdateLinks": true,' \
    '  "showLineNumber": true' \
    '}' > "$test_vault/.obsidian/app.json"
  printf '%s\n' \
    '---' \
    'publication:' \
    '  visibility: public' \
    '---' \
    '' \
    '# S17 public article' \
    '' \
    'This public fixture links to [[private|the author-supplied label]].' > "$test_vault/notes/public.md"
  printf '%s\n' \
    '---' \
    'publication:' \
    '  visibility: unlisted' \
    '---' \
    '' \
    '# S17 unlisted article' \
    '' \
    'This page must be reachable only by its direct published URL.' > "$test_vault/notes/unlisted.md"
  printf '%s\n' \
    '---' \
    'publication:' \
    '  visibility: private' \
    '---' \
    '' \
    '# S17 private article' \
    '' \
    'This private body must never enter any published output, search index, graph, or sitemap.' > "$test_vault/notes/private.md"
  printf '%s\n' \
    'S17 isolated test Vault.' \
    'No credentials, production notes, or Cloudflare responses may be stored here.' > "$test_vault/README.md"
  : > "$test_vault_marker"
  printf 'Created S17 test Vault at %s\n' "$test_vault"
}

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
test_vault=$test_vault
cleanup=manual: remove the created test Vault and release/ package when finished
guide=$script_dir/guide.md
END_HAT_PREPARE_SUMMARY
EOF
}

case "$action" in
  info)
    if [[ -n "$preflight_error" ]]; then
      printf '%s\n' "$preflight_error" >&2
      print_summary "not-run"
      exit 1
    fi
    printf 'HAT S17 release candidate\n'
    printf 'repo=%s\n' "$repo_root"
    printf 'node=%s\n' "$(node --version)"
    printf 'package_command=npm run package\n'
    printf 'external_actions=none\n'
    if prepared_environment_exists; then
      print_summary "prepared"
    else
      print_summary "not-run"
    fi
    ;;
  prepare)
    if [[ -n "$preflight_error" ]]; then
      printf '%s\n' "$preflight_error" >&2
      print_summary "not-run"
      exit 1
    fi
    if ! (
      cd "$repo_root"
      npm run package
    ); then
      printf 'Candidate packaging failed; no test Vault was created or changed.\n' >&2
      print_summary "not-run"
      exit 1
    fi
    if ! create_test_vault; then
      print_summary "not-run"
      exit 1
    fi
    if prepared_environment_exists; then
      print_summary "prepared"
    else
      printf 'Prepared candidate package could not be verified safely.\n' >&2
      print_summary "not-run"
      exit 1
    fi
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
