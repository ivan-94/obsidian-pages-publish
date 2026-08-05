# Pages Publish UI 还原与视图层重构规格

> 状态：已完成（2026-08-05）
>
> 日期：2026-08-05
>
> 适用范围：Pages Publish Obsidian 插件内全部用户可见界面
>
> 技术结论：保留现有领域层和应用服务，以 Preact + TypeScript/TSX 重构自定义视图；Obsidian 继续负责宿主生命周期、原生设置、菜单、弹窗、Notice、图标与全局入口。

## 1. 文档目的

本规格定义如何把 Open Design 原型还原到真实 Obsidian 插件中，同时完成 UI 层的组件化重构。它回答四个实现问题：

1. 哪些原型内容应被生产代码还原，哪些只是模拟 Obsidian 宿主的展示壳。
2. Preact、Obsidian Plugin API 与现有 `PagesPublishApplication` 各自负责什么。
3. 页面、组件、状态、样式、响应式和可访问性应如何组织。
4. 如何逐页迁移、验证并回退，避免一次性重写影响现有发布语义。

本文件是实现规格，不取代以下文档：

- `PRODUCT-SPEC.md`：产品能力、业务状态和安全不变量。
- `UI-SPEC.MD`：早期信息架构与交互原型。
- `DESIGN.md`：Obsidian-native 视觉原则。
- Open Design 原型与 `obsidian-pages-redesign-plan.md`：本轮视觉目标和全量页面设计。

发生冲突时，按第 4 节的事实优先级处理。

## 2. 已确认决策

### 2.1 技术决策

- 使用 Preact 作为自定义视图的声明式渲染层。
- 使用 TypeScript + TSX；继续沿用当前 esbuild、Vitest、ESLint 和单包插件结构。
- 不引入 Vite 运行时、前端路由、SSR、Redux、Zustand 或通用 SPA 外壳。
- 不整体引入 Ant Design、MUI、Chakra、Tailwind UI 或其他带完整视觉皮肤的组件库。
- 建立 Pages Publish 内部 UI Kit；它只封装原型中稳定重复的布局、状态和 Obsidian 桥接行为。
- `Menu`、`Modal`、`Notice`、`PluginSettingTab`、Ribbon、状态栏和工作区 `ItemView` 生命周期继续由 Obsidian API 管理。
- 领域对象、发布语义、Cloudflare 行为、配置 schema、扫描器和本地存储模型不因本轮 UI 改造而变化。

### 2.2 产品与视觉决策

- 原型的内容区域、信息层级、布局节奏、状态语言和交互模式是目标。
- 原型模拟的 macOS 标题栏、Obsidian Ribbon、Vault 侧栏、标签栏和全局状态栏不是插件要重新绘制的内容。
- 生产界面继承 Obsidian 字体、明暗主题和语义颜色；不复制原型中的固定白色 Apple 皮肤。
- 发布中心是唯一整站发布入口；文章检查器只管理单篇意图、检查与预览。
- 设置保存、扫描、预览、远端绑定、域名连接和整站发布必须继续表现为不同操作。
- 主题管理拆为独立主工作区，但只重组既有视图能力，不改变主题数据模型。

## 3. 范围与非目标

### 3.1 本轮包含

- 发布中心与文章审阅详情。
- 首次设置和环境准备。
- 当前文章发布检查器。
- 插件设置页。
- 独立主题管理页。
- 站点配置修复页。
- 本地安全日志页与诊断导出复核。
- 统一确认 Modal。
- Ribbon、命令、Markdown 菜单、状态栏和 Notice 的文案与状态一致性。
- Preact 挂载、卸载、Obsidian 组件桥接、设计 token、共享组件和组件测试基础设施。
- 默认明暗主题、窄分栏、200% 缩放、键盘和长内容的视觉验收。

### 3.2 本轮不包含

- 重写 `PagesPublishApplication` 或把现有服务迁移到前端 store。
- 修改发布快照、完整构建、部署协调、Cloudflare API、Frontmatter 或配置 schema。
- 重绘 Cloudflare OAuth 浏览器页、Quartz 读者站点或 Obsidian 自身界面。
- 新增发布历史、回滚、分析、评论、远端项目删除或强制发布。
- 移动端产品设计；仍需保证桌面窄分栏和高缩放可用。
- 为了匹配静态原型而伪造尚不存在的数据、进度或远端动作。

## 4. 事实来源与冲突裁决

### 4.1 优先级

实现中发现冲突时采用以下优先级：

1. 当前 TypeScript 领域模型、应用服务、测试和安全不变量。
2. `PRODUCT-SPEC.md` 中已确认的业务语义。
3. Open Design 的七个页面 HTML 与 `assets/obsidian-ui.css`。
4. Open Design 的 `obsidian-pages-redesign-plan.md`。
5. `DESIGN.md` 的 Obsidian-native 设计纪律。
6. `UI-SPEC.MD` 历史线框。
7. `brand-spec.md` 的固定 Apple 视觉数值。

### 4.2 原型还原规则

- 还原任务结构、阅读顺序、操作层级、组件形态、间距关系、圆角等级和状态表达。
- 颜色、字体、焦点和控件皮肤映射到 Obsidian 语义变量，不直接复制 `#ffffff`、Apple Blue 或 SF Pro 声明。
- HTML 原型中的演示数据只用于 fixture，不进入默认配置或生产逻辑。
- 原型交互与真实服务冲突时，以真实服务能力为准，并在 UI 中展示真实不可用原因。
- 原型遗漏真实代码状态时必须补齐，不允许为了视觉简化删掉协调恢复、配置冲突、未来版本只读或主题信任等状态。

### 4.3 页面映射

| 原型文件 | 生产表面 | 当前入口 | 目标实现 |
| --- | --- | --- | --- |
| `publish-center.html` | 发布中心 | `src/plugin/view.ts` | `PublishCenterScreen` |
| `setup-wizard.html` | 首次设置 | `src/plugin/view.ts` | `SetupWizardScreen` |
| `article-inspector.html` | 当前文章侧栏 | `src/plugin/current-article-view.ts` | `CurrentArticleInspector` |
| `plugin-settings.html` | Obsidian 设置页 | `src/plugin/settings-tab.ts` | `SettingsScreen`，挂载在 `PluginSettingTab` 提供的容器内 |
| `theme-manager.html` | 独立主题管理 | 当前嵌在设置页 | 新 `ThemeManagerView` + `ThemeManagerScreen` |
| `site-config-repair.html` | 配置修复 | `src/plugin/site-config-repair-view.ts` | `SiteConfigRepairScreen` |
| `safe-logs.html` | 本地安全日志 | `src/plugin/maintenance-log-view.ts` | `SafeLogsScreen` |
| 各页面内 Modal | 原生确认弹窗 | 多个 `Modal` 子类/内联复核 | 统一 `ConfirmationModal` 适配器 |

## 5. 当前实现基线

当前 UI 是 Obsidian API 上的命令式 DOM：视图类同时保存本地交互状态、订阅应用事件、调用服务、清空容器、创建元素、绑定事件并处理焦点。

主要维护压力：

- `src/plugin/view.ts` 同时承载发布中心、首次设置和发布流程 UI，约 2200 行。
- `src/plugin/settings-tab.ts` 同时承载六类配置、主题全生命周期和维护动作，约 1500 行。
- `src/plugin/current-article-view.ts` 同时承载投影、编辑器、检查、迁移、空状态和确认，约 1200 行。
- `styles.css` 约 2500 行，页面样式、组件样式、宿主修补和响应式规则集中在一个文件。
- 多次 `container.empty()` 后完整重绘，导致焦点恢复、草稿保护和异步竞态需要大量手工标志位。
- UI 自动化测试大量断言源码字符串和具体 CSS 选择器，能阻止结构漂移，但难以验证组件行为和真实视觉。

重构目标不是减少所有代码行，而是把职责分开，让页面结构、业务投影、交互动作和视觉规则分别可测试。

## 6. 目标架构

### 6.1 分层

```text
Obsidian host lifecycle
  ItemView / PluginSettingTab / Modal / Menu / Notice
                    │
                    ▼
View host adapter
  mount / unmount / subscriptions / workspace state / focus return
                    │
                    ▼
Page controller or projection hook
  load / refresh / stale-result guard / busy state / action callbacks
                    │
                    ▼
Preact screen and UI Kit
  layout / semantic markup / local presentation state / accessibility
                    │
                    ▼
PagesPublishApplication and existing domain services
```

依赖只能向下：

- 页面组件不得直接读 Vault、文件系统、SecretStorage 或 Cloudflare client。
- 深层 UI Kit 组件不得导入 `PagesPublishApplication`。
- 页面通过只读 projection 和显式 action props 工作。
- 领域类型可以被 presenter 引用；页面优先使用针对显示整理后的 view model，避免在 JSX 中重复推导业务语义。

### 6.2 Host adapter 职责

每个 Obsidian View 类缩减为以下职责：

- 提供 view type、标题、图标和 workspace state。
- 在 `onOpen()` 中创建根节点并挂载 Preact。
- 注册 Obsidian/Vault/application 订阅。
- 将最新 projection 推送给页面 controller。
- 在 `onClose()` 中取消订阅、终止局部请求并卸载 Preact。
- 调用原生 `Menu`、`Modal`、`Notice` 和工作区导航。
- 保存必须跨重开恢复的最小视图状态，例如发布中心 tab/filter 或固定文章路径。

Host adapter 不再拼装页面内部 DOM。

### 6.3 页面 controller 职责

每个 screen 对应一个 controller 或组合 hook，负责：

- 把 application/domain 状态转换为稳定、可序列化的 view model。
- 管理 loading、refreshing、busy、success、failure 和 stale result。
- 为 mutation 暴露命名动作，例如 `onRescan`、`onToggleInclusion`、`onPreviewSite`。
- 保证同一资源一次只有一个互斥操作；局部操作不冻结无关界面。
- mutation 完成后从 application 重新读取权威状态，不在组件内猜测最终领域结果。
- 为异步错误生成“发生了什么 → 影响什么 → 下一步”结构化消息。

不得把完整 application 对象放进全局 Preact context。允许提供页面级 `actions` 对象，但它只暴露该页面需要的能力。

### 6.4 状态所有权

| 状态类型 | 所有者 | 示例 |
| --- | --- | --- |
| 领域事实 | 现有 application/domain | 扫描结果、部署事实、配置、连接、主题安装状态 |
| 跨重开视图状态 | Host adapter / Obsidian view state | tab、filter、固定文章 |
| 页面局部展示状态 | Preact screen | 搜索词、展开区、当前选中行、临时复核 |
| 表单草稿 | 现有 session/controller | `SetupDraft`、`SiteConfigEditorSession`、文章属性草稿 |
| 异步操作状态 | controller | rescan busy、preview busy、theme operation |
| Modal/Menu/Notice | Obsidian adapter | 高影响确认、更多菜单、动作结果 |

表单草稿不能只存在于一个会因重渲染消失的输入节点中。已有 session/draft 能力继续作为权威草稿；Preact 只持有受控输入值或尚未提交的局部编辑缓冲。

### 6.5 Preact 生命周期契约

提供统一挂载函数，概念接口如下：

```ts
type MountedView = {
  update(input: ViewInput): void;
  unmount(): void;
};

mountPreactView(container: HTMLElement, input: ViewInput): MountedView;
```

要求：

- 同一 host 只创建一个 Preact root。
- 更新通过 props/store signal 完成，不重复清空根节点。
- `onClose()` 必须幂等卸载。
- effect 必须返回清理函数；不得留下 document/window 级监听器。
- 列表 key 使用稳定业务标识，如 `sourcePath`，不得使用数组索引。
- 保留焦点的更新不得替换对应 DOM 节点。

## 7. 依赖与构建配置

### 7.1 生产依赖

新增运行时依赖：

- `preact`

默认不引入 `preact/compat`。只有实际采用某个 React-only 包且经过包体积、样式和可访问性评估后才启用 compat alias。

### 7.2 开发依赖

按测试实现需要增加：

- Preact Testing Library 或等价的 DOM 行为测试工具。
- `jsdom` 或 `happy-dom`，仅用于组件测试环境。
- 可选 axe 集成，用于自动化可访问性检查。

具体包必须在实施时锁定版本并提交 lockfile；不使用浮动版本。

### 7.3 TypeScript/esbuild

- 新 UI 文件使用 `.tsx`。
- `tsconfig.json` 增加 `jsx: react-jsx` 与 `jsxImportSource: preact`。
- esbuild 继续输出单个 CJS `main.js`，`obsidian`、Electron 和宿主模块继续 external。
- 生产构建继续 minify 和 tree-shake。
- 不新增独立浏览器入口、HTML 构建产物或运行时 chunk loader。

### 7.4 包体积与启动预算

- 引入 Preact 基础设施后记录生产 `main.js` 前后大小。
- 仅框架与挂载基础设施造成的 minified 增量目标不超过 50 KiB；超出必须定位原因。
- 完整重构后若 `main.js` 相对基线增加超过 15%，需要单独评审依赖和重复代码。
- View constructor 不执行数据读取或昂贵渲染；真实初始化放在 `onOpen()` 或现有延迟生命周期中。

## 8. 建议目录结构

```text
src/ui/
├─ runtime/
│  ├─ mount-preact-view.tsx
│  ├─ create-view-controller.ts
│  └─ async-operation.ts
├─ obsidian/
│  ├─ obsidian-icon.tsx
│  ├─ obsidian-button.tsx
│  ├─ obsidian-control.tsx
│  ├─ open-menu.ts
│  ├─ open-confirmation-modal.ts
│  └─ notices.ts
├─ components/
│  ├─ page-header.tsx
│  ├─ workbench.tsx
│  ├─ status-summary.tsx
│  ├─ status-label.tsx
│  ├─ inline-alert.tsx
│  ├─ task-progress.tsx
│  ├─ tab-bar.tsx
│  ├─ filter-bar.tsx
│  ├─ sticky-action-bar.tsx
│  ├─ empty-state.tsx
│  ├─ intent-vs-online.tsx
│  └─ issue-list.tsx
├─ publish-center/
│  ├─ publish-center-controller.ts
│  ├─ publish-center-model.ts
│  ├─ publish-center-screen.tsx
│  ├─ content-table.tsx
│  ├─ compact-content-list.tsx
│  └─ review-pane.tsx
├─ setup/
├─ article-inspector/
├─ settings/
├─ theme-manager/
├─ config-repair/
├─ safe-logs/
└─ styles/
   ├─ tokens.css
   ├─ foundations.css
   ├─ components.css
   └─ screens.css
```

这是一种目标组织方式，不要求第一次提交就创建所有空目录。只在对应 slice 开始时增加文件，避免空架构。

## 9. 设计系统还原规则

### 9.1 Token 策略

内部 token 只允许表达 Pages Publish 的语义和尺度，不复制一套与 Obsidian 平行的品牌主题。

| 内部 token | 来源/映射 | 用途 |
| --- | --- | --- |
| `--pp-bg` | `var(--background-primary)` | 页面和主工作台 |
| `--pp-surface` | `var(--background-secondary)` | 次级表面 |
| `--pp-surface-muted` | `var(--background-secondary-alt)` | 工具条、摘要、弱提示 |
| `--pp-text` | `var(--text-normal)` | 主文字 |
| `--pp-text-muted` | `var(--text-muted)` | 辅助文字 |
| `--pp-border` | `var(--background-modifier-border)` | 边界 |
| `--pp-accent` | `var(--interactive-accent)` | 主操作、选择、焦点 |
| `--pp-success` | `var(--text-success)` | 成功 |
| `--pp-warning` | `var(--text-warning)` | 警告 |
| `--pp-danger` | `var(--text-error)` | 阻塞、失败、危险动作 |
| `--pp-radius-control` | `var(--radius-s)` | 字段和按钮 |
| `--pp-radius-panel` | `var(--radius-m)`，必要时局部 fallback | 工作台、可独立操作表面 |

间距优先使用 Obsidian `--size-*` 变量；只有原型中稳定重复且宿主没有等价值时才增加 `--pp-space-*`。

### 9.2 排版层级

- Page identity：站点名或任务名，使用宿主中等标题尺度，不复制营销页 40–80px display 字号。
- Section title：任务区标题，靠字号、字重和间距建立层级。
- Row title：文章名、字段名和操作对象。
- Supporting text：路径、说明、时间和影响，使用 muted 颜色。
- Code text：路径、URL、Frontmatter、hash、YAML，使用 `--font-monospace`。
- 中文、Unicode slug、混合中英文和长路径必须可换行或可恢复读取。

### 9.3 表面与边界

- 页面是连续工具工作台，不把每个区段都做成独立卡片。
- 只有拥有独立状态或操作边界的区域使用 panel/surface。
- 主工作台允许轻边框和轻阴影；普通设置行、列表分组和元数据区不使用重复阴影。
- 同一页面最多一个视觉最强 Primary。
- 禁止玻璃效果、品牌渐变、装饰性插画和大面积强调色。

### 9.4 图标

- 图标名称来自 Obsidian/Lucide 集合，并通过 `setIcon()` 桥接。
- 非交互图标渲染到 `span`，不得用 `ButtonComponent` 伪装。
- 图标按钮必须有 `aria-label` 和 tooltip。
- 状态图标同时配文字；颜色不是唯一信号。

### 9.5 CSS 作用域

- 所有规则位于 `.pages-publish-ui` 或更具体页面根类下。
- 允许显式添加到本插件 host 的类，例如文章侧栏 host class。
- 禁止依赖宽泛祖先 `:has()` 重排 Obsidian 宿主。
- 禁止覆盖全局 `button`、`input`、`.workspace`、`.setting-item` 等选择器。
- 不使用内联样式表达稳定视觉；动态尺寸/进度确有必要时使用受控 CSS custom property。
- container query 基于插件根容器，不基于整个窗口。

## 10. UI Kit 组件契约

### 10.1 基础组件

| 组件 | 职责 | 关键要求 |
| --- | --- | --- |
| `PageHeader` | 页面身份、元数据和安全全局动作 | 标题可换行；动作窄屏换行；不承载页面完成动作 |
| `Workbench` | 连续任务区域 | 可组合 toolbar/body/detail；只有一个主工作台表面 |
| `StatusSummary` | 汇总连接、扫描、变化和线上事实 | 不把 unknown 显示成 success |
| `StatusLabel` | 行级状态 | icon + text；tone 只控制强调，不改变语义 |
| `InlineAlert` | 当前最高优先级问题/下一步 | 一个 alert 一个主要信息；支持 action |
| `TaskProgress` | 环境、首次设置、发布阶段 | upcoming/active/complete/failed；不显示伪百分比 |
| `TabBar` | 页面内模式切换 | roving/focus 行为明确；`aria-selected` |
| `FilterBar` | 搜索与筛选 | 清除动作可访问；无结果不等于无内容 |
| `StickyActionBar` | 页面完成动作 | 说明状态、禁用原因、唯一 Primary；窄屏可回归普通流 |
| `EmptyState` | 无内容或不可用状态 | 必须给出真实下一步；无无效操作区 |
| `IntentVsOnline` | 待发布意图与线上事实对比 | 明确 same/changed/first/takedown/unknown |
| `IssueList` | Blocker/Warning 定位 | 影响、来源、位置、动作；Blocker 优先 |

### 10.2 Obsidian 桥接组件

- `ObsidianIcon`：在稳定 span ref 上调用 `setIcon()`；icon 变化时更新。
- `ObsidianButton`：封装 `ButtonComponent` 或一致的原生按钮契约，支持 default/cta/destructive/icon-only、busy、disabled reason 和 tooltip。
- `ObsidianDropdown`、`ObsidianText`、`ObsidianToggle`：仅在直接使用原生组件能提高主题兼容时封装；复杂 radio/listbox 使用语义 HTML 并继承宿主变量。
- `openConfirmationModal()`：创建原生 `Modal`，返回 `Promise<boolean>` 或结构化结果。
- `openContextMenu()`：只暴露菜单项模型，不让 screen 管理 `Menu` 实例。
- `notifyActionResult()`：统一 Notice 文案和去重策略。

桥接组件必须验证卸载清理，避免 Obsidian component 在 Preact diff 后仍持有失效 DOM。

## 11. 屏幕级实施规格

### 11.1 发布中心

#### 页面目标

首屏回答：下一版会变什么、什么阻止发布、现在能否安全发布。

#### 组件结构

```text
PublishCenterScreen
├─ PageHeader
├─ PublishSnapshotSummary
├─ PriorityGateArea
├─ Workbench
│  ├─ TabBar + FilterBar
│  └─ PublishCenterWorkspace
│     ├─ ContentTable | CompactContentList | IssueList
│     └─ ReviewPane
└─ PublicationActionBar
   └─ PublicationProgress when active/result
```

#### 还原要求

- 宽屏表格、右侧审阅 pane、紧凑摘要、问题 gate 和底部发布条与原型层级一致。
- `>= 900px` 列表与审阅并排；`< 900px` 审阅替换列表并提供明确返回。
- `问题` tab 直接显示问题列表，不重复展示一份文章表。
- 行末是 chevron，不使用伪菜单省略号。
- 文章完整意图编辑跳转到文章检查器；发布中心只允许“下一版包含”快速审阅。
- 发布进度使用 prepare/build/upload/activate 四阶段。
- reconciliation-required 与 upload-uncertain 必须有专门恢复状态。

#### Controller 边界

- 复用 `getPublishCenter()`、`getPublicationStatus()`、`subscribePublicationStatus()`、`setPublishCenterInclusion()`、`requestScan()` 和预览/发布方法。
- 保留当前防止扫描订阅自触发循环的约束，但把协调逻辑放进 controller 测试。
- 选中项详情异步返回时校验 selection key，过期结果不得覆盖新选择。

#### 完成标准

- 所有现有发布中心业务测试继续通过。
- tab/filter/search/selection 在刷新后按设计保留。
- 发布中关闭并重开 view 能恢复观察任务。
- Blocker 永远禁用发布并就地说明原因；Warning 不禁用。

### 11.2 首次设置

#### 组件结构

```text
SetupWizardScreen
├─ SetupHeader
├─ TaskProgress
├─ EnvironmentStep | SiteStep | ContentStep | CloudflareStep | ReviewStep
└─ SetupActionBar
```

#### 还原要求

- Stepper 使用真实图标和 `aria-current`，不使用符号文本模拟。
- 环境准备阶段展示真实动作、影响、修复和技术详情。
- 内容目录与公开路径成对编辑；完成扫描前不能继续。
- Vault 根目录必须有独立确认。
- Cloudflare 以连接 → 账号 → 项目 → 域名渐进展开；完成的子阶段折叠为摘要。
- OAuth 为默认路径，API token 位于高级展开区。
- 最终复核明确列出“将执行 / 不会执行”。
- 失败保留 draft 和 review，不把用户退回空向导。

#### 状态保存

- `SetupDraft` 继续由 application 保存。
- 当前步骤可以由 view state 恢复，但不能绕过前置校验。
- 离开时必须保留安全草稿并明确未创建站点。

### 11.3 当前文章检查器

#### 组件结构

```text
CurrentArticleInspector
├─ InspectorHeader
├─ InspectorBody
│  ├─ ArticleIdentity
│  ├─ IntentVsOnline
│  ├─ VisibilityEditor
│  ├─ RouteEditor
│  ├─ IssueList
│  ├─ PublicationProperties
│  └─ AdvancedFacts
└─ InspectorActionBar
```

#### 还原要求

- 固定头、可滚动正文和稳定操作区互不抢滚动。
- 路径可完整读取并可复制；窄栏显示单行摘要但不丢失完整信息。
- 当前线上与下一版状态使用两行对比，不混成一个 badge。
- 公开方式和待发布 URL 是高频编辑，置于检查之前。
- Blocker/Warning 有定位动作；有问题时检查区默认展开。
- 只展开当前编辑字段；草稿遇外部变化时保留输入并要求复核。
- 非文章、范围外、配置缺失等空状态只保留真实下一步。
- 面板不提供整站发布按钮。

#### 焦点要求

- 文件切换不在用户编辑字段时打断输入。
- 保存/取消后焦点返回该字段动作。
- pin 切换使用 `aria-pressed`；固定目标丢失时给出恢复动作。

### 11.4 插件设置页

#### 宿主约束

- 保留 `PluginSettingTab.getSettingDefinitions()` 入口和 Obsidian 搜索集成。
- Preact 只挂载在该定义提供的插件容器中，不重绘设置侧栏或宿主页面。
- 设置标题、原生控件与 section 语义遵循最低支持 Obsidian 版本。

#### 页面结构

- Header：站点身份、clean/dirty/conflict/readonly 状态和安全入口。
- Anchor navigation：站点与内容、Cloudflare、站点功能、主题、本地环境。
- 常用字段使用原生 Setting 视觉，不为每行建卡片。
- 主题只展示摘要、内置选择和“管理主题”。
- 维护操作进入配置修复、日志或主题管理独立页。
- 底部保存条包含状态、放弃/验证和唯一 Primary“保存设置”。

#### 状态要求

- missing config：提供开始设置。
- future version：只读，不允许保存或远端动作。
- dirty：远端动作禁用并解释先保存/放弃。
- conflict：提供重载、查看影响、保留草稿；禁止静默覆盖。
- URL/内容根变化：在保存前展示影响和线上后果。
- 保存成功只描述本地配置和重新扫描，不称为发布成功。

### 11.5 主题管理

#### 新 View 边界

- 新增独立 `ItemView`，只组合现有 `ThemeManagementService` 和设置草稿/session。
- 从设置页进入；返回时设置草稿仍存在。
- 主题选择、选项修改仍通过设置保存后生效，不创造第二套持久化入口。

#### 页面结构

- 当前主题摘要。
- npm 精确版本 / 本地 `.tgz` 获取方式。
- 安装、导入、修复单任务状态和取消。
- 信任复核：来源、发布者、integrity、执行能力、clientScripts。
- 已验证版本列表与卸载状态。
- schema 驱动主题选项。
- 返回设置与预览已保存主题。

#### 安全要求

- 未信任代码不进入可执行路径。
- 取消与失败保留上一个有效主题。
- 选项解析错误保留旧有效值并就地提示。
- 不在 UI 中弱化本地主题和 npm 主题的来源差异。

### 11.6 配置修复

- 使用等宽 YAML 编辑器、同步行号、独立滚动和校验结果区。
- 磁盘版本按需展开，不自动替换当前草稿。
- 外部 revision 冲突必须停止保存并允许重新读取。
- 放弃草稿使用有取消项的确认，不使用无限时双击确认。
- 唯一 Primary 是“验证并保存修复”；明确保存不会发布。
- 第一阶段可继续使用 textarea，不在本轮引入 CodeMirror 依赖；只有真实编辑能力需要时另立规格。

### 11.7 本地安全日志

- 当前只有本次会话时移除无意义范围下拉框。
- 表格展示时间、阶段、代码和非敏感计数；严重度为 icon + text。
- 空状态解释日志何时出现和下一步。
- 导出前展示 included/excluded，确认后写本地文件并反馈路径。
- 不展示 token、Authorization、私密正文或不必要的绝对私密路径。

### 11.8 全局入口与确认

- Ribbon 继续打开当前最需要的 setup/publish center。
- 状态栏只在需要注意或跟踪任务时出现，并返回产生状态的上下文。
- Menu 使用原生样式，异步可用性有明确 loading/disabled 文案。
- Notice 只报告主动操作结果、重要连接变化和后台任务完成。
- Confirmation Modal 统一字段：对象、数量、本地影响、线上影响、生效时机、可恢复性、取消、确认。
- 诊断导出和主题信任使用“复核”语气；待下线和配置移除使用危险语气。

## 12. 响应式与容器规则

### 12.1 主工作区

| 容器宽度 | 行为 |
| --- | --- |
| `>= 900px` | 完整表格；发布中心列表与详情可并排；头部动作单行优先 |
| `640–899px` | 精简次要列；详情替换列表；工具条允许两行 |
| `< 640px` | 内容条目列表；无页面级横向滚动；sticky bar 回归普通流或紧凑堆叠 |

### 12.2 文章侧栏

- 以实际容器宽度设计，不复用主页面断点。
- `<= 320px` 时字段标签和动作重新排布，路径/URL 不撑宽容器。
- 底部动作允许纵向堆叠，但 Primary 保持最后且清晰。

### 12.3 高缩放

- 在 macOS Obsidian 200% 缩放下验证相当于窄容器的布局。
- 不用固定高度截断中文文案、错误或状态说明。
- sticky 元素不得遮挡最后一行内容或与 Obsidian 标签栏冲突。

## 13. 可访问性与键盘契约

- 所有任务可只用键盘完成。
- DOM 顺序与视觉顺序一致；不依靠 CSS order 制造反向阅读顺序。
- tab、step、toggle、selection 使用 `aria-selected`、`aria-current`、`aria-pressed` 或原生表单语义。
- 图标按钮有可访问名称；tooltip 不是关键说明的唯一载体。
- Modal 打开时焦点进入，关闭后返回触发器；由 Obsidian Modal 负责焦点陷阱。
- Review pane 打开先聚焦返回/关闭；关闭后回到原文章行。
- 局部刷新保留搜索、筛选和正在编辑字段的焦点。
- 发布、扫描、保存等长任务使用克制的 live region，只播报阶段变化和最终结果。
- 错误列表使用可定位结构；状态不只靠颜色。
- disabled 控件附近必须有可读取原因。
- 所有交互元素有明显 `:focus-visible`，并在明暗主题下验证对比度。

## 14. 测试与视觉还原闭环

### 14.1 测试层级

1. 领域/应用测试：保持现有测试，不因 Preact 迁移降低覆盖。
2. Presenter/controller 测试：纯数据投影、异步竞态、busy 互斥和动作结果。
3. 组件行为测试：用户可见文本、语义角色、键盘、表单和 action 回调。
4. Host adapter 测试：mount/unmount、订阅清理、workspace state 和 Modal/Menu/Notice 桥接。
5. 视觉 HAT：真实 Obsidian 中按固定 fixture、主题和容器截图。

### 14.2 现有测试迁移

- 业务行为断言原样保留或迁移到 controller，不删除后以截图代替。
- `publish-center-a11y.test.ts` 中依赖手写 Element mock 的测试逐步替换为真实 Preact DOM 行为测试。
- `ui-style-smoke.test.ts` 中源码字符串/CSS 正则断言保留少量架构守卫，其余改为组件语义和 HAT 验收。
- 每迁移一个页面，先让旧行为测试继续通过，再删除只针对旧 DOM 拼装方式的断言。
- 不在同一个提交中同时删除旧断言和新增未验证页面。

### 14.3 Fixture

建立安全、确定性的 UI fixture，覆盖：

- 中文标题、长路径、Unicode slug、混合中英文。
- added、updated、url-changed、visibility-changed、takedown、unknown。
- public、unlisted、private。
- success、warning、blocker、loading、empty、failure、conflict、readonly。
- 首次发布、无 baseline、正常发布、四阶段、协调恢复。
- 主题 builtin/npm/local、可信/未信任/损坏/选项错误。
- 不含真实 token、文章正文或个人私密路径。

fixture 数量和页面统计必须自洽，并能从一个命令或开发入口恢复。

### 14.4 截图矩阵

每个页面至少验证：

| 维度 | 必验值 |
| --- | --- |
| 主题 | Obsidian 默认 light、默认 dark |
| 主工作区宽度 | 1200、800、600 CSS px |
| 文章侧栏宽度 | 360、280 CSS px |
| 缩放 | 100%、200% |
| 内容 | 正常、长文本、empty、loading、最高风险 error/busy |
| 浮层 | 该页面最关键的 Modal 或 review pane open |

不是每个状态都做全排列；每个页面选择能覆盖结构风险的最小矩阵，并在 HAT 中列清楚。

### 14.5 视觉修复循环

每个页面按以下循环执行，最多六轮：

1. 用与原型一致或已记录换算关系的 viewport/state 截取目标和当前实现。
2. 按布局/层级、间距/对齐、字体、颜色、图标、状态、响应式列出可执行 diff。
3. 只修复本轮有证据的差异；重复规律沉淀为 token 或组件。
4. 重截 light/dark 和相关断点，运行 lint/typecheck/test/build。
5. 没有明显结构、层级、对齐、状态语言或响应式问题后结束。

不追求截图逐像素完全相同；目标是原型设计纪律在真实 Obsidian 宿主中的等价实现。

### 14.6 每个 Slice 的验证命令

至少执行：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

若完整测试成本过高，可在开发循环先运行相关 Vitest 文件，但 slice 完成前必须跑完整命令。

## 15. 分阶段迁移计划

迁移采用纵向 slice，不进行 big-bang rewrite。任一时刻每个页面只有一个生产实现。

### Phase 0：基线与可复现视觉环境

工作：

- 记录当前 `main.js` 大小、构建时间和相关测试结果。
- 建立安全 UI fixture 与 Obsidian 开发 Vault 启动说明。
- 截取当前实现的关键页面 light/dark/宽窄基线。
- 建立截图命名、artifact 目录和视觉 diff 报告模板。

退出条件：下一位实现者能用文档和命令重建同一状态与截图。

### Phase 1：Preact 与 UI Kit 基础

工作：

- 添加 Preact/TSX 配置和 mount/unmount helper。
- 实现 token、foundation、ObsidianIcon、Button、StatusLabel、InlineAlert、EmptyState。
- 添加 host adapter 清理测试和组件测试环境。
- 用一个隔离测试 view 验证明暗主题、卸载和焦点。

退出条件：基础设施通过 lint/typecheck/test/build，且没有改变生产页面行为。

### Phase 2：低风险工具页

顺序：

1. Safe Logs。
2. Site Config Repair。
3. 统一 Confirmation Modal。

目的：验证表格、空状态、编辑草稿、原生 Modal 和 sticky action bar，不先触碰发布主流程。

退出条件：旧页面实现删除；功能和安全测试保留；截图矩阵通过。

### Phase 3：当前文章检查器

工作：

- 提取 article inspector view model 和 actions。
- 迁移 identity、IntentVsOnline、检查、属性编辑、空状态和底部操作。
- 验证文件切换、pin、草稿外部变化和窄栏焦点。

退出条件：九种文章状态、七种非文章状态、360/280 宽和 light/dark 验收通过。

### Phase 4：发布中心

工作：

- 提取 publish center controller，保留扫描/发布协调约束。
- 迁移 header、snapshot、gate、tabs、filter、table/list、review pane 和 action bar。
- 覆盖四阶段发布、失败、reconciliation 和 upload uncertain。

退出条件：P0 发布安全矩阵、1200/800/600、关闭重开恢复和键盘主流程通过。

### Phase 5：首次设置

工作：

- 把 setup 从原发布视图拆成独立 screen/controller。
- 迁移环境、站点、范围、Cloudflare 子阶段、确认和执行结果。
- 验证退出/恢复草稿、错误重试和 OAuth/API token 分层。

退出条件：首次建站全过程可键盘完成；任何失败不会丢草稿或产生未确认远端变化。

### Phase 6：设置与主题管理

工作：

- 迁移设置文档和保存条。
- 新建 Theme Manager ItemView，复用既有服务与同一设置 session。
- 覆盖 clean/dirty/conflict/readonly 和主题全生命周期。

退出条件：设置页认知负担符合原型；主题选择仍只能通过设置保存生效；返回路径保留草稿。

### Phase 7：全局一致性与收尾

工作：

- 统一 Ribbon、命令、Menu、状态栏和 Notice 文案。
- 拆分/删除旧 `styles.css` 中已迁移规则和宿主 hack。
- 清理旧 DOM helper、无用 focus 标志和源码字符串测试。
- 执行全量截图矩阵、200% 缩放、键盘和长内容 HAT。

退出条件：满足第 18 节 Definition of Done。

## 16. 提交与回退策略

- 每个 Phase 可拆成多个可独立构建的提交，但一个页面的 production switch 应保持原子性。
- 新 Preact 页面通过同一个 view type 接管，不创建两个用户可见的重复入口。
- 页面切换提交之前，旧实现继续是生产路径；切换并通过验证后再删除旧 DOM 方法和 CSS。
- 不长期维护 runtime feature flag；如某页迁移风险高，可用短期开发常量进行本地对照，但不得进入正式发布。
- 回退以页面为单位恢复旧 host adapter/render 文件，不回滚领域层或数据文件。
- 不改变 persisted view state 字段含义；需要增加字段时提供缺省值并兼容旧 workspace state。

## 17. 风险与控制

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| Preact 与 Obsidian component 同时管理同一 DOM | 节点失效、事件泄漏 | 桥接组件独占子容器；effect cleanup；host adapter 测试 |
| 完整重渲染改变焦点/草稿 | 编辑中断 | 稳定 key、受控草稿、局部更新、焦点回归测试 |
| 原型固定 Apple 视觉污染主题 | dark/community theme 不可用 | token 映射；禁止固定品牌色和全局字体 |
| 重型库增加包体积和启动时间 | 插件加载退化 | 仅 Preact；体积预算；依赖评审 |
| 设置页过度自定义宿主 | Obsidian 升级兼容风险 | 保留 PluginSettingTab/Setting 语义；根类作用域 |
| 旧测试依赖 DOM 拼装细节 | 重构困难或误删覆盖 | 分层迁移；业务断言先转 controller/component test |
| 静态原型遗漏真实异常 | 上线后无恢复入口 | 以代码状态矩阵为准；fixture 补齐异常 |
| Theme Manager 新 ItemView 与草稿分叉 | 两套配置事实 | 共用 SiteConfigEditorSession；保存入口唯一 |
| 宿主 CSS 变量版本差异 | 最低版本显示异常 | 在 Obsidian 1.13.0 验证；必要时局部 fallback |

## 18. Definition of Done

UI 全量还原与重构只有同时满足以下条件才算完成：

### 架构

- [x] 自定义页面使用 Preact/TSX，Obsidian host 类不再拼装页面内部 DOM。
- [x] 页面只通过 projection/actions 访问 application，UI Kit 不依赖领域服务。
- [x] mount/unmount、订阅、请求和原生组件桥接无泄漏。
- [x] 旧大文件按职责拆分，未留下两套生产实现。

### 视觉

- [x] 原型的主层级、关键对齐、工作台结构、状态语言和响应式行为已还原。
- [x] 默认 light/dark、宽/中/窄工作区、文章窄侧栏和 200% 风险级缩放通过。
- [x] 无页面级横向滚动、遮挡、错位、不可读截断或失效 sticky 区。
- [x] 重复视觉规律已沉淀为 token 或组件；必要宿主适配集中在页面根作用域。

### 交互与安全

- [x] 发布中心、文章检查器、设置和主题管理职责清晰且无重复权威入口。
- [x] 设置、扫描、预览、远端动作与发布语义未混淆。
- [x] Blocker、Warning、失败、协调恢复和危险确认满足现有产品不变量。
- [x] loading、empty、error、active、long text、missing data 和 Modal/open 状态已覆盖。
- [x] 主流程保留原生可聚焦控件、焦点回归与 live region 行为。

### 工程验证

- [x] `npm run lint` 通过。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过。
- [x] `npm run build` 通过。
- [x] 包体积通过：`main.js` 2,309,613 bytes，低于迁移前基线 2,315,165 bytes。
- [x] HAT 保存截图、断点、主题、状态、差异与剩余缺口。

## 19. 实施产物清单

实现阶段应逐步产出：

- Preact runtime 与 Obsidian bridge。
- Pages Publish UI Kit 和 token 文档。
- 各 screen/controller/view model。
- 新 Theme Manager ItemView。
- 安全、确定性的 UI fixture。
- controller/component/host adapter 测试。
- 页面视觉 diff 报告与截图 artifact。
- 最终 HAT guide、结果和未解决差异清单。

## Source Manifest

### Sources

- 用户明确指令（2026-08-05）：接受“Obsidian 原生外壳 + Preact 组件化视图”方案，并要求创建详细 UI 还原与 UI 层重构 spec。
- 用户明确纠正（2026-08-05）：视觉还原对象是七个 HTML 文件及其共享 CSS，不是项目目录中的图像文件。
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/PRODUCT-SPEC.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/UI-SPEC.MD`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/DESIGN.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/package.json`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/esbuild.config.mjs`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tsconfig.json`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/styles.css`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/application.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/view.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/current-article-view.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/settings-tab.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/site-config-repair-view.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/maintenance-log-view.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/global-ui-state.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/publication/publish-center.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/publication/current-article-panel.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/config/site-settings.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/setup/site-setup.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/theme/theme-management.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/maintenance/maintenance-service.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tests/ui-style-smoke.test.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tests/publish-center-a11y.test.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tests/current-article-view.test.ts`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tests/settings-tab.test.ts`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/obsidian-pages-redesign-plan.md`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/brand-spec.md`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/publish-center.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/setup-wizard.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/article-inspector.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/plugin-settings.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/theme-manager.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/site-config-repair.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/safe-logs.html`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/assets/obsidian-ui.css`
- `/Users/ivan/Library/Application Support/Open Design/namespaces/release-stable/data/projects/02a2cbf9-7d07-4e78-8acd-f40ccae5080c/assets/prototype.js`

### Produced artifacts

- `/Users/ivan/workspace/ai/obsidian-pages-plugin/UI-REDESIGN-IMPLEMENTATION-SPEC.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/ui/`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/view.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/current-article-view.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/settings-tab.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/site-config-repair-view.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/maintenance-log-view.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/src/plugin/theme-manager-view.tsx`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/docs/ui-redesign/baseline.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/docs/ui-redesign/tokens.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/hats/20260805-ui-redesign/`

### Key decisions

- 保留现有领域层与 `PagesPublishApplication`，只重构视图组织和渲染方式。
- Preact 是自定义页面的声明式渲染层；Obsidian API 继续拥有宿主生命周期和原生交互表面。
- 不采用重型通用组件库；以 Obsidian 语义变量和小型内部 UI Kit 还原原型。
- 原型的宿主模拟壳不进入生产实现；固定 Apple 色值让位于 Obsidian 明暗主题兼容。
- 采用逐页纵向 slice 和截图驱动视觉闭环，不进行全量一次性替换。
- 主题管理拆为独立 ItemView，但与设置页共用草稿和唯一保存语义。

### Verification evidence

- 七个 Open Design HTML 与 `assets/obsidian-ui.css` 逐页映射到 Preact screen 和作用域样式；图像不作为实现事实来源。
- 真实 Obsidian 1.13.4 隔离 Vault 已验收发布中心、初始化向导、文章检查器、设置、主题管理、配置修复和安全日志。
- 已保存 light、dark、宽屏、窄侧栏和高缩放截图；文章窄栏 URL 断行问题在 HAT 中发现、修复并复验。
- `npm test -- --run`：90 files passed / 5 skipped；661 tests passed / 9 skipped。
- `npm run typecheck`、`npm run lint`、`npm run build` 与 `git diff --check` 均通过。
- 构建产物与隔离 Vault 中安装副本的 SHA-256 一致；详见 `hats/20260805-ui-redesign/summary.md`。

### Open questions / risks

- 本轮真实宿主为 Obsidian 1.13.4；最低声明版本 1.13.0 的宿主级视觉回归仍应在发布前常规兼容矩阵中保留。
- Open Design HTML 使用固定演示数据；生产截图使用真实 HAT Vault 数据，因此文案和值不同，但结构、层级和组件形态按 HTML 还原。
- 两张早期偏离 HTML 的截图留在 HAT artifact 目录作为 rejected baseline，不作为验收证据。
