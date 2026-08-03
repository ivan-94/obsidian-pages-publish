# PROTOTYPE — Brutalist Quartz Theme

> Throwaway UI prototype. Delete after a direction is selected and the decision is captured in the external theme design/spec.

## Question

在不改变 Pages Publish 内容、可见性和路由契约的前提下，一个深度定制的野兽派 Quartz 主题应该采用哪种站点结构和交互层级？

## Run

```bash
node prototypes/brutalist-quartz-theme/serve.mjs
```

Open `http://127.0.0.1:4177/?variant=A`.

Use `http://127.0.0.1:4177/narrow.html?variant=A` for the 390×844 responsive harness.

- `A`：编辑部索引。Quartz default frame 的激进重构，Explorer / Article / Graph + TOC 三栏并置。
- `B`：海报堆叠。full-width frame，顶部导航，超大文章标题，Graph 和 Backlinks 下沉为内容章节。
- `C`：控制台。自定义 frame，Explorer 和 Graph/Search 成为工具面板，暗色优先。
- 底部箭头或键盘 `←` / `→` 切换方向。
- `/` 打开搜索原型；页面按钮切换浅色/深色。

## Quartz capability mapping

| Prototype element | Quartz 5 capability |
| --- | --- |
| 三栏、全宽和控制台 shell | default/full-width/custom Page Frame |
| Header、左右栏和正文前后顺序 | layout positions, groups, priorities, byPageType |
| Explorer、Search、Darkmode | 当前启用的 component plugins |
| Graph、TOC、Backlinks | 当前启用的右栏 plugins，可被主题重新布局/包裹 |
| Article title、meta、tags、breadcrumbs | 当前 beforeBody plugins |
| 视觉系统 | theme colors/typography + package styles |
| 搜索弹层、folder disclosure | package components + client scripts |

## Verdict

Proposed hybrid recorded in [`BRUTALIST-QUARTZ-THEME-DESIGN.md`](../../BRUTALIST-QUARTZ-THEME-DESIGN.md):

- B supplies the discovery identity for home/folder/tag pages.
- A supplies the long-form article frame.
- C supplies the component language for Search, Explorer, Graph, TOC and other utility surfaces.

Confirmed by the user on 2026-08-03. Keep the prototype only until the real Quartz theme has equivalent visual coverage, then delete or absorb it.

## Source Manifest

### Sources

- [`CUSTOM-QUARTZ-THEME-SPEC.md`](../../CUSTOM-QUARTZ-THEME-SPEC.md)
- [`src/site-builder/quartz-config.ts`](../../src/site-builder/quartz-config.ts)
- Pinned Quartz 5 `docs/layout.md`, `docs/configuration.md`, Page Frames and component plugin layout behavior in the managed engine.
- User instruction on 2026-08-03 to design a deeply customized brutalist UI theme before implementing the theme package spec.

### Produced artifacts

- This throwaway prototype directory.

### Key decisions

- Compare three structurally different directions on one route rather than colour-only variants.
- Use only capabilities that can map to Quartz theme config, component plugins, layout groups/byPageType and custom frames/components.

### Verification evidence

- A, B and C reviewed at desktop and in the 390×844 responsive harness.
- Search sheet and light/dark toggle exercised successfully.
- JavaScript syntax and repository whitespace checks passed.

### Open questions / risks

- Production implementation must preserve the confirmed A+B+C division of responsibilities.
- Prototype markup approximates Quartz component output; production theme must be rebuilt against real Quartz DOM and Page Frame APIs.
