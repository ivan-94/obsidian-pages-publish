# 外部 Quartz 自定义主题 HAT

<!-- HAT:BEGIN metadata -->

## Metadata

- Source: [`CUSTOM-QUARTZ-THEME-SPEC.md`](../../CUSTOM-QUARTZ-THEME-SPEC.md)、[`BRUTALIST-QUARTZ-THEME-DESIGN.md`](../../BRUTALIST-QUARTZ-THEME-DESIGN.md)
- Created / updated: 2026-08-03
- Repo root: `/Users/ivan/workspace/ai/obsidian-pages-plugin`
- Mode: `blank`
- Mode reason: 使用独立 Vault、隔离主题缓存与本地 `.tgz`；不依赖历史数据，不写入生产或共享服务。
- Prepare status: `prepared`
- Latest run: `20260803-185611`
- Latest report: [`reports/20260803-185611/summary.md`](./reports/20260803-185611/summary.md)
- Human acceptance report: [`human-report.md`](./human-report.md)（environment ready，等待人工结果）
- Overall status: `MANUAL_REQUIRED`

<!-- HAT:END metadata -->

## 环境信息

- 执行环境：macOS Obsidian 桌面端，本地文件系统 Vault，Node ≥22。
- 数据库 / schema：不适用；站点配置为 `site.yml v1`，Theme API 为 `v1`，Quartz 为 `5.0.0`。
- 准备命令：`hats/20260803-custom-quartz-theme/prepare.sh prepare`；会构建并安装当前三文件 candidate 到受控 Vault，同时启用 `pages-publish`。
- 启动入口：在 Obsidian 中将 `test-vault/` 作为 Vault 打开；从设置页进入“站点主题”。
- 本地预览 URL：由 Pages Publish 运行时动态分配。
- 自动化入口：`npm run typecheck`、`npm run lint`、`npm test`；真实引擎测试需要设置 guide Source Manifest 中记录的三个 `PAGES_PUBLISH_*` 环境变量。
- 数据清理：仅运行 `prepare.sh cleanup`，它只删除带 HAT marker 的 `test-vault/`；release 包和源码不删除。

## 阻塞项与外部边界

- `@pages-publish-theme/brutalist@1.0.0` 尚未发布至 npm，真实 npm registry 安装场景记为 `MANUAL/BLOCKED`，但 registry exact/integrity/no-npm-install 路径有自动化测试。
- Cloudflare Direct Upload 会改变外部状态，本轮不自动执行；需要用户提供专用测试项目并明确授权。
- Obsidian 内首次执行信任、纯键盘体验和 200% 缩放保留人工判断；自动化会覆盖等价的契约、320px reflow、焦点和 reduced-motion CSS。

## 验收账号

| 角色 | 账号 | 来源 | 权限 / 租户 | 用途 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 本地作者 | 不需要账号 | 本机隔离 Vault | Vault 本地读写 | 安装、信任、预览、恢复默认主题 | ready |
| npm 发布者 | TODO: 用户提供 | npm | `@pages-publish-theme` scope | 首版发布后验证真实 npm 安装 | blocked |
| Cloudflare 测试发布者 | TODO: 用户提供 | Cloudflare OAuth | 专用 Pages 测试项目 | Direct Upload | manual |

## 验收数据需求

- `test-vault/notes/field-note.md`：公开长文，含中文、blockquote、table、code、二/三级标题和 tags。
- `test-vault/notes/second.md`：公开双链目标。
- `test-vault/notes/hidden.md`：unlisted canary，只能直接访问。
- `test-vault/notes/private.md`：private 高熵 canary，任何输出均不得出现。
- `.publish/themes/*.tgz`：从独立外部主题 package 打包后复制，integrity 写入 `site.yml`。
- 无数据库、迁移或共享 sandbox 数据；cleanup 只删除 marker 所属 HAT Vault。

## 数据迁移检查

- 当前 / 目标 schema：`site.yml v1` → `site.yml v1 + optional site.theme`，无需迁移。
- 旧 Vault 不含 `site.theme` 时必须继续使用 Quartz 默认主题。
- 恢复路径：删除草稿中的 `site.theme` 并保存；不得删除内容或自动部署。
- 未执行项：已上线生产 Vault 的真实历史主题切换不在 blank HAT 范围内。

<!-- HAT:BEGIN checklist -->

## 验收清单

### P0

#### HAT-P0-001 — 三文件插件与外部主题隔离

- Preconditions: 已运行 `prepare.sh prepare`。
- Steps:
  1. 执行 `npm run package`。
  2. 检查 `release/pages-publish-0.1.0/` 顶层文件。
  3. 在 `main.js`、`styles.css`、`manifest.json` 中搜索野兽派主题源码、CSS 和 registration asset 名称。
- Expected: release 恰好只有三文件，主题包、主题 CSS、字体和图片均未进入插件包。
- Evidence: 文件清单与搜索日志。
- Notes: cli，可自动化。

#### HAT-P0-002 — 本地 `.tgz` 导入、身份和显式信任

- Preconditions: Obsidian 打开 HAT Vault；插件使用当前 release 三文件；站点设置可打开。
- Steps:
  1. 在“站点主题”选择 HAT `.tgz`（也可先恢复默认主题再导入）。
  2. 核对 package、version、integrity、capabilities。
  3. 取消一次信任，确认草稿未改变；再次导入并确认执行信任及 clientScripts 提示。
  4. 保存设置，但不进入发布动作。
- Expected: 工件复制在 Vault，信任绑定精确 integrity；取消无残留激活；保存只改本地配置，不部署。
- Evidence: 设置页截图、`.publish/site.yml` 脱敏片段。
- Notes: manual，必须人工判断信任文案。

#### HAT-P0-003 — 真实 Quartz 深度主题构建

- Preconditions: 固定 Quartz engine、Node 22、本地主题 `.tgz` 可用。
- Steps:
  1. 运行 `tests/brutalist-theme-real.test.ts` 的真实 engine 测试。
  2. 连续构建同一 staging 两次。
  3. 检查首页 poster frame、文章 editorial frame、组件、client script、asset 与 options。
- Expected: 使用未改变的 `QuartzSiteBuilder` façade 成功构建；不是仅换色；两次 files/assets 完全相同。
- Evidence: Vitest 日志、首页和文章截图。
- Notes: cli + browser，可自动化。

#### HAT-P0-004 — 可见性、路由、CSP 与离线资源

- Preconditions: HAT 真实输出已生成。
- Steps:
  1. 检查 public 页面、unlisted 直达页及 private canary。
  2. 检查 contentIndex、sitemap、首页、搜索、图谱、tags 和公开文章非 authored 区域。
  3. 检查 canonical、noindex、CSP，以及 JS/CSS/SVG/XML 中的远程运行时资源。
  4. 断网刷新首页和文章。
- Expected: private 零泄漏；unlisted 有直达 HTML + noindex 但不进入发现面；路由不变；图谱使用本地 d3/pixi；无未知远程资源。
- Evidence: 测试日志、输出扫描、断网截图。
- Notes: cli + browser；真实断网切换为 manual。

### P1

#### HAT-P1-001 — 响应式、暗色、搜索、图谱和长文工具

- Preconditions: 本地预览已打开。
- Steps:
  1. 在 1440×1000、768×1024、390×844、320×667 检查首页和文章。
  2. 切换浅/深色；打开搜索；展开 Explorer；操作 Graph；检查 TOC/Backlinks。
  3. 浏览 table、code、blockquote 和长标题。
- Expected: 无横向溢出；触控按钮至少 44px；搜索在窄屏全屏且自动聚焦；核心 Quartz 工具可用。
- Evidence: 各视口截图、DOM 尺寸记录。
- Notes: browser，可自动化大部分。

#### HAT-P1-002 — 200%、纯键盘和 reduced motion

- Preconditions: 首页与文章均可访问。
- Steps:
  1. 浏览器缩放到 200%，从顶部 Tab 遍历所有交互。
  2. 用 Enter/Space 打开搜索、Explorer、暗色模式和图谱；用 Escape 关闭 overlay。
  3. 启用系统“减少动态效果”。
- Expected: 内容 reflow、焦点可见、无键盘陷阱；motion 近零且阅读进度不影响操作。
- Evidence: 屏幕录制或关键截图。
- Notes: manual；320px 自动检查作为 200% reflow 等价证据。

#### HAT-P1-003 — Repair、损坏、回滚、默认主题和卸载

- Preconditions: 外部主题已保存并缓存。
- Steps:
  1. 篡改缓存文件，确认不能选择/构建；运行 Repair。
  2. 让下一版本 smoke 失败，确认旧版本仍可用。
  3. 尝试卸载 active theme；恢复默认主题并保存后再卸载。
- Expected: inventory 漂移失败关闭；Repair 校验同一 integrity；active theme 不可卸载；默认 Quartz 永远可恢复；线上部署不改变。
- Evidence: Notice、设置状态、测试日志。
- Notes: store/rollback 自动化，Obsidian UX manual。

#### HAT-P1-004 — npm 精确版本与离线缓存

- Preconditions: 主题发布到官方 npm registry。
- Steps:
  1. 输入精确 package/version 安装并信任。
  2. 检查配置记录 package/version/integrity。
  3. 断网后重新预览和构建。
- Expected: 只访问官方 registry，不运行 `npm install`/lifecycle/dependency；缓存命中可离线构建。
- Evidence: 网络日志、配置、离线构建日志。
- Notes: 当前 npm 未发布，manual/blocked；unit coverage 已有。

### P2

#### HAT-P2-001 — Cloudflare Direct Upload

- Preconditions: 用户授权专用 Cloudflare Pages 测试项目。
- Steps: 预览确认后执行一次正式发布，再切回默认主题但不发布。
- Expected: 首次发布视觉与同一锁定快照预览一致；仅保存主题变化不自动部署。
- Evidence: deployment receipt、站点截图。
- Notes: 外部写入，默认 skipped。

<!-- HAT:END checklist -->

## 验收执行方式

- 主要入口：Obsidian 设置 → Pages Publish → 站点主题；Pages Publish 本地预览。
- 自动化工具：Vitest、文件 inventory、真实固定 Quartz build、内置 Browser。
- 辅助工具：`prepare.sh info|prepare|cleanup`、浏览器 DOM snapshot 与截图。
- Agent notes：页面当前没有 `window.__hat`；使用可访问性 role/name，其次稳定主题 class。不要依赖临时 hashed CSS/JS 文件名。
- 必须人工判断：信任风险文案、200% 主观可读性、纯键盘完整顺序、真实断网切换、npm 发布与 Cloudflare 外部写入。

## 通过标准

- 所有 P0 自动可执行项通过，P0 人工项无阻塞性问题。
- P1 不存在阻塞发布的问题；P2 为探索性且默认可跳过。
- private/unlisted、路由、CSP、隔离和确定性无未解释异常。
- cleanup 只删除 marker 所属 HAT Vault。

<!-- HAT:MANUAL notes -->

## 人工备注

- TODO: 验收者记录信任文案、200% 与键盘体验。
- 2026-08-03 18:59：自动 P0+P1 run `20260803-185611` 完成；P0-001/003/004 与 P1-001 PASS，P0-002、P1-002/003 待人工，P1-004 blocked，P2 skipped。

<!-- HAT:ENDMANUAL notes -->

## 执行记录模板

| 时间 | 执行人 | 场景 | 结果 | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD HH:mm | name | HAT-P0-001 | PASS/FAIL/MANUAL | path | notes |

## Source Manifest

### Sources

- [`CUSTOM-QUARTZ-THEME-SPEC.md`](../../CUSTOM-QUARTZ-THEME-SPEC.md)：Theme API、安装、信任、隔离、UI、HAT 和 AC-TH-01..15。
- [`BRUTALIST-QUARTZ-THEME-DESIGN.md`](../../BRUTALIST-QUARTZ-THEME-DESIGN.md)：poster/editorial/instrument 混合视觉系统与响应式约束。
- [`QUARTZ-MIGRATION-SPEC.md`](../../QUARTZ-MIGRATION-SPEC.md)：上层 SiteBuilder façade、Quartz engine 与发布边界。
- [`external-themes/brutalist/`](../../external-themes/brutalist/)：插件外独立主题源码、schema、tests 和打包脚本。
- [`tests/brutalist-theme-real.test.ts`](../../tests/brutalist-theme-real.test.ts)：本地导入、信任、真实 Quartz、可见性、CSP 和确定性验收。
- 用户于当前 Codex task 确认：完整接入 Quartz，但主题渲染器上层架构不能动；首个外部主题采用野兽派 poster/editorial/instrument 混合方向；隔离环境已确认。

### Produced artifacts

- [`guide.md`](./guide.md)
- [`prepare.sh`](./prepare.sh)
- [`human-report.md`](./human-report.md)
- `test-vault/`（由 prepare 生成）
- `reports/<run-id>/`（由 hat-run 生成）

### Key decisions

- 采用 blank 隔离 HAT，不接触生产 Vault、生产 Cloudflare 或共享数据。
- 首轮以本地 `.tgz` 完整验收；npm 发布是后续人工动作，不伪造 registry 结果。
- 外部主题不进入插件三文件包；真实测试只消费打包产物。
- 浏览器能力沿用 Quartz Search/Explorer/Graph/TOC/Backlinks，布局 class 使用主题独立命名空间。

### Verification evidence

- 生成 guide 前已通过 typecheck、lint、主题单元测试、默认 Quartz 真实构建与外部主题真实构建。
- 已在 1440、768、390、320 检查首页；390 检查文章；暗色、搜索自动聚焦和离线 Graph 已实测。
- `bash -n hats/20260803-custom-quartz-theme/prepare.sh` 已通过；shellcheck 当前不可用。
- `prepare.sh prepare` 已完成：三文件 release、外部主题 `.tgz`、4 篇隔离 fixture 和精确 local integrity 均已生成。
- 当前 release 已安装到 `test-vault/.obsidian/plugins/pages-publish/`，三个文件与 release 逐字节一致，`community-plugins.json` 已启用该插件。

### Open questions / risks

- npm package 尚未发布；真实 npm registry 场景保持 blocked/manual。
- Cloudflare Direct Upload 需要用户显式授权测试项目，本轮不自动执行。
- 用户仍需在 Obsidian 中人工确认首次信任文案、200% 和完整纯键盘顺序。
