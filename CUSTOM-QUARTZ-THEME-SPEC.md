# Pages Publish 外部 Quartz 自定义主题规格

> 文档状态：Implemented / 自动验收通过 / HAT 人工项待确认
>
> 适用产品：Pages Publish Obsidian Community Plugin
>
> 主题能力：插件外独立开发、安装、配置、预览、发布和回滚的 Quartz 5 主题包
>
> 首个验收主题：外部野兽派 UI 主题（Brutalist UI）
>
> 目标平台：macOS Obsidian 桌面端
>
> 更新日期：2026-08-03

## 1. 文档目的与效力

本规格定义 Pages Publish 如何支持不内置于插件的完整 Quartz 自定义主题。这里的“主题”不是颜色 token 或单个 CSS 文件，而是可以独立开发和分发的表现层扩展包，能够提供样式、静态资源、布局、页面组件和受控客户端交互。

本规格是 [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md) 与 [`QUARTZ-MIGRATION-SPEC.md`](./QUARTZ-MIGRATION-SPEC.md) 的增量规格：

- 覆盖 `PRODUCT-SPEC.md` 中“主题市场、自定义主题编辑器和第三方主题兼容承诺不在范围内”的旧边界；本规格只开放外部主题包，不承诺任意历史 Obsidian/Quartz 主题无需适配即可运行。
- 覆盖 `QUARTZ-MIGRATION-SPEC.md` 中“不开放主题市场、任意第三方主题或自定义 TypeScript 配置”“首版不向 site.yml 新增主题字段”的旧边界。
- 不改变 Pages Publish 的内容选择、可见性、Route Planner、资源安全、发布快照、输出审计、Cloudflare Direct Upload 和部署事实契约。
- 不把 Vault 变成 Quartz 工程；Vault 中不得生成 `quartz.config.yaml`、`quartz.layout.ts`、`package.json`、`node_modules` 或 Quartz 源码树。
- `.publish/site.yml` 继续作为唯一用户站点配置来源；主题安装收据和缓存不是第二份用户配置。

## 2. 已确认需求

1. 用户必须能够创建自己的完整主题，例如野兽派 UI，而不需要把主题提交进 Pages Publish 仓库或插件安装包。
2. 自定义能力不能被压缩为颜色、字体或附加 CSS；主题必须能够改变布局、站点外壳、导航和表现层组件。
3. 主题渲染器以上的 Pages Publish 架构不能改变。
4. Quartz 5 继续作为唯一站点 renderer。
5. Pages Publish 三文件插件包继续只包含 `main.js`、`manifest.json` 和 `styles.css`，不携带外部主题及其依赖。
6. 外部主题在用户机器的隔离环境中按需安装，固定版本和完整性，安装完成后可离线构建。
7. 主题更新不得隐式发生；预览和发布必须使用配置中锁定的同一主题工件。
8. 自定义主题不能绕过 public/unlisted/private、canonical URL、redirect、搜索/图谱发现性和输出安全审计。

## 3. 目标与非目标

### 3.1 目标

- 支持完整、独立、可版本化的 Quartz 主题包。
- 支持精确版本 npm 包与本地 `.tgz` 两种首版来源。
- 允许主题提供 CSS、本地字体、图标、静态资源、布局、组件和客户端脚本。
- 提供小型 Pages Publish Theme SDK，使主题可以使用 Quartz 表现层能力而不接管产品上层领域逻辑。
- 为可执行主题提供明确的信任提示、能力声明、完整性校验和隔离构建边界。
- 让本地主题工件可随 Vault 迁移并重建站点。
- 支持主题安装、激活、配置、升级、回滚、Repair 和卸载。
- 使用外部野兽派主题完成端到端实现和 HAT，证明主题不需要内置于插件。

### 3.2 非目标

- 不在首版实现主题商店、评分、搜索、推荐、付费或自动更新。
- 不允许 `latest`、版本范围、浮动 Git branch、未固定 GitHub URL 或远端运行时脚本。
- 不直接运行未打包的 Quartz 仓库或 Obsidian Vault 主题目录。
- 不保证任意现有 Obsidian CSS theme 可以零修改运行；它必须封装为本规格的主题包。
- 不允许主题注册内容 transformer、filter、emitter、page type 或替代 Route Planner。
- 不允许主题直接读取原始 Vault、SecretStorage、Cloudflare 凭据、部署事实或其他 Vault 的状态。
- 不允许主题修改 Quartz engine 或共享 runtime。
- 不允许主题通过安装脚本编译；发布的主题包必须包含已经构建好的可执行产物。

## 4. 架构边界

### 4.1 构建数据流

```text
Vault + site.yml
  -> Pages Publish 扫描/可见性/路由/资源安全
  -> 不可变 staging
  -> 受控 Quartz 配置 + 已解析主题快照
  -> Quartz 5 + 主题表现层
  -> Output Collector / Auditor
  -> LocalPreview / PublicationSnapshot
  -> Cloudflare Direct Upload
```

主题只位于“受控 Quartz 配置”和“Output Auditor”之间。上层继续只依赖现有 SiteBuilder/LocalPreview façade，不导入 Quartz 或主题类型。

### 4.2 主题可以控制

- Quartz 原生颜色和字体主题配置。
- 页面网格、左右栏、工具栏和正文区域的表现层布局。
- Header、Navigation、Footer、Article Shell、目录、搜索外壳、图谱外壳等组件的替换或装饰。
- CSS、局部样式、本地字体、图标、背景、图片和其他受控静态资源。
- 声明过且通过输出策略的客户端交互脚本。
- 主题自身 `optionsSchema` 中定义的用户选项。

### 4.3 主题不能控制

- 哪些 Markdown 或资源进入 staging。
- `publication.visibility`、public/unlisted/private 语义。
- canonical URL、slug、folder route、system route 和 redirect。
- Search、Graph、Explorer、Backlinks、Tag、Sitemap 的内容成员。
- raw HTML、embed、Wiki link 和本地资源安全降级。
- 构建输入 digest、发布快照、上传列表和部署事实。
- Cloudflare 账号、项目、域名、凭据或请求。
- Output Auditor 的规则、错误降级或 Blocker 判定。

### 4.4 主题不是安全边界

完整组件主题会在 Quartz 构建进程中执行 JavaScript。安装一个第三方可执行主题等价于信任该主题发布者在隔离构建环境中运行代码。产品必须明确展示该事实，不能把它描述成与普通 CSS 相同的低风险操作。

构建隔离和输出审计用于限制影响面，不用于宣称任意恶意主题绝对安全。

## 5. 主题包契约

### 5.1 包格式

主题必须是可由 `npm pack` 生成的标准 `.tgz` 包，并满足：

- 包名和版本符合 npm package 规则。
- `version` 是精确 semver。
- `type` 为 `module`。
- 包含预构建的 ESM 入口，不依赖安装生命周期脚本。
- 不包含 `node_modules`、源码仓库、Git 元数据或绝对路径。
- 除允许的 peer dependency 外，主题业务代码及第三方库必须被打包进 `dist/`。
- 所有文件通过安全 tar 提取、数量、单文件和总大小预算。

### 5.2 `package.json` 元数据

```json
{
  "name": "@pages-publish-theme/brutalist",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "peerDependencies": {
    "@pages-publish/theme-sdk": "1.x",
    "preact": "^10.0.0"
  },
  "pagesPublishTheme": {
    "apiVersion": 1,
    "displayName": "Brutalist UI",
    "quartzVersion": "5.0.0",
    "entry": "./dist/index.js",
    "capabilities": [
      "styles",
      "assets",
      "layout",
      "components",
      "clientScripts",
      "localFonts"
    ],
    "optionsSchema": "./dist/options.schema.json"
  }
}
```

未知 `apiVersion`、不兼容 Quartz 版本、未知 capability、缺失入口或越界 export 必须拒绝安装。

### 5.3 Theme SDK

主题入口使用稳定 SDK，而不是导入 Pages Publish 内部源码：

```ts
import { defineTheme } from '@pages-publish/theme-sdk'

export default defineTheme({
  configuration: {
    typography: {
      header: 'Arial Black',
      body: 'Arial',
      code: 'Courier New',
    },
  },
  layout: {
    left: ['BrutalistNavigation'],
    beforeBody: ['BrutalistHeader'],
    afterBody: ['BrutalistFooter'],
  },
  components: {
    BrutalistNavigation,
    BrutalistHeader,
    BrutalistFooter,
  },
  styles: ['./brutalist.css'],
  assets: ['./assets/grid.svg'],
  clientScripts: ['./client.js'],
})
```

SDK 返回值必须可验证。主题不能返回任意 Quartz config，也不能删除产品强制插件或覆盖安全字段。

### 5.4 允许的依赖

首版主题包不解析任意运行时 dependency graph。允许：

- `@pages-publish/theme-sdk`：由受控 theme runtime 提供。
- `preact` 及 Quartz 明确暴露的表现层 peer API：由固定 Quartz engine 提供。
- 主题自行打包进 `dist/` 的纯前端依赖。

存在其他 `dependencies`、`optionalDependencies`、native addon、postinstall 或需要编译的模块时拒绝安装。这样可以避免一个主题隐式拉取未锁定的依赖树。

## 6. 站点配置

### 6.1 默认主题

未配置 `site.theme` 时继续使用当前受控 Quartz 默认主题：

```yaml
site:
  name: My Wiki
  home_layout: sections
```

### 6.2 npm 主题

```yaml
site:
  name: My Wiki
  home_layout: sections
  theme:
    source: npm
    package: "@ivan/quartz-theme-brutalism"
    version: "1.0.0"
    integrity: "sha512-..."
    options:
      border_width: 4
      accent: "#ff3b00"
```

要求：

- `version` 必须是精确版本，不能是 range/tag。
- `integrity` 必须与 registry tarball 和本地安装收据一致。
- options 必须通过主题包内的 schema。
- 保存主题设置只修改本地配置并重新扫描，不自动发布。

### 6.3 本地主题

用户从文件选择器导入 `.tgz` 后，插件把原始工件复制到 Vault：

```text
.publish/themes/@ivan-quartz-theme-brutalism-1.0.0.tgz
```

配置记录 Vault 相对路径与摘要：

```yaml
site:
  theme:
    source: local
    artifact: ".publish/themes/@ivan-quartz-theme-brutalism-1.0.0.tgz"
    integrity: "sha512-..."
    options:
      border_width: 4
```

本地工件必须满足 Vault sandbox、非 symlink、固定摘要和安全 tar 规则。把 `.tgz` 保存在 Vault 中使未发布的私人主题可以随 Vault 迁移和重建，同时不把 Vault 变成 Quartz 工程。

### 6.4 规范化与保存

- `site.yml` 是主题选择和 options 的唯一用户配置。
- npm 安装收据、解包清单和最后一次验证结果保存在 Vault 外的本地状态目录。
- 配置序列化必须保留精确版本、integrity 和稳定 options 顺序。
- 外部编辑冲突继续使用现有 revision/原子保存语义。
- 未知主题字段、非法 options、缺失本地工件或 integrity 漂移形成 Blocker。

## 7. 主题安装与存储

### 7.1 存储布局

```text
~/Library/Application Support/pages-publish/environment/
  engines/
    darwin-arm64/pages-publish-quartz-5.0.0.x/
  themes/
    <safe-package-id>/
      <version>-<integrity-prefix>/
        package/
        receipt.json
```

主题目录和 Quartz engine 分离。主题安装、更新或卸载不得写入 active engine。

### 7.2 安装流程

1. 用户输入精确 npm package/version，或选择本地 `.tgz`。
2. 插件下载或读取主题工件；普通预览/构建阶段不得触发安装。
3. 计算并验证 registry integrity 或本地 SHA-512。
4. 使用现有安全 tar 能力提取到同父目录临时目录。
5. 验证 package manifest、Theme API、Quartz 兼容性、capabilities、文件预算和依赖边界。
6. 对每个文件记录相对路径、类型、大小和 SHA-256；拒绝 symlink、hardlink、device 和路径穿越。
7. 执行隔离 theme smoke：加载 descriptor、校验 options schema、渲染最小 Quartz fixture、执行输出审计。
8. 原子 rename 为不可变主题目录并写 `receipt.json`。
9. 用户确认后才把选中的 source/version/integrity 写入 `site.yml`。

### 7.3 npm 行为

- 使用官方 `https://registry.npmjs.org/`。
- 不继承用户 `.npmrc`、proxy、token、registry 或 global prefix。
- 不执行 lifecycle scripts。
- 不安装 dev dependency。
- 不解析 `latest`、dist-tag、semver range、Git dependency 或 file dependency。
- 下载、解析和安装阶段支持取消；取消后不得残留 active 或 `.install-*` 目录。
- 安装成功后普通预览和发布必须能够断网完成。

### 7.4 缓存复用

缓存命中时必须重新验证：

- package name/version/integrity。
- `pagesPublishTheme` manifest。
- 精确文件清单与每个文件 hash。
- Theme API 与 Quartz engine 兼容性。
- smoke/compatibility patch 版本。

任何漂移都不能静默使用；进入主题 Repair 状态。

## 8. 构建期加载

### 8.1 只读主题快照

每次构建解析出 `ResolvedTheme`：

```ts
interface ResolvedTheme {
  packageName: string
  version: string
  integrity: string
  packageDirectory: string
  descriptor: ValidatedThemeDescriptor
  options: Readonly<Record<string, unknown>>
}
```

SiteBuilder 只接收验证完成的 `ResolvedTheme`。主题原始配置和 npm 细节不能泄漏到 Application、Publication 或 Cloudflare 层。

### 8.2 Quartz workspace

- 选中主题以只读快照方式复制或挂载到单次临时 workspace。
- 受控 Quartz config 只引用 workspace 内的主题入口。
- Pages Publish 需要提供固定 compatibility adapter，使 Quartz 5 可以从显式主题根加载 ESM、组件和静态资源；不得通过修改共享 engine 的 `node_modules` 达成。
- 主题 options 在写入 Quartz config 前经过 schema 和结构化克隆，不允许函数、原型或特殊 YAML 对象。
- 构建完成后 workspace 全部删除；主题缓存保持只读。

### 8.3 强制配置合并

合并优先级从低到高：

1. Quartz 固定默认表现层配置。
2. 外部主题 descriptor。
3. `site.yml` 中经过 schema 的主题 options。
4. Pages Publish 强制安全和产品配置。

第 4 层不可被主题覆盖，至少包括：

- locale、base URL 和 canonical 策略。
- public/unlisted/private 和 noindex 行为。
- Search、Graph、Explorer、Backlinks、Tag、Sitemap 的成员来源。
- Route Bridge、folder click 安全配置和 system routes。
- 禁用 analytics、远程 embed 和未知 runtime resource。
- 输出文件与字节预算。

### 8.4 失败语义

- 主题缺失、损坏、不兼容、options 无效或 smoke 失败时预览/发布失败，不静默切回默认主题。
- UI 必须区分“主题未安装”“主题损坏”“主题与当前 Quartz 不兼容”“主题构建失败”。
- 已上线部署保持不变。
- 用户可以 Repair 当前精确主题、选择其他已安装版本或移除 `site.theme` 回到默认主题。

## 9. 安全与信任模型

### 9.1 安装确认

首次激活或完整性变化时展示：

- package name、display name、version、source 和 integrity 摘要。
- 发布者信息（若 registry 可提供，仅作为信息，不作为信任根）。
- 声明的 capabilities。
- “该主题包含会在隔离 Quartz 构建中执行的代码”的明确说明。
- 客户端脚本会在站点读者浏览器中执行的额外说明。

用户必须显式确认；仅修改同一主题的普通 options 不重复确认。

### 9.2 构建隔离

- Quartz 和主题只能读取 engine、已验证主题包和单次 workspace。
- 原始 Vault 被操作系统 sandbox 与 Node 文件权限共同拒绝；主题只看到已筛选 staging。
- 构建期禁止网络。
- 主题缓存、engine、runtime、SecretStorage 和其他 Vault 状态不可写。
- 子进程、native addon 和 worker 权限必须按 Quartz 的最小实际需要重新评估；自定义主题不能扩张权限。
- 非 macOS 平台在没有等价网络/文件隔离之前不得宣称支持可执行主题。

### 9.3 浏览器运行时

- 主题资源必须本地化，禁止远程 `<script>`、stylesheet、font、module import、worker 和动态 CDN URL。
- 允许 `clientScripts` 的主题必须接受独立能力确认。
- 输出应增加并测试 Content Security Policy；目标至少限制 `default-src`、`script-src`、`style-src`、`font-src`、`img-src`、`connect-src`、`frame-src`、`object-src`、`base-uri` 和 `form-action`。
- 主题生成的运行时导航继续受 Route Bridge 和可发现 route manifest 约束。
- Output Auditor 必须扫描 HTML、CSS、JS、JSON、XML 和二进制文本片段中的临时路径、远程资源和 private/unlisted canary。

### 9.4 安装期供应链

- npm registry metadata 不是信任根；精确 tarball integrity 才是工件身份。
- 本地主题以复制进 Vault 的 `.tgz` 摘要为身份。
- `receipt.json` 记录来源、解析时间、package identity、manifest、文件清单、hash 和 smoke 版本。
- 主题升级生成新目录并原子切换；不得就地覆盖旧目录。
- 至少保留当前使用版本与上一个已验证版本，支持显式回滚。

## 10. 插件 UI

设置页新增“站点主题”区：

- 当前主题名称、来源、版本、完整性摘要和状态。
- “使用 Quartz 默认主题”。
- “从 npm 安装”。
- “导入本地主题包”。
- 已安装版本选择。
- 主题提供的 options 表单。
- “预览主题”“修复”“更新到指定版本”“卸载未使用版本”。
- 可执行代码和 clientScripts 的信任提示。

行为要求：

- 选择或配置主题只形成未保存草稿。
- 保存后重扫并使下次预览/发布使用新主题，但不自动部署。
- 安装、Repair 和预览是可取消的单一 in-flight 操作。
- 主题失败不应把设置页替换成无法恢复的空白状态。
- 卸载 active theme 被阻止；先切换主题并保存配置。
- 主题 options schema 只支持有限、可访问的字段类型：boolean、enum、number、string、color 和 asset reference。

## 11. 主题开发工作流

### 11.1 独立工程

野兽派测试主题必须位于独立 package/repository，不进入 Pages Publish 的生产 `src/`、plugin package 或 Quartz engine manifest。

推荐结构：

```text
pages-publish-theme-brutalist/
  package.json
  src/
    index.ts
    components/
    styles/
    client/
  assets/
  tests/
  dist/
```

### 11.2 本地迭代

首版正式支持的循环：

1. 在主题工程运行测试和 build。
2. 运行 `npm pack` 生成 `.tgz`。
3. 在 Pages Publish 中导入主题包。
4. 插件复制工件、验证、smoke 并生成新 integrity。
5. 预览 HAT Vault。

后续可以增加明确标记为不用于发布的 `development link` 模式，但正式预览/发布前必须冻结为 `.tgz` 快照。

### 11.3 兼容性

- Theme API 独立版本化，不直接暴露 Pages Publish 内部模块。
- 主题声明精确 Quartz major/minor 兼容范围。
- Quartz engine 升级前对所有 active theme 执行 compatibility smoke。
- 不兼容的新 engine 不得替换仍在使用的 active engine/theme 组合。

## 12. 野兽派 UI 测试主题

The proposed page-frame, component, responsive and accessibility design is defined in [`BRUTALIST-QUARTZ-THEME-DESIGN.md`](./BRUTALIST-QUARTZ-THEME-DESIGN.md). That document is the visual contract for this test theme; this section remains the packaging and acceptance contract.

### 12.1 目的

野兽派主题不是内置皮肤，而是证明外部主题包能够真正改变 Quartz 表现层的验收工件。测试必须从打包后的 `.tgz` 安装，不得从 Pages Publish 源码 import。

### 12.2 默认视觉方向

在用户提供进一步素材前采用以下可替换基线：

- 页面类型采用同一视觉系统下的组合式设计：首页/目录页使用海报式 frame，文章页使用编辑部三栏 frame，工具组件使用控制台式状态语言；不要求所有页面共享一个 shell。

- 名称：`Brutalist UI`。
- package placeholder：`@pages-publish-theme/brutalist`。
- 同时支持浅色和深色。
- 黑、白、纸灰为基础，使用高饱和红或橙作为主强调色，蓝/黄作为少量辅助色。
- 4px 高对比边框、硬质错位阴影、直角、明显网格和分区编号。
- 超大粗体无衬线标题；正文使用系统无衬线；代码使用系统等宽字体。
- 不使用玻璃拟态、柔和渐变、模糊、细腻圆角或装饰性低对比文本。
- Desktop 使用强烈左右分栏；窄屏降为单栏但保留清晰的信息层级。
- Header、Explorer、Article Shell、Search、Graph、Footer 至少有一处非默认 Quartz 组件或布局实现，证明能力不只是 CSS 覆盖。
- 所有交互必须具有明显 hover、active 和 `:focus-visible` 状态。

### 12.3 内容 fixture

复用或扩展 Quartz HAT Vault，覆盖：

- 中文、Unicode、空格和大小写 route。
- sections/latest 两种首页。
- public/unlisted/private 与公开子文章/不列出 section index。
- Search、Graph、Explorer、Backlinks、Tag 和长目录。
- Callout、表格、代码块、Mermaid、本地图片、长标题和长行。
- 404、Privacy、redirect 和 custom section index。
- 窄屏、200% 缩放、纯键盘、浅色和深色。

### 12.4 验收结果

主题通过时必须证明：

- Pages Publish 三文件包不包含主题源码、主题 CSS、字体或图片。
- 删除主题缓存后，可以从 npm 精确版本或 Vault 内 `.tgz` 重建。
- 安装后断网可以预览和构建。
- 同一 staging、engine、theme integrity 和 options 生成确定性输出。
- 主题明显改变布局和组件，而不只是颜色。
- 主题不能发现 private 内容，不能把 unlisted 页面加入导航/搜索/图谱/sitemap。
- 主题不能改变 canonical routes、redirect 或 system routes。
- 主题升级失败时旧 active theme 和线上部署保持可用。

## 13. 测试策略

### 13.1 配置与领域模型

- 缺省默认主题和 v1 配置兼容。
- npm/local 两类配置 parse、serialize、external-edit conflict 和 repair。
- 精确版本、integrity、artifact path 和 options schema。
- 未知字段、未知 capability、future Theme API 和不兼容 Quartz。

### 13.2 安装器与主题存储

- npm 精确包、本地 `.tgz`、缓存命中、离线复用、Repair 和取消。
- registry integrity、本地 digest、文件 inventory 和 receipt 漂移。
- tar traversal、symlink/hardlink/device、大小预算和文件数预算。
- lifecycle scripts、dependency、native addon、绝对路径和 source map 路径泄漏。
- 同主题并发、不同版本并发、原子切换、失败清理和旧版本保留。

### 13.3 Theme SDK 和 Quartz 集成

- descriptor/schema validation。
- CSS、assets、local fonts、layout、components 和 clientScripts。
- 强制配置合并优先级。
- 主题无法删除安全插件或替代内容/路由插件。
- engine/theme compatibility adapter 和真实 Quartz build。
- 默认主题与外部主题使用同一 SiteBuilder façade。

### 13.4 安全与输出

- 原始 Vault、SecretStorage、其他 Vault 和 engine/theme store 写入 canary。
- 构建期网络拒绝。
- 远程 script/style/font/import/fetch/worker 拒绝。
- CSP、Route Bridge、canonical、noindex、redirect 和 404。
- public/unlisted/private 在 HTML、JSON、XML、CSS、JS 和 binary 中的负向检查。
- 输出文件、单文件、总字节和构建时间预算。

### 13.5 HAT

- 三文件插件安装后从 npm 安装野兽派主题。
- 从本地 `.tgz` 导入同一主题并获得不同 source、相同内容身份。
- 首次信任提示、clientScripts 额外提示和取消。
- 主题 options 修改、保存、预览、不自动发布。
- 浅色/深色、窄屏、200%、纯键盘和 reduced motion。
- 首次发布、主题更新、失败回滚、Repair、恢复默认主题和卸载。
- 断网预览/构建和 Cloudflare Direct Upload。

## 14. 验收标准

| ID | 验收标准 |
| --- | --- |
| AC-TH-01 | 未配置主题的现有 Vault 继续使用当前 Quartz 默认主题，URL 和输出安全契约不变。 |
| AC-TH-02 | 用户可安装精确 npm 主题包，配置记录 package/version/integrity，普通构建不触发 npm install。 |
| AC-TH-03 | 用户可导入本地 `.tgz`；工件复制进 `.publish/themes/`，新机器可从 Vault 重建。 |
| AC-TH-04 | 主题包不进入 Obsidian 三文件插件、Quartz engine 或其他 Vault 的状态。 |
| AC-TH-05 | 主题可提供 CSS、assets、layout、components、clientScripts 和 options，野兽派主题实证不只是 CSS 换色。 |
| AC-TH-06 | 可执行主题首次激活有身份、integrity、capability 和代码执行信任确认。 |
| AC-TH-07 | build 只能读取 engine、主题快照和 staging，不能读取原始 Vault 或访问网络。 |
| AC-TH-08 | 主题不能改变 public/unlisted/private、canonical route、redirect、Search/Graph/Sitemap 成员。 |
| AC-TH-09 | 主题所有运行时资源本地化；未知远程 script/style/font/module/worker/connect 被阻止。 |
| AC-TH-10 | 安装、缓存和 Repair 校验完整文件 inventory；损坏时失败而非静默使用。 |
| AC-TH-11 | 相同 staging、engine、theme integrity 和 options 产生确定性输出。 |
| AC-TH-12 | 主题安装、构建或升级失败不影响当前线上部署；上一个已验证主题可回滚。 |
| AC-TH-13 | 野兽派主题通过浅色/深色、窄屏、200%、键盘、reduced-motion 和核心 Quartz 功能 HAT。 |
| AC-TH-14 | 主题改变不会自动部署；预览和正式发布使用同一锁定主题快照。 |
| AC-TH-15 | active theme 不能被卸载；移除主题配置后可安全恢复 Quartz 默认主题。 |

## 15. 实施切片

### Slice 1：Theme Contract 与配置

- 增加 Theme API、manifest、capability 和 options schema 类型。
- 扩展 `site.yml` parse/validate/serialize/conflict。
- 增加默认主题兼容和配置测试。

### Slice 2：Installer、Store 与 Trust Receipt

- npm exact tarball 与本地 `.tgz` 输入。
- 安全提取、integrity、inventory、smoke、原子激活、Repair 和回滚。
- 隔离 theme store 与磁盘预算。

### Slice 3：Quartz Theme Adapter

- 将已验证主题快照挂载到临时 workspace。
- Theme SDK descriptor 到受控 Quartz config/layout/components/resources 的映射。
- 强制配置合并和 architecture boundary 测试。

### Slice 4：安全与输出

- 构建期 network/filesystem 边界。
- 客户端资源本地化、CSP 和 Output Auditor 扩展。
- private/unlisted、route 和 runtime canary。

### Slice 5：插件 UI

- npm 安装、本地导入、信任确认、options、预览、Repair、版本切换和卸载。
- 状态、取消、失败恢复和可访问性。

### Slice 6：外部野兽派主题与 HAT

- 独立主题 package、build、tests 和 `.tgz`。
- 真正的组件/layout 定制。
- npm/local/offline/upgrade/rollback/Cloudflare HAT。

## 16. 发布与回滚

- 外部主题能力以 feature-complete 方式发布，不长期保留隐藏的任意代码入口。
- 默认 Quartz 主题始终是不依赖外部主题安装的恢复路径。
- 新 Theme API 或 Quartz engine 在激活前必须验证 active themes；不兼容时保留旧 engine/theme 组合。
- 主题不得自动更新。用户输入目标精确版本、完成安装和预览后才可保存。
- 新主题构建失败时不得用默认主题继续发布，避免未审阅的整站视觉变化。
- 卸载只删除未被任何 Vault 配置引用的缓存版本；Vault 内本地 `.tgz` 属于用户文件，不由缓存清理删除。

## 17. 用户需要准备的信息

开始 Theme Contract、installer 和本地 `.tgz` 流程实现不需要用户提供额外文件。野兽派主题进入视觉实现前，以下信息有助于替换默认假设：

1. 主题正式名称和期望的 npm package scope；未提供则使用 `Brutalist UI` / `@pages-publish-theme/brutalist`。
2. 是否需要品牌 Logo、指定字体或必须使用的颜色；未提供则使用纯文字标识、系统字体和黑白红基线，不请求远程字体。
3. 是否要求首版发布到 npm；未提供则先以独立本地 package + `.tgz` 验收，npm 发布作为后续人工动作。

## Source Manifest

### Sources

- 当前 Codex task 中用户于 2026-08-03 明确要求：必须支持不内置于 Pages Publish 的完整自定义主题，并以用户自己的野兽派 UI 主题作为测试；CSS/token 定制不足以满足需求。
- 当前 Codex task 中用户此前确认：Quartz 完整接管主题渲染，但主题渲染器上层架构不能改变；Quartz 和依赖在用户机器的隔离环境动态安装，以保持三文件插件包轻量。
- [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md)：Vault 可重建、三种可见性、路由、发布快照、失败不破坏线上和三文件产品基线。
- [`QUARTZ-MIGRATION-SPEC.md`](./QUARTZ-MIGRATION-SPEC.md)：Quartz 5 ownership、SiteBuilder façade、staging 隔离、engine/runtime 安装、输出审计和当前需要被本规格覆盖的主题非目标。
- [`src/config/site-config.ts`](./src/config/site-config.ts)：当前 `.publish/site.yml` v1 类型、解析、校验、序列化、revision 和原子保存契约。
- [`src/plugin/settings-tab.ts`](./src/plugin/settings-tab.ts)：当前站点功能设置入口和草稿保存模型。
- [`src/runtime/quartz-engine-store.ts`](./src/runtime/quartz-engine-store.ts)、[`src/runtime/quartz-engine-manifest.ts`](./src/runtime/quartz-engine-manifest.ts)、[`src/runtime/safe-tar-extractor.ts`](./src/runtime/safe-tar-extractor.ts) 与 [`src/runtime/npm-installer.ts`](./src/runtime/npm-installer.ts)：可复用的隔离安装、manifest、完整性、安全提取、取消和原子激活边界。
- [`src/site-builder/quartz-config.ts`](./src/site-builder/quartz-config.ts)、[`src/site-builder/quartz-build-runner.ts`](./src/site-builder/quartz-build-runner.ts)、[`src/site-builder/quartz-site-builder.ts`](./src/site-builder/quartz-site-builder.ts) 与 [`src/site-builder/quartz-output-auditor.ts`](./src/site-builder/quartz-output-auditor.ts)：当前固定主题映射、临时 workspace、macOS network/Vault sandbox 和最终输出安全边界。
- [`tests/quartz-architecture-boundary.test.ts`](./tests/quartz-architecture-boundary.test.ts)、[`tests/quartz-site-builder-real.test.ts`](./tests/quartz-site-builder-real.test.ts) 与 [`tests/quartz-output-auditor.test.ts`](./tests/quartz-output-auditor.test.ts)：上层依赖方向、真实 Quartz build 和隐私/路由/资源负向检查。
- 本机固定 engine `pages-publish-quartz-5.0.0.2` 中的 Quartz 5 `docs/configuration.md`、`docs/layout.md`、`quartz/plugins/loader/*` 与 `@quartz-themes/core@1.1.0` package/types：Quartz 5 原生颜色/字体、自定义 Sass、npm/Git/local plugin、components、frames、layout 和可执行主题能力依据。
- `/Users/ivan/.agents/docs/agents/workflows.md` 与 `/Users/ivan/.agents/docs/agents/handoff-policy.md`：持久化规格和 Source Manifest 要求。

### Produced artifacts

- [`CUSTOM-QUARTZ-THEME-SPEC.md`](./CUSTOM-QUARTZ-THEME-SPEC.md)：外部自定义主题和野兽派验收主题的增量规格。
- [`packages/theme-sdk/`](./packages/theme-sdk/) 与 [`src/theme/`](./src/theme/)：公共 Theme API、安装、缓存、信任、运行时检查、Quartz adapter 和管理服务。
- [`external-themes/brutalist/`](./external-themes/brutalist/)：独立外部主题 package；生产插件只消费打包 `.tgz`。
- [`hats/20260803-custom-quartz-theme/`](./hats/20260803-custom-quartz-theme/)：blank 模式验收环境、报告和视觉证据。

### Key decisions

- 完整自定义主题采用插件外独立可执行 package，而不是仅 CSS/token 或内置主题白名单。
- 首版支持精确 npm 包和本地 `.tgz`；本地工件复制进 `.publish/themes/` 以支持 Vault 重建。
- Theme API 只开放表现层能力；Pages Publish 强制安全配置最后合并且不可覆盖。
- 主题 store 与 immutable Quartz engine 分离；普通构建不执行 npm install。
- 可执行主题采用显式信任模型，并继续受 staging、构建 sandbox、CSP 和 Output Auditor 限制。
- 野兽派主题位于独立 package/repository，Pages Publish 测试只消费打包后的 `.tgz`。

### Verification evidence

- 已检查当前 Quartz 5 固定 engine：原生 theme 支持 typography/lightMode/darkMode，自定义样式入口为 `quartz/styles/custom.scss`。
- 已检查 Quartz 5 plugin loader：支持 npm、Git 和 local source，并能加载 package components 与 frames；这些能力需要由 Pages Publish adapter 收窄后使用。
- 已检查 `@quartz-themes/core@1.1.0`：支持完整 Obsidian theme CSS、variation、aspect、Style Settings 和字体，但缺包时会自行调用 npm install，因此不能直接接收未经验证的用户 theme id。
- `npm run typecheck`、`npm run lint` 与完整测试通过：82 test files，673 passed / 8 environment-gated skipped。
- npm 首次信任候选会从持久化安装收据恢复 registry 发布者信息，并明确标注该信息不是信任根；精确 integrity 仍是工件身份。
- 固定 Quartz 真实测试通过：默认主题与外部 `.tgz` 共 5 tests；外部主题相同 staging 连续两次 files/assets 完全相同。
- release package 恰好只有 `main.js`、`manifest.json`、`styles.css`，未包含野兽派主题 payload。
- HAT run [`20260803-185611`](./hats/20260803-custom-quartz-theme/reports/20260803-185611/summary.md) 自动项通过；1440/768/390/320、浅深色、Search、Graph 和键盘 Escape 已留证据。

### Open questions / risks

- 完整主题是可执行代码，隔离能限制输入和输出，但不能将恶意主题等同于无代码数据；安装 UI 必须准确表达信任风险。
- npm package 尚未发布，真实官方 registry 安装与物理断网缓存复用仍是后续人工 HAT；本地 `.tgz` 路径已完整通过。
- Cloudflare Direct Upload 未获本轮外部写入授权，因此没有作为自动 HAT 执行。
- Obsidian 设置页的首次信任文案、200% 主观可读性和完整键盘顺序仍需人类确认。
