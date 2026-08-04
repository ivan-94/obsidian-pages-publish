# Pages Publish BRAT 发布规格

> 文档状态：Ready for execution
>
> 发布渠道：GitHub Releases + BRAT
>
> 首个候选版本：`0.1.0-beta.1`
>
> 更新日期：2026-08-04

## 1. 文档目的

本规格定义 Pages Publish 在不提交 Obsidian 官方插件市场的前提下，通过 BRAT 分发、安装和更新 Beta 版本的发布契约、质量门禁、自动化流程与人工验收边界。

本文件只规定插件发行流程，不重新定义产品行为：

- 产品语义、安全不变量和首版功能范围以 [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md) 为准。
- 当前实现 Slice、完成状态和技术门禁以 [`TASK.md`](./TASK.md) 为准。
- 人工验收场景以 [`hats/20260801-s17-release-candidate/guide.md`](./hats/20260801-s17-release-candidate/guide.md) 为基础，并由验收者针对真实 BRAT 安装路径补充执行。

## 2. 已确认决策

1. GitHub 公开仓库使用 `ivan-94/obsidian-pages-publish`。
2. 插件暂不提交 Obsidian 官方插件市场。
3. Beta 版本只通过 GitHub Releases 和 BRAT 分发。
4. Quartz 原生主题是默认站点主题；Pages Publish 不另外制定默认配色、字号或布局覆盖。
5. 其他内置主题和自定义主题是用户主动选择的可选能力，不得改变 Quartz 原生默认路径。
6. 自动化构建、测试、打包和 Release 由 Codex 准备；真实 BRAT 安装与产品验收由用户执行。
7. 首个公开候选版本使用 `0.1.0-beta.1`，后续修复按 `0.1.0-beta.N` 递增。

## 3. 当前状态

### 3.1 已具备

- 插件 manifest、版本映射和生产构建入口已经存在。
- [`scripts/release-package.mjs`](./scripts/release-package.mjs) 能生成只包含 `main.js`、`manifest.json`、`styles.css` 的安装目录。
- 自动化测试、TypeScript 类型检查和 ESLint 当前通过。
- Cloudflare 首次发布、更新发布以及 public/unlisted/private 边界已有 `PASS_WITH_NOTES` 实机证据。
- GitHub 公开仓库已创建：<https://github.com/ivan-94/obsidian-pages-publish>。
- 本地 Git `origin` 已指向该仓库，但尚未推送代码。
- GitHub Actions 仓库变量 `PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID` 已配置；Release 构建缺失该值时仍会 fail-closed。

### 3.2 发布前缺口

- 当前主题相关开发改动尚未整理为干净提交。
- GitHub 仓库仍为空，没有默认分支。
- CI 与 Release workflow 已生成，但尚未在远端 GitHub runner 中执行。
- 尚未通过真实 BRAT 完成安装和跨版本升级验收。

## 4. 发布范围

### 4.1 `0.1.0-beta.1` 必须包含

- Obsidian Desktop 中的插件加载、启用、禁用和卸载边界。
- 安全站点配置与内容范围管理。
- Quartz 原生默认站点构建与本地预览。
- Markdown、Mermaid、图片、Wiki 链接、搜索、图谱和可见性边界。
- Cloudflare OAuth/API Token 连接路径。
- Cloudflare Pages 首次发布与后续完整站点发布。
- public、unlisted、private 的生成与泄漏防护。
- 发布中心、设置页、当前文章入口和失败信息。
- BRAT 安装所需的 GitHub Release 附件。

### 4.2 不属于本轮范围

- Obsidian 官方插件市场提交流程。
- Windows、Linux、Obsidian Mobile 支持。
- 自建插件更新服务或二进制签名服务。
- Pages Publish 自己设计的默认站点主题。
- 为 Beta 首发新增与发布无关的产品功能。

## 5. GitHub 仓库契约

### 5.1 Canonical repository

```text
https://github.com/ivan-94/obsidian-pages-publish
```

源码 banner、README、Issue 链接、Release Notes 和 BRAT 安装说明必须统一使用该地址。

### 5.2 默认分支

- 默认分支：`main`。
- 首次推送前必须确保工作树中的功能改动已经审查、测试并形成可解释的提交。
- 禁止为了初始化远端仓库而覆盖或丢弃本地历史。

### 5.3 基础仓库文件

首发前至少包含：

- `README.md`：产品简介、Beta 状态、环境要求、BRAT 安装、首次设置和反馈入口。
- `LICENSE`：与 `package.json` 中的 MIT 声明一致。
- `CHANGELOG.md`：记录每个 Beta 版本的用户可见变化和已知问题。
- `.github/workflows/ci.yml`：持续集成门禁。
- `.github/workflows/release.yml`：tag 驱动的 Release 构建与附件上传。

## 6. 版本与 Release 契约

### 6.1 版本格式

Beta 版本使用合法 SemVer：

```text
0.1.0-beta.1
0.1.0-beta.2
0.1.0-beta.3
```

禁止使用无法由 SemVer 稳定排序的日期、分支名或无序后缀作为插件版本。

### 6.2 三方一致性

每次 Release 的三个值必须完全一致：

```text
Git tag       0.1.0-beta.1
Release name  0.1.0-beta.1
manifest      0.1.0-beta.1
```

Release workflow 在上传前必须自动验证一致性；不一致时发布失败，不允许依靠 BRAT 自动修正。

### 6.3 Release 附件

Release 必须上传以下三个独立附件：

```text
main.js
manifest.json
styles.css
```

不得只上传源码压缩包，也不得要求测试者手动解压自定义目录结构。GitHub 自动生成的 Source code archives 不属于插件安装附件。

### 6.4 `versions.json`

- `versions.json` 必须包含候选版本到最低 Obsidian 版本的映射。
- `manifest.json.minAppVersion` 与对应映射必须一致。
- 当前最低版本为 `1.13.0`；若调整，必须作为显式兼容性变更记录在 CHANGELOG。

## 7. 自动化发布流程

### 7.1 CI workflow

对 pull request 和 `main` push 执行：

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

CI 必须在受支持的 Node 版本上运行，不依赖开发者机器上的全局 Node、npm、Quartz cache 或 Vault 数据。

### 7.2 Release workflow

以符合插件 SemVer 的 tag 作为触发入口：

1. Checkout tag 对应的精确 commit。
2. 安装锁定依赖。
3. 运行完整 CI 门禁。
4. 确认仓库变量 `PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID` 已配置且非空。
5. 校验 tag 版本、Release 版本、manifest 版本和 `versions.json`。
6. 使用该 OAuth public client ID 运行生产构建与 release package staging。
7. 确认候选目录只有三个安装文件。
8. 对三个附件计算 SHA-256，并写入 workflow summary。
9. 创建 GitHub pre-release。
10. 上传 `main.js`、`manifest.json`、`styles.css`。

任何步骤失败时，不得创建看似可安装但附件不完整的 Release。

## 8. Release Candidate 收口

`0.1.0-beta.1` 打 tag 前按以下顺序执行：

1. 完成并审查当前 Mermaid、内置主题和 Quartz 默认主题改动。
2. 确认未配置 `site.theme` 时不加载 `@quartz-themes/core` 或其他主题样式。
3. 确认测试 Vault 回到 Quartz 原生默认主题后，内部链接、右栏和标题不受第三方主题污染。
4. 运行全量测试、typecheck、lint、生产构建和 release package。
5. 检查仓库中不存在 Cloudflare Token、OAuth secret、Vault 私密正文或个人凭据。
6. 整理提交并确保工作树干净。
7. 推送 `main`，确认远端 CI 通过。
8. 创建并推送 `0.1.0-beta.1` tag。
9. 确认 GitHub pre-release 和三个附件生成成功。

## 9. 人工 BRAT 验收

真实验收由用户执行。自动化不得把“附件成功上传”视为真实安装通过。

### 9.1 安装验收

1. 在隔离 Vault 安装并启用 BRAT。
2. 使用仓库标识 `ivan-94/obsidian-pages-publish` 添加 Beta 插件。
3. 选择 `0.1.0-beta.1` 或 latest Beta。
4. 确认 BRAT 下载并安装 Pages Publish。
5. 启用插件，确认无加载错误。
6. 确认安装目录只包含预期插件文件及 Obsidian 产生的合法运行数据。

### 9.2 核心产品验收

- 完成首次设置或连接已有隔离配置。
- 使用 Quartz 原生默认主题启动本地预览。
- 验证 Markdown、Mermaid、图片、内部链接、搜索和图谱。
- 完成一次 Cloudflare Pages 首次发布和一次更新发布。
- 验证 private 内容不出现在页面、搜索、图谱和 sitemap。
- 验证失败提示中不包含 Token 或私密正文。

### 9.3 升级验收

在 `0.1.0-beta.2` 发布时执行：

1. 让 BRAT 从 `0.1.0-beta.1` 更新到 `0.1.0-beta.2`。
2. 确认插件 ID 不变且不产生第二份插件目录。
3. 确认 `site.yml`、非机密插件设置和授权恢复信息得到保留。
4. 确认旧版本正在运行时不会留下不可恢复的预览进程或缓存锁。
5. 完整重启 Obsidian 后再次打开发布中心和本地预览。

### 9.4 验收责任边界

- Codex：准备候选版本、自动化门禁、Release 附件、校验信息、安装说明和已知问题。
- 用户：在真实 Obsidian + BRAT 中执行安装、启用、升级和产品主链路验收，并决定 pass/fail。
- 用户发现问题后，必须记录插件版本、Obsidian 版本、操作步骤和脱敏日志；不得在 Issue 中上传 Token 或私密 Vault 内容。

## 10. 发布门禁

### 10.1 `0.1.0-beta.1` 阻断项

- CI 任一命令失败。
- tag、Release name、manifest 或 `versions.json` 不一致。
- Release 缺少任何安装附件。
- 插件无法在最低支持的 Obsidian Desktop 中加载。
- Quartz 原生默认主题被第三方主题或自定义 CSS 污染。
- private 内容可能进入公开 HTML、资源、搜索、图谱或 sitemap。
- 发布失败会破坏当前线上站点。
- 仓库或附件包含凭据、私密内容或开发机绝对路径。

### 10.2 Beta 阶段可后置项

以下项目可以在 Release Notes 中明确标记后进入小范围 Beta：

- 完整键盘和辅助技术矩阵。
- 多 Cloudflare 账号切换。
- 受限 API Token 的完整权限组合矩阵。
- 大 Vault 的正式性能门槛。
- Obsidian 官方插件市场材料。

## 11. 回滚与撤回

- 有安全或隐私风险的 Release 必须立即在 GitHub 标记为不可用，并发布修复版本；不得复用同一 tag 覆盖附件。
- 普通功能回归通过新的 `0.1.0-beta.N` 修复，不修改已发布 Release 的历史附件。
- BRAT 测试者可以冻结到已知可用版本；Release Notes 必须指出受影响版本和推荐升级目标。
- 撤回插件版本不等于删除用户线上 Cloudflare Pages 项目；插件卸载和远端资源生命周期保持分离。

## 12. 首次上架交付清单

- [ ] 当前功能改动完成 review 并提交。
- [x] Canonical repository URL 全部更新。
- [x] README、LICENSE、CHANGELOG 完成。
- [ ] CI workflow 通过。
- [ ] Release workflow 在测试 tag 上通过。
- [x] `0.1.0-beta.1` 的版本字段一致。
- [ ] Release 三个附件存在且 hash 已记录。
- [ ] BRAT 安装说明可由不了解源码的测试者执行。
- [ ] 用户完成真实 BRAT 安装验收。
- [ ] 已知问题和反馈入口写入 Release Notes。

## Source Manifest

### Sources

- [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md)：首版产品语义、安全不变量和成功判据。
- [`TASK.md`](./TASK.md)：实现 Slice、全局 Definition of Done 和当前完成状态。
- [`hats/20260801-s17-release-candidate/guide.md`](./hats/20260801-s17-release-candidate/guide.md)：发布候选 HAT 环境、P0/P1/P2 清单和历史执行记录。
- [`hats/20260801-s17-release-candidate/reports/20260802-151613/summary.md`](./hats/20260801-s17-release-candidate/reports/20260802-151613/summary.md)：Cloudflare 核心发布主链路 `PASS_WITH_NOTES` 证据。
- [`manifest.json`](./manifest.json)、[`versions.json`](./versions.json)、[`package.json`](./package.json)：插件 ID、版本、最低 Obsidian 版本和构建命令。
- [`scripts/release-package.mjs`](./scripts/release-package.mjs)：当前三文件安装包 staging 契约。
- [BRAT Guide for Plugin Developers](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)：GitHub Release、附件和版本一致性要求。
- [Obsidian Beta-testing plugins](https://docs.obsidian.md/Plugins/Releasing/Beta-testing%20plugins)：Obsidian 官方对 BRAT Beta 分发的建议。
- 2026-08-04 本会话用户决策：仓库名增加 `obsidian-` 前缀；暂不上官方市场；真实 BRAT 验收由用户执行。

### Produced artifacts

- [`BRAT-RELEASE-SPEC.md`](./BRAT-RELEASE-SPEC.md)：本发布规格。
- <https://github.com/ivan-94/obsidian-pages-publish>：已创建但尚未推送代码的公开发布仓库。

### Key decisions

- GitHub Releases 是唯一 Beta 制品源，BRAT 是唯一首发安装与更新渠道。
- Quartz 原生主题保持默认；第三方内置主题不得改变默认渲染。
- 首版采用 `0.1.0-beta.N` 版本序列，不复用 tag 或覆盖历史附件。
- 自动化负责生成可信候选，真实 BRAT 安装与产品验收由用户负责。

### Verification evidence

- 2026-08-04：`npm test` 通过，结果为 78 files passed、5 skipped；683 tests passed、9 skipped。
- 2026-08-04：`npm run typecheck` 通过。
- 2026-08-04：`npm run lint` 通过。
- 2026-08-04：当前 release staging 中的三个文件与项目根对应文件 SHA-256 一致。
- 2026-08-04：GitHub 仓库创建成功，公开可访问，本地 `origin` 已配置；代码尚未推送。
- 2026-08-04：`npm run package -- "0.1.0-beta.1"` 通过，生成的候选目录严格包含三个附件，manifest 版本与 tag 参数一致。
- 2026-08-04：GitHub repository variable `PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID` 配置成功，命令未输出变量值。

### Open questions / risks

- 当前工作树仍包含未提交的主题相关改动，必须在首次推送前完成 review 和提交收口。
- CI 和 Release workflow 尚未在 GitHub runner 中验证。
- 首个真实 BRAT 安装结论等待用户验收。
- 失败恢复、URL 迁移/下线、完整键盘矩阵和多账号矩阵仍不是当前核心主链路 HAT 的完整通过项。
