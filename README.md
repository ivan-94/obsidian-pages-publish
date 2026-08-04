# Pages Publish

Pages Publish 是一个 macOS Obsidian 桌面插件，用于把 Vault 中明确选择的 Markdown 内容发布到 Cloudflare Pages。扫描、检查、渲染和预览优先在本地完成；Cloudflare 只承担身份授权、Pages 项目管理和静态站点托管。

> [!WARNING]
> 当前版本处于 Beta 阶段，只通过 BRAT 分发。请先在隔离 Vault 和测试用 Cloudflare Pages 项目中验证，不要直接用于不可恢复的生产内容。

## 功能概览

- 在 Obsidian 内完成站点设置、内容选择、检查、预览和发布。
- 支持 public、unlisted、private 三种可见性，并保护私密链接、图片、搜索、图谱和 sitemap 边界。
- 使用 Quartz 生成静态站点，默认保持 Quartz 原生主题。
- 支持 Markdown、Wiki 链接、图片、Mermaid、搜索和关系图谱。
- 通过 Cloudflare OAuth 或最小权限 API Token 连接 Pages。
- 每次发布生成完整快照；上传或激活失败时保留当前线上部署。

## 环境要求

- macOS
- Obsidian Desktop `1.13.0` 或更高版本
- Cloudflare 账号
- 用于安装 Beta 版本的 [BRAT](https://github.com/TfTHacker/obsidian42-brat)

插件只支持桌面端，不支持 Obsidian Mobile、Windows 或 Linux。

## 通过 BRAT 安装

1. 在 Obsidian 社区插件市场安装并启用 **BRAT**。
2. 打开命令面板，运行 **BRAT: Add a beta plugin for testing**。
3. 输入：

   ```text
   ivan-94/obsidian-pages-publish
   ```

4. 选择最新 Beta 或指定版本。
5. 安装完成后，在社区插件列表中启用 **Pages Publish**。

BRAT 会从 [GitHub Releases](https://github.com/ivan-94/obsidian-pages-publish/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。更新时可运行 BRAT 的检查更新命令，或冻结到一个已知可用版本。

## 首次使用

1. 建议先创建一个新的测试 Vault。
2. 打开 Pages Publish 首次设置。
3. 选择允许发布的内容根和公开路径。
4. 使用 Cloudflare OAuth，或配置最小权限 API Token。
5. 先运行本地预览，检查公开、未列出和私密内容边界。
6. 确认候选变化后再发布到隔离的 Cloudflare Pages 项目。

默认情况下，新内容不会因安装插件而自动公开。确认向导之前，插件不应创建远端项目或发布内容。

## 凭据与隐私

- Cloudflare 凭据存储在 Obsidian SecretStorage，不写入 Vault、`site.yml`、普通日志或发布产物。
- `.publish/site.yml` 保存可重建的非机密站点配置。
- 发布前请检查 private 内容、嵌入图片、Wiki 链接、搜索、图谱和 sitemap。
- 报告问题时不要上传 Token、OAuth secret、私密正文或完整 Vault。

## 反馈问题

请使用 [GitHub Issues](https://github.com/ivan-94/obsidian-pages-publish/issues)。建议包含：

- Pages Publish 版本
- Obsidian 与 macOS 版本
- 干净 Vault 中的最小复现步骤
- 脱敏后的错误信息或诊断日志
- 问题发生在安装、预览、授权、构建还是发布阶段

## 本地开发

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run package
```

`npm run package` 会在 `release/pages-publish-<version>/` 生成可安装的三个插件文件。

发布规则和人工验收边界见 [`BRAT-RELEASE-SPEC.md`](./BRAT-RELEASE-SPEC.md)。

## License

[MIT](./LICENSE)
