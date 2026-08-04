# Brutalist Quartz Theme UI Design

> Status: baseline implemented on 2026-08-03 in the external
> `@pages-publish-theme/brutalist` package; automated visual HAT passed with
> manual accessibility review remaining. Production-level shell behaviour,
> responsive allocation, overlays and visual quality gates are specified in
> [`BRUTALIST-THEME-PRODUCTION-SPEC.md`](./BRUTALIST-THEME-PRODUCTION-SPEC.md).

## 1. Design decision

The theme will use one visual system with page-type-specific Quartz frames instead of forcing every page into one shell:

| Quartz page type | Proposed frame | Prototype source | Purpose |
| --- | --- | --- | --- |
| home, folder and tag index | `brutalist-poster` | B — 海报堆叠 | Establish identity, expose sections and featured entries as a public index |
| content article | `brutalist-editorial` | A — 编辑部索引 | Preserve long-form readability while keeping Explorer, TOC and Graph visibly structural |
| search, graph, Explorer and utility surfaces | `brutalist-instrument` component language | C — 控制台 | Give tools a shared status, numbering and panel grammar without turning the article into a dashboard |
| 404, privacy and other system pages | `brutalist-minimal` | reduced A | Keep system routes unmistakable and independent from article navigation |

This is a deliberate hybrid. B is the strongest identity for discovery pages, A is the best reading frame, and C is most useful as a component language rather than the permanent site shell.

## 2. Design character

The concept is **a public field-notes press**: unfinished knowledge is presented as a maintained publication, not a polished marketing site or a faux terminal.

The interface should feel:

- structural: borders, columns and numbering reveal information architecture;
- direct: links, controls and active state look interactive without relying on subtle colour changes;
- editorial: typography and pacing support long Chinese and mixed-language reading;
- alive: issue numbers, public-page counts and graph state communicate that the garden changes;
- trustworthy: public/unlisted/private boundaries remain engine-owned and are never reinterpreted by the theme.

“Brutalist” does not mean arbitrary ugliness. The system uses aggressive contrast and exposed structure, but spacing, text measure and responsive hierarchy stay disciplined.

## 3. Visual system

### 3.1 Colour tokens

Light is the primary editorial mode; dark is a first-class equivalent.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `paper` | `#F0ECE2` | `#151515` | page background |
| `panel` | `#F7F2E8` | `#202020` | panels and article surfaces |
| `ink` | `#151515` | `#F2EEE4` | text and structural lines |
| `signal` | `#FF4B17` | `#FF5A1F` | active state, issue marker, callout |
| `index` | `#FFE600` | `#D8FF00` | index cards and discovery emphasis |
| `focus` | `#0067FF` | `#6EA3FF` | keyboard focus only |
| `alert` | `#FF2E68` | `#FF4C89` | rare editorial annotation |
| `muted` | `#67645E` | `#AAA59B` | secondary metadata with AA contrast |

Rules:

- Large colour blocks may use `signal`, `index` or `alert`; body copy does not.
- Focus blue is reserved for focus indication so it is never confused with decoration.
- No gradients, transparency blur or low-contrast hairlines.
- Colour never carries state alone; label, underline, border or position also changes.

### 3.2 Type

- Display: local theme-provided heavy grotesk when available; fallback to `Arial Black`, `Arial`, `Noto Sans SC`, system sans-serif.
- Body: system sans-serif, 17–19px desktop, 16–18px narrow, line height 1.65–1.8, maximum readable measure 72ch.
- Interface and metadata: system monospace, uppercase Latin labels allowed, Chinese labels stay unforced.
- Article titles use tight leading and responsive `clamp()`, but may not overlap adjacent slots or clip at 200% zoom.
- A font can only ship when its licence permits redistribution inside the external theme package.

### 3.3 Shape, spacing and motion

- Radius: `0` everywhere except native platform focus/accessibility affordances.
- Structural border: 4px; internal divider: 2px; dense tool divider: 1px at sufficient contrast.
- Hard shadow: `7px 7px 0`; never blurred.
- Spacing grid: 4, 8, 12, 16, 24, 32, 48, 72px.
- Minimum interactive target: 44×44px.
- Motion is direct and short, normally 80–140ms. No parallax, inertial panels or decorative looping animation.
- `prefers-reduced-motion` removes all nonessential transitions and blinking status treatments.

## 4. Page frames

### 4.1 `brutalist-poster`: home, folder and tag pages

The discovery frame starts with a publication masthead, a single-line status/ticker band and a large index hero. Its purpose is to answer: what is this garden, what changed, and where can I enter?

Desktop order:

1. Wordmark + primary navigation + Search/Darkmode.
2. Public index status band.
3. Oversized section or featured-entry hero with issue/section number.
4. Folder/tag cards in a hard grid.
5. Recent entries and Graph as full-width editorial modules.
6. Publication footer with build attribution and public count.

The home page must not masquerade as an article. Folder and tag pages reuse the frame but replace the featured hero with their title, summary and entry count.

### 4.2 `brutalist-editorial`: content pages

Desktop uses three structural regions:

```text
Explorer / index | breadcrumbs + article + backlinks | Graph + TOC + next
```

- Left and right regions are visibly bounded, not floating cards.
- Article copy remains visually dominant and is capped at a readable line length.
- The title block contains article number, title, dates, reading time and tags.
- TOC active state uses a solid inverse row plus a left index marker.
- Backlinks become the article’s closing editorial section, not a small afterthought.
- Graph is compact by default; explicit activation opens the larger utility surface.

### 4.3 `brutalist-instrument`: utility component language

Search, Explorer, Graph, TOC and status panels borrow C’s instrument grammar:

- monospace panel headers;
- stable labels such as `SEARCH`, `INDEX`, `GRAPH`, `ON THIS PAGE`;
- item counts aligned opposite labels;
- explicit selected/expanded state;
- black/ink headers and high-contrast active rows;
- status copy that describes real state only—no fake command-line theatre.

Search opens as a full viewport sheet on narrow screens and a bordered modal/sheet on desktop. Results expose title, section, tags and a short match excerpt. Keyboard navigation must remain native and visible.

## 5. Quartz component mapping

| Theme surface | Quartz capability | Theme treatment |
| --- | --- | --- |
| Page shells | `layout.byPageType` + Page Frames | choose poster/editorial/minimal by page type |
| Header/footer | `header`, `footer` slots or package components | publication masthead and status footer |
| Explorer | existing component plugin wrapped by theme | numbered index with strong disclosure state |
| Search | existing Search data plus theme component/client script | editorial result sheet |
| Darkmode | existing component plugin | two-state labelled control, no hidden third mode |
| Article title/meta/tags/breadcrumbs | existing `beforeBody` components | composed title block, not duplicated data |
| TOC/Graph | existing right-slot plugins | instrument panels; Graph can expand |
| Backlinks | existing `afterBody` plugin | closing related-reading grid |
| Page body | Quartz-rendered content | typography and content primitives only |

The external theme may replace presentation components and frames through the Theme SDK, but it may not replace content discovery, route ownership, visibility filtering, canonical URLs, redirects or system-route generation.

## 6. Responsive behaviour

### Wide: over 1100px

- Editorial frame uses three columns.
- Poster frame keeps the numbered hero and summary side rail.
- Utility panels may remain sticky when their content fits the viewport.

### Medium: 761–1100px

- Editorial right tools become a full-width row below the article.
- Explorer remains available but must not squeeze article copy below 45ch.
- Poster summary moves below the hero.

### Narrow: 760px and below

- One content column; no horizontal scrolling at 320px CSS width.
- Masthead reduces to wordmark, Search and Darkmode.
- Explorer becomes a direct toggle/sheet and is not expanded above article content.
- Poster issue number changes from vertical to horizontal.
- Graph, TOC and Backlinks stack after article content unless explicitly opened.
- Sticky controls must not cover anchors or consume more than 20% of a 667px-high viewport.

Validation widths: 320, 390, 768, 1024 and 1440px; also test 200% zoom.

## 7. Interaction and accessibility

- Keyboard focus: 4px `focus` outline with 2px offset, never removed.
- Hover: invert foreground/background or use a large colour block; underline remains for inline links.
- Current page and active TOC item expose `aria-current` in addition to visual state.
- Folder toggles expose `aria-expanded`; Search is a named dialog/sheet and restores focus on close.
- Heading hierarchy comes from Quartz content and may not be changed for visual sizing.
- Contrast target: WCAG AA for text and controls in both colour modes.
- Light/dark preference is preserved by the existing Quartz mechanism.
- Decorative numbers, ticker text and graph ornament are hidden from the accessibility tree when redundant.

## 8. Options exposed by the theme

Keep the public options small so this remains a designed theme rather than a page builder:

- `wordmark`: plain text site mark;
- `accent`: one of the theme’s audited signal palettes;
- `homeHero`: latest entry, fixed page or section index;
- `showPublicCount`: boolean;
- `graphMode`: compact or expanded-on-demand.

Border width, radius, shadows, type scale and frame allocation are theme invariants, not end-user knobs.

## 9. Visual acceptance

The implementation is visually acceptable when:

- home/folder/tag pages and content pages are recognisably one publication but structurally different;
- removing colour still leaves hierarchy understandable through borders, scale, labels and order;
- a long Chinese article remains comfortable to read and never becomes a dashboard;
- all current Quartz surfaces—Explorer, Search, Darkmode, Graph, TOC, Backlinks and tags—share the same component grammar;
- 320px width, 200% zoom, keyboard-only use and reduced motion do not lose content or controls;
- private content stays absent and unlisted content stays out of discovery surfaces;
- the result cannot reasonably be mistaken for Quartz’s default theme with a CSS colour override.

## 10. Prototype

The throwaway comparison is in [`prototypes/brutalist-quartz-theme`](./prototypes/brutalist-quartz-theme/README.md).

Run:

```bash
node prototypes/brutalist-quartz-theme/serve.mjs
```

Then open `http://127.0.0.1:4177/?variant=A` and switch A/B/C with the bottom controls or arrow keys. The prototype is not production markup; implementation must be rebuilt against the pinned Quartz DOM, components and Page Frame APIs.

## Source Manifest

### Sources

- User requirements in this task: deep Quartz customization, external theme packaging and a Brutalist UI design before implementation.
- [`CUSTOM-QUARTZ-THEME-SPEC.md`](./CUSTOM-QUARTZ-THEME-SPEC.md): Theme SDK, package, safety and acceptance boundaries.
- [`src/site-builder/quartz-config.ts`](./src/site-builder/quartz-config.ts): currently enabled Quartz components and layout integration.
- Managed Quartz 5 documentation: `docs/layout.md` and Page Frame/component layout behaviour from the pinned engine.
- [`prototypes/brutalist-quartz-theme`](./prototypes/brutalist-quartz-theme/README.md): three responsive structural experiments.

### Produced artifacts

- This design decision and UI contract.
- The throwaway A/B/C browser prototype.
- [`external-themes/brutalist/`](./external-themes/brutalist/) production package with poster, editorial and minimal Quartz Page Frames.
- [`hats/20260803-custom-quartz-theme/reports/20260803-185611/`](./hats/20260803-custom-quartz-theme/reports/20260803-185611/) real Quartz visual evidence and acceptance report.

### Key decisions

- Use page-type-specific frames under one visual system.
- Adopt B for discovery identity, A for article reading and C for utility component grammar.
- Keep privacy, content and route semantics outside the theme boundary.

### Verification evidence

- A, B and C reviewed at desktop and a 390×844 responsive harness.
- Search sheet and light/dark toggle exercised in the browser prototype.
- Prototype source passes JavaScript syntax checks and repository whitespace checks.
- Production theme reviewed at 1440×1000, 768×1024, 390×844 and 320×667 with no horizontal overflow.
- Real Quartz Search, Explorer, Darkmode and Graph exercised; 320px Search fills the viewport and returns focus on Escape.
- Real packed-theme build, light/dark visuals, single article-title hierarchy and deterministic repeated output passed.

### Open questions / risks

- The default wordmark is `PUBLIC FIELD NOTES`; a final brand wordmark can be supplied through the bounded `wordmark` option.
- No redistributable display font is bundled; the accepted first release uses the documented local system-font stack.
- 200% subjective readability and the complete keyboard traversal remain manual HAT items.
- The A+B+C hybrid was confirmed by the user on 2026-08-03.
