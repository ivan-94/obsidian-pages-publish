# S17 发布候选 HAT 指南

<!-- HAT:BEGIN metadata -->

- 创建日期：2026-08-01；更新日期：2026-08-01
- 仓库：`/Users/ivan/workspace/ai/obsidian-pages-plugin`
- Source：`TASK.md` S17、`PRODUCT-SPEC.md` 第 15–16 节
- 模式：`blank`（专用的新本地 Vault + 隔离 Cloudflare 测试账号）
- 选择原因：首发旅程不能继承开发 fixture、预置插件数据或生产项目；不自动写入 Cloudflare 或用户 Vault。
- 准备状态：`syntax-checked`；自动包构建/结构检查可执行，完整 HAT `blocked` 于实际 S09/S10/S13 host 接线和人工账号授权。

<!-- HAT:END metadata -->

## 运行环境与阻塞项

- macOS Obsidian Desktop，版本必须不低于 `manifest.json` 的 `1.13.0`。
- Node 兼容下限为 `20.19.0`；插件本身应优先复用兼容运行时，不修改系统 Node、npm 或 PATH。
- 创建一个空的本地文件系统 Vault；不可使用同步到生产的 Vault。
- 需要一个隔离的 Cloudflare 测试账号，具备 Pages 项目创建/绑定/部署和测试域名状态查询权限；不向本指南、Vault 或环境文件写入 token。
- 当前阻塞：[`src/main.ts`](../../src/main.ts) 尚未注入 S09 环境、S10 OAuth/Keychain、S13 Pages deployment 的真实 host adapter。因此下述 Cloudflare P0 只能在该接线完成后执行，不能以 fake adapter 测试替代。

验收账号：`TODO: 验收者提供隔离 Cloudflare 账号；不得填写生产凭据。`

## 自动准备

从仓库根目录执行：

```bash
bash hats/20260801-s17-release-candidate/prepare.sh info
bash hats/20260801-s17-release-candidate/prepare.sh prepare
```

`prepare` 只运行构建并生成 `release/pages-publish-<version>/`，其中严格只有 `manifest.json`、`main.js`、`styles.css`。为保证同版本 staging 可重建，它会先替换该生成目录；绝不会删除 Vault、读取或写入 Cloudflare，也不执行 cleanup。执行后可将该目录复制到新 Vault 的 `.obsidian/plugins/pages-publish/`。

<!-- HAT:MANUAL notes -->

人工记录：

- 验收 Vault 路径：
- Obsidian 版本 / macOS 版本：
- 隔离 Cloudflare 账号标识（脱敏）：
- 运行时来源与版本（系统/受管理）：
- 任何非密钥 binding、项目名和自定义域名状态：

<!-- HAT:ENDMANUAL notes -->

## 验收数据与迁移

- 使用三个最小 Markdown：`public`、`unlisted`、`private`，以及一篇 public 指向 private 的 Wiki 链接。
- 追加一篇带旧发布字段的文章，用于确认迁移预览不丢失旧字段。
- 为 URL 迁移准备一篇已发布 public 文章；为下线准备一篇独立已发布文章。
- 不存在数据库迁移；目标 schema 为 `site.yml v1` 和 `publication v1`。HAT 结束后仅手动删除专用 Vault 和生成的 `release/`，不得删除远端项目或线上内容作为 cleanup。

## 验收清单

<!-- HAT:BEGIN checklist -->

### P0 — 安装、首次设置和隐私

| 场景 | Preconditions | Steps | Expected | Evidence |
| --- | --- | --- | --- | --- |
| 干净安装 | 已运行 `prepare`，新 Vault | 复制包到插件目录，重启 Obsidian，启用插件 | 插件可加载；仅 macOS 本地文件 Vault 声明可用；没有设置错误或凭据文件 | 截图、Obsidian 控制台（无敏感内容） |
| 预发布隐私 | public/unlisted/private fixture；记录 private 的已知候选 URL | 在发布中心选择“预览站点”，记录 loopback 基地址；在浏览器分别访问 private 候选 URL、站内搜索和图谱，并打开 `<预览基地址>/sitemap.xml`。如需保留 HTTP 证据，可由验收者用 `curl` 请求同一 loopback URL。 | private 正文、标题、路径和资源不在页面、搜索、图谱或 sitemap；private 候选 URL 不返回正文；public→private 链接不泄漏目标。不得假定本地存在生成目录。 | 预览基地址、private URL 响应、搜索/图谱截图、sitemap 响应、检查时间 |
| 四步设置无提前副作用 | 无 `site.yml`，隔离账号 | 在确认前编辑四步设置草稿 | 不创建远端项目/域名、不写 Frontmatter；取消后 Vault 无站点配置 | Vault diff、Cloudflare 审计 |
| 首次发布与后续编辑 | 真正接线完成 | 确认设置、预览、开始发布；上传阶段编辑文章 | 首次成功后进入发布中心；线上内容来自冻结快照，后续编辑标为下一版变化 | 发布中心截图、部署 ID、线上页面 |

### P0 — 失败、恢复和 Cloudflare

| 场景 | Preconditions | Steps | Expected | Evidence |
| --- | --- | --- | --- | --- |
| 授权/上传/激活失败 | 隔离账号、真实 adapter | 分别触发或模拟安全失败；重试 | 线上站点和部署事实不改变；失败页给出恢复入口；不显示 token | 阶段日志、前后部署 ID |
| 本地回写失败恢复 | 真实 adapter + 可控本地写入失败 | 使 Frontmatter 回写失败后重启插件 | 显示“线上成功 / 本地待协调”，可幂等完成回写 | 维护状态、Frontmatter diff |
| URL 迁移和下线 | 已发布 public 文章 | UI 改 slug，发布；再改 private 或删除并确认下线，发布 | 旧 URL 永久重定向；下线后旧页无正文；未确认前无本地/线上变化 | 新旧 URL、发布中心、线上响应 |
| 域名状态 | 已绑定隔离项目 | 请求自定义域名计划/状态 | 显示实际状态和下一步；失败不移除现有 binding | 设置页截图、Cloudflare 状态 |

### P1 — 宿主 UX 和可访问性

| 场景 | Preconditions | Steps | Expected | Evidence |
| --- | --- | --- | --- | --- |
| 主题/容器/缩放 | 发布中心、设置、当前文章面板 | 分别在明暗主题、左右侧栏、分屏、容器 <640px、200% 缩放打开四个核心界面 | 无页面级横向滚动；焦点、状态和主操作清晰 | 每个状态截图 |
| 纯键盘 | 上述 fixture | Tab/Shift+Tab/Enter/Space 完成设置、定位 Blocker、预览、发布、失败重试 | 所有 P0 操作可达；焦点可见；状态栏空闲隐藏且无扫描 Notice 噪音 | 步骤录像或截图 |
| 安装升级卸载 | 已安装候选包 | 覆盖安装同版本/新候选，重启，再禁用/删除 | 升级保留合法配置和非密钥绑定；卸载不删除线上站点 | Vault/设置截图 |

### P2 — 大 Vault smoke 与待建立的性能基线

运行：

```bash
npx vitest run tests/release-benchmark.test.ts --reporter=verbose
```

该命令会输出一笔 360 篇混合可见性文章的扫描、本地构建和 heap 采样，用于验证大 Vault 路径和 private 负向行为仍可运行。它不是可比较的性能发布门槛：fixture 很小、单次测量受机器与热缓存影响，测试也不声称 UI 响应时间。

在决定发布前，验收者必须在同一台声明了 macOS、Obsidian、Node、CPU、内存和 Vault 规模的机器上至少运行三次，记录每次输出、扫描/构建 RSS 或 heap、以及真实 Obsidian 的 P1 UI 响应观察；再据此单独确定量化门槛。未完成该记录时，S17 的性能与 UI 响应验收保持 `blocked`。

<!-- HAT:END checklist -->

## 通过标准与执行记录

- 所有 P0 通过，且没有未解释的 P1 发布阻塞。
- package 结构、全量自动测试、类型检查、lint、构建、安全负向测试与性能基线均通过。
- P2 必须有明确发布处置；本次已知 P2 是菜单无法通过公共 Obsidian API 创建真正 submenu，以及需真实 HAT 的视觉证据。
- Cloudflare、账号、theme/keyboard HAT 未实际执行时，最终发布决策必须为 `blocked`。

| 时间 | 执行人 | 场景 | 结果（pass/fail/blocked） | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Source Manifest

### Sources

- [`PRODUCT-SPEC.md`](../../PRODUCT-SPEC.md)：AC-1 至 AC-8、FR-1、FR-17、FR-18 与发布门槛。
- [`DESIGN.md`](../../DESIGN.md)：主题、容器、键盘与可访问性门槛。
- [`UI-SPEC.MD`](../../UI-SPEC.MD)：核心视图、Ribbon、命令、状态栏和设置 UX。
- [`TASK.md`](../../TASK.md)：S17 验收条件、TDD/review gate 与上游 Slice 状态。
- [Obsidian 发布插件架构](thread://019fb7b2-bf37-7883-9334-53dac3a35ca1)：本地优先、Cloudflare、快照和隐私的原始决策。

### Produced artifacts

- [`guide.md`](./guide.md)：本 HAT 的可人工执行验收清单和记录模板。
- [`prepare.sh`](./prepare.sh)：幂等的包构建/信息/无破坏 cleanup 入口。
- [`../../scripts/release-package.mjs`](../../scripts/release-package.mjs)：只含 Obsidian 安装文件的候选包 staging。

### Key decisions

- 采用 blank 的专用 Vault 与隔离 Cloudflare 账号；不使用 fixture 或生产数据。
- `prepare` 不进行任何 Cloudflare 写入，也不创建或删除 Vault；真实外部动作只能由人工明确发起。
- 当前真实 host adapter 未接线，完整 Cloudflare P0 验收标记为 blocked，不能由 fake adapter 替代。

### Verification evidence

- `bash -n hats/20260801-s17-release-candidate/prepare.sh` 必须通过。
- `npm run package`、`npm test -- --run`、`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 是候选门禁。
- `tests/release-package.test.ts` 验证包仅包含三个安装文件、最低 Obsidian 版本及 `versions.json` 一致性；`tests/release-benchmark.test.ts` 提供大 Vault smoke 与 private 负向检查。

### Open questions / risks

- 真实 S09/S10/S13 host adapter、OAuth/Keychain 与 Cloudflare Direct Upload 尚未在 `main.ts` 接线。
- `releases.pages-publish.dev` 的真实发行源、签名信任根和实际可下载 artifact 仍需要在受控发布基础设施中确定。
- 此指南没有执行真实 Cloudflare、Obsidian UI 或干净 Vault HAT；它们需要用户的桌面与隔离账号。
