#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if repo_candidate="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"; then
  repo_root="$(cd -- "$repo_candidate" && pwd -P)"
else
  repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
fi
test_vault="$script_dir/test-vault"
marker="$test_vault/.pages-publish-custom-theme-hat-v1"
theme_root="$repo_root/external-themes/brutalist"
theme_archive="$theme_root/artifacts/pages-publish-theme-brutalist-1.0.0.tgz"
action="${1:-info}"
mode="blank"

candidate_version() {
  node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    process.stdout.write(JSON.parse(await readFile(process.argv[1], "utf8")).version);
  ' "$repo_root/manifest.json"
}

candidate_directory() {
  printf '%s/release/pages-publish-%s' "$repo_root" "$(candidate_version)"
}

theme_integrity() {
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFile } from "node:fs/promises";
    const bytes = await readFile(process.argv[1]);
    process.stdout.write(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  ' "$theme_archive"
}

theme_artifact_name() {
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    process.stdout.write(`theme-${createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 20)}.tgz`);
  ' "$1"
}

prepared() {
  local candidate integrity artifact_name
  candidate="$(candidate_directory)"
  [[ -d "$test_vault" && ! -L "$test_vault" && -f "$marker" && ! -L "$marker" ]] || return 1
  [[ -s "$theme_archive" && ! -L "$theme_archive" ]] || return 1
  integrity="$(theme_integrity)"
  artifact_name="$(theme_artifact_name "$integrity")"
  [[ -s "$test_vault/.publish/themes/$artifact_name" && ! -L "$test_vault/.publish/themes/$artifact_name" ]] || return 1
  cmp -s "$theme_archive" "$test_vault/.publish/themes/$artifact_name" || return 1
  grep -Fq "$integrity" "$test_vault/.publish/site.yml" || return 1
  local fixture
  for fixture in notes/field-note.md notes/second.md notes/hidden.md notes/private.md; do
    [[ -s "$test_vault/$fixture" && ! -L "$test_vault/$fixture" ]] || return 1
  done
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(find "$candidate" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" == "3" ]] || return 1
}

create_vault() {
  if [[ -e "$test_vault" && ! -f "$marker" ]]; then
    printf 'Refusing to modify an unrecognised Vault: %s\n' "$test_vault" >&2
    return 1
  fi
  if [[ -f "$marker" ]]; then
    printf 'Custom theme HAT Vault already exists; preserving manual evidence and edits.\n'
    return 0
  fi
  local integrity artifact_name artifact_path
  integrity="$(theme_integrity)"
  artifact_name="$(theme_artifact_name "$integrity")"
  artifact_path=".publish/themes/$artifact_name"
  mkdir -p "$test_vault/.obsidian" "$test_vault/.publish/themes" "$test_vault/notes"
  printf '{"alwaysUpdateLinks":true,"showLineNumber":true}\n' > "$test_vault/.obsidian/app.json"
  cp "$theme_archive" "$test_vault/$artifact_path"
  cat > "$test_vault/.publish/site.yml" <<EOF
version: 1
site:
  name: 野外笔记社 HAT
  description: 外部 Quartz 野兽派主题隔离验收站点
  home_layout: latest
  timezone: Asia/Shanghai
  theme:
    source: local
    artifact: $artifact_path
    integrity: $integrity
    options:
      accent: orange
      graphMode: compact
      homeHero: latest
      showPublicCount: true
      wordmark: PUBLIC FIELD NOTES
content_roots:
  - path: notes
    public_root: /notes
assets:
  exclude: []
features:
  search: true
  graph: true
cloudflare:
  project_name: custom-theme-hat-local-only
EOF
  cat > "$test_vault/notes/field-note.md" <<'EOF'
---
publication:
  visibility: public
  title: 城市边缘的开放系统
  slug: field-note
  tags: [systems, fieldwork]
---
# 城市边缘的开放系统

这是一篇用于检验长篇中文阅读节奏、混合语言和结构层级的公开笔记。

## 一、公开现场

> 结构应该被看见，但不应该压过内容。

### 观察记录

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| 01 | OPEN | 可重复验证 |
| 02 | LINKED | 保留上下文 |

```ts
const publication = "public field notes";
```

## 二、维护而非装饰

正文宽度、目录和反向链接必须保持可读。
EOF
  cat > "$test_vault/notes/second.md" <<'EOF'
---
publication:
  visibility: public
  title: 第二份公开记录
  slug: second
  tags: [systems]
---
# 第二份公开记录

链接到 [[field-note]]。
EOF
  cat > "$test_vault/notes/hidden.md" <<'EOF'
---
publication:
  visibility: unlisted
  title: Hidden dispatch
  slug: hidden-dispatch
---
# Hidden dispatch

UNLISTED-CUSTOM-THEME-CANARY-20260803
EOF
  cat > "$test_vault/notes/private.md" <<'EOF'
---
publication:
  visibility: private
  title: Private brutalist note
  slug: private-brutalist
---
PRIVATE-CUSTOM-THEME-CANARY-9f421fd6d0f44808
EOF
  : > "$marker"
}

summary() {
  local status="$1"
  cat <<EOF
HAT_PREPARE_SUMMARY
mode=$mode
status=$status
app_url=Obsidian desktop; preview URL is allocated at runtime
database=not-applicable
schema_version=site.yml v1; Theme API v1; Quartz 5.0.0
seed_records=notes:4,themes:1
test_vault=$test_vault
candidate=$(candidate_directory)
cleanup=$script_dir/prepare.sh cleanup
guide=$script_dir/guide.md
END_HAT_PREPARE_SUMMARY
EOF
}

case "$action" in
  info)
    printf 'repo=%s\nnode=%s\npackage_command=npm run package\nexternal_actions=none\n' \
      "$repo_root" "$(node --version)"
    if prepared; then summary prepared; else summary not-run; fi
    ;;
  prepare)
    (cd "$repo_root" && npm run package)
    (cd "$theme_root" && npm run pack:local)
    create_vault
    if prepared; then
      summary prepared
    else
      summary not-run
      exit 1
    fi
    ;;
  cleanup)
    if [[ -d "$test_vault" && -f "$marker" && ! -L "$test_vault" ]]; then
      rm -rf -- "$test_vault"
      printf 'Removed only the marked custom theme HAT Vault. Release and theme artifacts were preserved.\n'
    else
      printf 'No marked custom theme HAT Vault was removed.\n'
    fi
    summary cleaned
    ;;
  *)
    printf 'Usage: %s [info|prepare|cleanup]\n' "$0" >&2
    exit 64
    ;;
esac
