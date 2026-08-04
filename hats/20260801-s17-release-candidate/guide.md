# S17 发布候选 HAT 指南

<!-- HAT:BEGIN metadata -->

- 创建日期：2026-08-01；更新日期：2026-08-02
- 仓库：`/Users/ivan/workspace/ai/obsidian-pages-plugin`
- Source：`TASK.md` S17、`PRODUCT-SPEC.md` 第 15–16 节
- 模式：`blank`（专用的新本地 Vault + 隔离 Cloudflare 测试账号）
- 选择原因：首发旅程不能继承开发 fixture、预置插件数据或生产项目；不自动写入 Cloudflare 或用户 Vault。
- 准备状态：`prepared`；`bash prepare.sh prepare` 已在 2026-08-01 成功重建候选目录，并确认目录严格只有三个安装文件。真实 API Token、Obsidian SecretStorage、Cloudflare HTTP/Pages、OAuth public-client protocol/Obsidian callback、Obsidian 内嵌运行环境与恢复 host 已接入。2026-08-02 三 scope OAuth、只读账号/Pages 校验及完整 Obsidian 进程重启恢复已通过；完整 HAT 仍 `blocked` 于 S09 独立引擎受信发行/签名决策、获准的远端项目/域名写验收及其余人工 UI 矩阵。

<!-- HAT:END metadata -->

## 运行环境与阻塞项

- macOS Obsidian Desktop，版本必须不低于 `manifest.json` 的 `1.13.0`。
- Node 兼容下限为 `20.19.0`；插件本身应优先复用兼容运行时，不修改系统 Node、npm 或 PATH。
- 使用项目内已创建的隔离 Vault：`hats/20260801-s17-release-candidate/test-vault/`；不可使用同步到生产的 Vault。它仅含 public/unlisted/private 最小 fixture，且初始没有 `.publish/site.yml` 或插件安装目录。
- 需要一个隔离的 Cloudflare 测试账号，具备 Pages 项目创建/绑定/部署和测试域名状态查询权限；不向本指南、Vault 或环境文件写入 token。
- 当前阻塞：[`src/main.ts`](../../src/main.ts) 已注入 API Token、Obsidian SecretStorage、Obsidian `requestUrl`、Pages deployment、域名状态、OAuth public-client protocol/Obsidian callback、Obsidian 内嵌运行环境和恢复 host。候选包最终请求 `memberships.read`、`page.read`、`page.write`；真实 consent/callback、`GET /memberships` 账号发现、Pages 项目列表只读校验和完整进程重启恢复均已通过。当前不再阻塞于 OAuth P0；仍阻塞于 S09 独立引擎受信发行/签名决策、获准的远端项目/部署/域名写验收，以及其余 UI/键盘/恢复矩阵。

验收账号：`TODO: 验收者提供隔离 Cloudflare 账号；不得填写生产凭据。`

## 自动准备

从仓库根目录执行：

```bash
bash hats/20260801-s17-release-candidate/prepare.sh info
bash hats/20260801-s17-release-candidate/prepare.sh prepare
```

`prepare` 重建 `release/pages-publish-<version>/`，其中严格只有 `manifest.json`、`main.js`、`styles.css`，并在不存在时创建项目内的 `test-vault/` starter fixture。`info` 只有在 marker、四个 baseline fixture 与候选包的 `id`、`version`、`minAppVersion` 均匹配时才报告 `prepared`；其他可恢复的准备失败会输出结构化的 `status=not-run`。为保证同版本 staging 可重建，它会先替换该生成目录；已存在且带 S17 marker 的 test Vault 会原样保留，未带 marker 的目录会 fail-closed，绝不会删除 Vault、读取或写入 Cloudflare，也不执行 cleanup。默认只使用本项目内 Vault；`PAGES_PUBLISH_HAT_TEST_VAULT` 仅供自动测试，并需额外显式设置 `PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT=1`，符号链接一律拒绝。执行后可将候选目录复制到该 Vault 的 `.obsidian/plugins/pages-publish/`。

`tests/plugin-install-smoke.test.ts` 已在临时 Vault 自动验证相同候选包的文件层安装、覆盖升级和卸载：升级保留插件的非机密 `data.json` 与 Vault 的 `site.yml`，卸载只删除目标插件目录且不会创建不存在的配置目录；任何祖先或目标符号链接都不能把写入带出 Vault。它不替代 Obsidian GUI 加载、启用、升级和卸载的人工验收。

<!-- HAT:MANUAL notes -->

人工记录：

- 验收 Vault 路径：`hats/20260801-s17-release-candidate/test-vault/`（创建于 2026-08-01；开始 GUI 验收前确认仍无 `site.yml`、凭据或生产笔记）
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
| 安装升级卸载 | 已安装候选包；自动文件 smoke 已通过 | 覆盖安装同版本/新候选，重启，再禁用/删除 | 升级保留合法配置和非密钥绑定；卸载不删除线上站点 | Vault/设置截图 |

### P2 — 大 Vault smoke 与待建立的性能基线

运行：

```bash
npx vitest run tests/release-benchmark.test.ts --reporter=verbose
```

该命令会输出一笔 360 篇混合可见性文章的扫描、本地构建和 heap 采样，用于验证大 Vault 路径和 private 负向行为仍可运行。它不是可比较的性能发布门槛：fixture 很小、单次测量受机器与热缓存影响，测试也不声称 UI 响应时间。

在决定发布前，验收者必须在同一台声明了 macOS、Obsidian、Node、CPU、内存和 Vault 规模的机器上至少运行三次，记录每次输出、扫描/构建 RSS 或 heap、以及真实 Obsidian 的 P1 UI 响应观察；再据此单独确定量化门槛。未完成该记录时，S17 的性能与 UI 响应验收保持 `blocked`。

<!-- HAT:END checklist -->

### 2026-08-01 本地向导增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；没有 OAuth client metadata、Token、Keychain 写入或 Cloudflare 请求。
- 结果：环境准备自动进入 ready，且页面只保留一份向导；“继续”可进入站点信息和内容范围，本地草稿扫描完成后才进入 Cloudflare；未连接时第 3 步“继续”在 UI 与事件层禁用。
- TDD 发现：环境完成通知与准备 Promise 曾可并发渲染两份向导；新增 overlapping global refresh 回归并将 View 渲染串行合并后，实机复验通过。
- OAuth 结论：默认包因没有真实注册的 public client metadata 而隐藏 OAuth 登录入口，显示 API token 备用路径。这是诚实的构建状态，不算真实 OAuth 通过。

### 2026-08-01 发布中心、预览与响应式增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；没有 OAuth/Token/Keychain 或 Cloudflare 请求。
- 结果：配置站点扫描、变化列表、未连接发布门禁、本地预览及 public/unlisted/private 负向检查通过；发布中心通过浅色、深色 200%、双侧栏、169px 极窄容器和 Tab/焦点环增量 HAT。
- TDD 发现：真实 GUI 暴露扫描/渲染自循环、空 `DOMTokenList` class、禁用主按钮视觉误导、宿主 `.view-content` overflow 覆盖和 setup 长值裁切风险；全部先增加失败测试再修复。
- 最终门禁：46 files / 433 tests，typecheck、lint、build、package、diff-check 通过；`/root/review_s14` 最终 `0 P0 / 0 P1 / 0 P2`。
- 边界：这不是四个核心界面的完整主题/键盘矩阵；设置页、当前文章面板及失败/恢复状态仍待验收。

### 2026-08-01 发布中心壳层对齐增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；没有 OAuth/Token/Keychain 或 Cloudflare 请求。
- 结果：宽容器列表 + 右侧 Drawer、`<900px` Drawer 覆盖、筛选、`···` 菜单、浅色与深色实机视觉通过；验收后已恢复浅色主题和左侧栏。
- TDD 发现：中等 Pane 的双栏表格挤压、打开/返回焦点、Tab/筛选/搜索留下过期 Drawer，以及摘要指标/“查看问题”焦点遗漏均先形成失败测试再修复。
- 最终门禁：46 files / 441 tests，typecheck、lint、build、package、diff-check 通过；`/root/review_s14` 最终 `0 P0 / 0 P1 / 0 P2`。
- 边界：最新包重载后 Computer Use 点击 frame/element 映射失效，因此最终焦点同步的重载后 GUI 点击证据为 `PARTIAL`；其余核心界面、真实 OAuth/Pages 与发布候选状态不变。

### 2026-08-01 当前文章面板增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；没有 OAuth/Token/Keychain 或 Cloudflare 请求。
- 结果：约 290px 浅色侧栏中，发布/URL/检查/依赖/属性结构、按需编辑器、检查/取消回焦、高级区、本地环境降级和跨文章草稿安全通过。
- TDD 发现：高级区重渲染关闭、外部刷新丢草稿、保存/取消/失败回焦、change mock、长标题换行和跨文章焦点意图均先形成失败测试再修复。
- 最终门禁：47 files / 461 tests，typecheck、lint、build、package、diff-check 通过；`/root/review_s14` 最终 `0 P0 / 0 P1 / 0 P2`。
- 边界：GUI 未触发属性保存或远端动作；深色/200%/全部错误状态、设置页、首次设置完整矩阵、真实 OAuth/Pages 仍待验收。

### 2026-08-01 设置页增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；约 900×700 浅色设置窗口，没有 OAuth client metadata、Token、Keychain 写入或 Cloudflare 请求。
- 结果：站点/内容范围/Cloudflare/站点功能/本地环境顺序、顶部锚点和 sticky 保存栏通过；修改站点名后，页头、Cloudflare 统一说明和底部文案实时进入 dirty，所有远端写动作 fail-closed 且保留可访问名称；“放弃更改”恢复磁盘值和 clean 状态。
- TDD 发现：延迟挂载按钮可能绕过 dirty 门禁、远端成功后本地刷新失败会给出不诚实反馈、clean→dirty→异步失败可能错误重启按钮、外部远端配置变化可能丢草稿；均先形成失败测试再修复。
- 最终门禁：47 files / 468 tests，typecheck、lint、build、package、diff-check 通过；`/root/review_s14` 最终 `0 P0 / 0 P1`。P2 为并发单元测试使用受控 private seam，已由真实 Obsidian 公共入口 HAT 补足并记录为测试边界优化。
- 边界：只覆盖浅色 clean/dirty/discard；设置页深色、200% 缩放、纯键盘、conflict/错误恢复，首次设置和当前文章剩余矩阵、真实 OAuth/Pages 仍待验收。

### 2026-08-01 首次设置导航、门禁与焦点增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；约 1302×768 浅色主工作区，没有 OAuth client metadata、Token、Keychain 写入或 Cloudflare 请求。
- 结果：环境、站点信息、内容范围和 Cloudflare 的推进按钮均显示目标步骤；未扫描内容范围时 Cloudflare 推进禁用，扫描 3 篇候选并显示示例 URL 后解锁；无 OAuth client 时 API Token fallback 可见且确认推进保持禁用。Cloudflare 步“退出设置”可返回并保留草稿。
- TDD/review 发现：通用“继续”无法表达下一步；后续向导步骤没有明确退出；P1 发现换步重渲染会丢失键盘焦点。均先以行为回归固定后，改为 destination-labelled CTA、环境准备后的任一步可退出，并让前进/返回/确认编辑返回焦点落在目标步骤标题。
- 最终门禁：47 files / 473 tests，typecheck、lint、build、package、diff-check 通过；`/root/review_s14` 的 P1 焦点缺口及两个 P2（Cloudflare 退出重开草稿、返回/确认摘要编辑的焦点断言）都已处置并复审关闭。
- 边界：只覆盖浅色环境/站点/内容/未连接 Cloudflare；首次设置的深色、200%、完整纯键盘、失败/重试和真实 OAuth/确认执行仍待验收。

### 2026-08-02 四个核心界面主题与缩放增量实机记录

- 环境：Obsidian 1.13.4，项目内隔离 `test-vault`，候选包 `0.1.0`；没有 OAuth client metadata、Token、Keychain 写入或 Cloudflare 请求。验收后恢复浅色、默认缩放和原 `site.yml`。
- 结果：发布中心、设置页、当前文章面板和首次设置均完成深色与 200% 缩放档视觉抽样；发布中心、当前文章与首次设置没有页面级横向溢出。设置页实机发现窄容器/200% 下 sticky footer 遮挡锚点和正文首项。
- TDD/review 发现：新增窄容器 footer 定位 smoke 先 RED，再只在 `max-width: 640px` 让 footer 回到文档流，宽容器保持 sticky；重新打包/安装/重载后实机修复截图通过。`/root/review_s14` 最终 `0 P0 / 0 P1 / 0 P2`。
- 最终门禁：47 files / 473 tests，typecheck、lint、build、package、diff-check 通过。
- 边界：视觉抽样不替代完整纯键盘、错误恢复、GUI upgrade/uninstall、真实 OAuth/Pages、S09 受信发行源或性能 HAT；S16/S17 继续 `blocked`。

## 通过标准与执行记录

- 所有 P0 通过，且没有未解释的 P1 发布阻塞。
- package 结构、全量自动测试、类型检查、lint、构建、安全负向测试与性能基线均通过。
- P2 必须有明确发布处置；本次已知 P2 是菜单无法通过公共 Obsidian API 创建真正 submenu，以及需真实 HAT 的视觉证据。
- Cloudflare、账号或四个核心界面的完整 theme/keyboard HAT 未完成时，最终发布决策必须为 `blocked`。

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
- [`prepare.sh`](./prepare.sh)：幂等的包构建、隔离 test Vault fixture、信息/无破坏 cleanup 入口。
- [`../../scripts/release-package.mjs`](../../scripts/release-package.mjs)：只含 Obsidian 安装文件的候选包 staging。
- [`../../scripts/obsidian-plugin-install.mjs`](../../scripts/obsidian-plugin-install.mjs)：干净 Vault 的纯文件候选包安装/升级/卸载 smoke helper。

### Key decisions

- 采用 blank 的专用 Vault 与隔离 Cloudflare 账号；不使用 fixture 或生产数据。
- `prepare` 不进行任何 Cloudflare 写入；只会在 test Vault 首次缺失时创建其公开/未列出/私密 fixture，之后绝不覆盖或删除该 Vault。真实外部动作只能由人工明确发起。
- API Token/SecretStorage/Pages host 已接线；真实三 scope OAuth P0 已通过 Chrome 与 Obsidian 实机验证。远端项目、部署和域名写入仍必须由人工逐项授权，不能由 fake adapter 或 OAuth 连接成功替代。

### Verification evidence

- `bash -n hats/20260801-s17-release-candidate/prepare.sh` 必须通过。
- `npm run package`、`npm test -- --run`、`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 是候选门禁。
- `tests/release-package.test.ts` 验证包仅包含三个安装文件、最低 Obsidian 版本及 `versions.json` 一致性；`tests/plugin-install-smoke.test.ts` 验证临时 Vault 的文件安装/升级/卸载边界；`tests/release-benchmark.test.ts` 提供大 Vault smoke 与 private 负向检查。

### Open questions / risks

- `main.ts` 的 API Token/SecretStorage/Pages Direct Upload/恢复 host 已接线；公开 OAuth client、精确 OAuth scope IDs（`memberships.read`、`page.read`、`page.write`）和本机回调已完成真实授权、只读账号/Pages 校验及完整进程重启恢复。仍需验收撤销后重授权、API Token 权限不足、多账号切换，以及提供获准的隔离 Pages 项目和测试域名以执行远端写场景。
- `releases.pages-publish.dev` 的真实发行源、签名信任根和实际可下载 artifact 仍需要在受控发布基础设施中确定。
- 此指南尚未执行真实 Cloudflare 或完整的 GUI/干净 Vault 发布旅程；`20260801-171446` 已完成 Obsidian 的 clean-install、启用与初始入口 smoke，但不替代后续的 upgrade/uninstall、视觉/键盘和端到端发布验收。

## HAT Run History

| Run | 时间 | 范围 | 总状态 | 结果 |
| --- | --- | --- | --- | --- |
| [`20260801-171446`](./reports/20260801-171446/summary.md) | 2026-08-01 17:14 +08:00 | GUI clean-install、启用与初始入口 | `BLOCKED` | P0 安装 smoke `PASS`；完整发布仍缺 S09 受信发行配置与隔离 Cloudflare 资源。 |
| [`20260801-201049`](./reports/20260801-201049/summary.md) | 2026-08-01 20:06 +08:00 | 首次设置实时校验、内容扫描与 Cloudflare 门禁 | `BLOCKED` | 局部 GUI `PASS`；真实 OAuth/Pages、S09 信任源及完整视觉/升级 HAT 仍阻断发布。 |
| [`20260801-205531`](./reports/20260801-205531/summary.md) | 2026-08-01 20:30 +08:00 | 发布中心、预览、响应式与键盘增量 | `BLOCKED` | 已覆盖子场景 `PASS`；其余核心界面矩阵、真实 OAuth/Pages、S09、升级卸载与性能仍阻断发布。 |
| [`20260801-213000`](./reports/20260801-213000/summary.md) | 2026-08-01 21:12 +08:00 | 发布中心 Drawer、筛选、菜单与焦点同步 | `BLOCKED` | 壳层视觉 `PASS`、最终焦点 GUI 点击 `PARTIAL`；完整 UI/Cloudflare/S09/升级卸载/性能仍阻断发布。 |
| [`20260801-220700`](./reports/20260801-220700/summary.md) | 2026-08-01 21:34 +08:00 | 当前文章面板结构、按需编辑、检查与焦点安全 | `BLOCKED` | 已覆盖面板子场景 `PASS`；完整 UI/Cloudflare/S09/升级卸载/性能仍阻断发布。 |
| [`20260801-223000`](./reports/20260801-223000/summary.md) | 2026-08-01 22:14 +08:00 | 设置页结构、dirty 远端门禁与放弃恢复 | `BLOCKED` | 已覆盖设置页子场景 `PASS`；完整 UI/Cloudflare/S09/升级卸载/性能仍阻断发布。 |
| [`20260801-223500`](./reports/20260801-223500/summary.md) | 2026-08-01 22:30 +08:00 | 首次设置 CTA、内容扫描门禁、焦点与退出草稿 | `BLOCKED` | 已覆盖首次设置子场景 `PASS`；完整主题/键盘/OAuth/Cloudflare/S09/升级卸载/性能仍阻断发布。 |
| [`20260801-225034`](./reports/20260801-225034/summary.md) | 2026-08-01 22:50 +08:00 | 360 篇 mixed-visibility 大 Vault 三轮 smoke | `BLOCKED` | 三轮扫描/预览/private 负向检查均 `PASS`；真实 Obsidian UI 响应与性能阈值仍待验收。 |
| [`20260802-064500`](./reports/20260802-064500/summary.md) | 2026-08-02 06:45 +08:00 | 四个核心界面深色/200% 视觉抽样与设置页 footer 遮挡修复 | `BLOCKED` | 视觉抽样和修复后设置页 `PASS`；完整键盘/恢复、OAuth/Pages、S09、GUI upgrade/uninstall 与性能仍阻断发布。 |
| [`20260802-073000`](./reports/20260802-073000/summary.md) | 2026-08-02 07:29 +08:00 | 隐藏 `.publish/site.yml` 设置错误恢复 | `BLOCKED` | 实机确认错误入口打开专用修复 View；raw 保存/非法不写/冲突恢复自动通过。Computer Use 多行输入不可靠，完整人工编辑保存仍为 `PARTIAL`。 |
| [`20260802-074000`](./reports/20260802-074000/summary.md) | 2026-08-02 07:40 +08:00 | 插件生命周期、GUI 卸载重装与旧 OAuth scope 拒绝恢复 | `BLOCKED` | disable → enable → reload → GUI uninstall → candidate reinstall `PASS`；当时旧请求的 `account.read` 被拒，安全提示并恢复重试；该历史结论已由后续精确 scope 对齐取代。 |
| [`20260802-081700`](./reports/20260802-081700/summary.md) | 2026-08-02 08:17 +08:00 | P1 纯键盘安全导航子流程 | `MANUAL_REQUIRED` | prepare 状态已修复为可复验 `prepared`；Computer Use 未能可靠读取 Obsidian 键盘焦点，完整人工键盘矩阵仍需验收者完成。 |
| [`20260802-082500`](./reports/20260802-082500/summary.md) | 2026-08-02 08:25 +08:00 | HAT 准备状态收紧与大 Vault 自动 smoke | `BLOCKED` | 结构化准备/失败路径、52 files / 502 tests 和 360 篇 private 负向 smoke 均 `PASS`；真实键盘、OAuth consent/Pages、S09 与完整 HAT 仍阻断发布。 |
| [`20260802-090000`](./reports/20260802-090000/summary.md) | 2026-08-02 09:00 +08:00 | OAuth scope ID 对齐与登录页预检 | `MANUAL_REQUIRED` | 旧 `account.read`、`pages.read` 均被 Cloudflare 拒绝；精确 `account-settings.read`、`page.read`、`page.write` 进入登录页。需验收者登录，并在 OAuth consent 前即时确认。 |
| [`20260802-095000`](./reports/20260802-095000/summary.md) | 2026-08-02 09:50 +08:00 | Memberships Read scope 补齐与 consent 页预检 | `MANUAL_REQUIRED` | 新增 `memberships.read` 后，四个精确 IDs 的候选包进入 Cloudflare consent 页面；未创建 OAuth 凭据，等待即时授权确认与后续只读验证。 |
| [`20260802-140014`](./reports/20260802-140014/summary.md) | 2026-08-02 14:00 +08:00 | 三 scope OAuth、只读能力与跨进程恢复 | `BLOCKED` | OAuth P0 子场景 `PASS`：Chrome consent/callback、membership/Pages 只读校验及完整 Obsidian 重启恢复成功；完整 S17 仍被 S09、远端写与其余 HAT 阻塞。 |
| [`20260802-144745`](./reports/20260802-144745/summary.md) | 2026-08-02 14:47 +08:00 | OAuth 撤销、重新授权与跨进程恢复 | `BLOCKED` | 撤销后的 fail-closed 与重新授权后第二次完整重启恢复均 `PASS`；API Token 权限不足、多账号与完整 S17 仍待。 |
| [`20260802-151613`](./reports/20260802-151613/summary.md) | 2026-08-02 15:16 +08:00 | 核心主链路：隔离项目、首次发布、更新发布与公网验证 | `PASS_WITH_NOTES` | P0 核心闭环及公开边界抽样 `PASS`；失败恢复、迁移/下线、完整 UI/键盘与多账号后置。 |
