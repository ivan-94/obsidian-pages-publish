# Brutalist Quartz Theme Production UI Spec

> Status: core production shell implemented and visually audited on 2026-08-03.
> The matrix remains the contract for the remaining HAT accessibility and
> content-detail cases; it is not a claim that every future content fixture is
> visually complete.
>
> This document productionises the visual baseline in
> [`BRUTALIST-QUARTZ-THEME-DESIGN.md`](./BRUTALIST-QUARTZ-THEME-DESIGN.md).
> It supersedes that document wherever shell behaviour, responsive allocation,
> overlays, component states or production acceptance differ. The existing
> Pages Publish and Quartz renderer boundaries remain unchanged.

## 1. Product outcome

The Brutalist theme is a content-reading product, not a visual skin or a
permanent dashboard. Its brutalist character must come from deliberate
structure, typography and signal, while a reader can enter a note, understand
where they are and read for a long time without fighting navigation chrome.

The primary outcome is a **content-first adaptive shell**:

- article text is always the visual and spatial priority;
- navigation, outline, search and graph are available immediately but do not
  permanently consume reading space when not in use;
- controls have stable, accessible behaviour across desktop, tablet and
  mobile—not merely smaller CSS;
- every strong visual treatment has one semantic meaning.

This is not a request to make the theme neutral. Hard edges, exposed grids,
monospace labels, high-contrast signal blocks and a publication-like masthead
remain deliberate brand invariants.

## 2. Evidence and problems to solve

The initial 2026-08-03 real-Quartz review found no unreadable body copy, but
identified these production quality gaps. The implemented shell below turns
the first four into regression requirements rather than leaving them as known
defects:

1. At 820px a full Explorer previously remained in the document grid, leaving
   roughly 607px for the article and about 100px for deep navigation labels.
   It must instead be an on-demand drawer.
2. An article H1 previously broke Chinese phrases across visual lines; narrow
   headings must protect phrase boundaries and must not consume most of the
   first screen.
3. Explorer nodes previously used competing borders, hard shadows and panels,
   making folder, ordinary page and current page hard to distinguish. The
   current location must remain both high-contrast and semantic after Quartz
   hydrates the tree.
4. A 390px content page previously gave too much space to permanent shell
   chrome. Navigation controls must remain compact and on-demand.
5. Search, Explorer, TOC and Graph initially behaved mostly as static panels.
   Their production contract requires drawers or dialogs, focus return, scroll
   locking, loading/empty/error states and breakpoint-safe transitions.

## 3. Design principles

### 3.1 Content has first claim on space

- Prose remains within 68–76ch, even when both rails are collapsed.
- Recovered rail space becomes page gutter and a centred reading column; it
  must not turn paragraphs into full-window lines.
- Images, wide tables, diagrams and long code may opt into a wider bounded
  measure without widening ordinary paragraphs.
- No persistent utility may displace article text below a usable reading width.

### 3.2 Every surface has one job

| Surface | Job | May be visually emphatic? |
| --- | --- | --- |
| Article | Read and understand | Yes, through type and pacing |
| Explorer | Locate another note | Only current location and folder state |
| TOC | Locate this section | Only current heading |
| Search | Find content | Only while open |
| Graph | Explore relationships | Only while intentionally invoked |
| Masthead | Identify the publication | Yes, but compact while reading |

Borders, hard shadows, acid fill and inverse panels may not simultaneously
represent ordinary links, controls, selected state and container structure.

### 3.3 State is part of the design

A component is not complete when its resting screenshot looks correct. It must
have defined keyboard, focus, opening, closing, loading, empty, error and
reduced-motion behaviour.

### 3.4 Strong but quiet reading

The theme should feel engineered, not busy. When a reader is inside a note,
the H1, current location and prose each get one clear visual voice. Decorative
or utility detail recedes until explicitly requested.

## 4. Shell geometry

### 4.1 Responsive allocation

| Viewport | Left navigation | Right tools | Article frame |
| --- | --- | --- | --- |
| ≥1280px | 256px dock, user-collapsible to 56px | 232px dock, user-collapsible | centred 68–76ch article |
| 1024–1279px | 56px compact rail by default; full navigation is a drawer | hidden by default; TOC drawer | full remaining reading column |
| 760–1023px | drawer only | TOC drawer only | one reading column |
| <760px | drawer only | TOC in same utility sheet | one reading column, 16px minimum inline gutter |

The `1024px` transition is intentional. A full, multi-level Explorer may not
remain beside an article at iPad-like widths.

### 4.2 Reading modes

The shell exposes two local preferences, stored per browser but never written
to `site.yml`:

- **standard**: rails follow the viewport defaults above;
- **focused**: both rails are hidden and the masthead reduces to a 48px
  reading bar containing the site/home link, current title, outline trigger,
  reading progress and exit control.

Focused mode is explicit. Hovering the viewport edge must never expand a rail
or reflow the article.

### 4.3 Semantic frame requirements

The editorial page frame must render these landmark intentions, even if Quartz
component output remains inside them:

```text
header      publication masthead and shell controls
aside       site navigation (left rail or nav drawer)
main        article and article-local header
aside       article utilities (TOC/graph rail or drawer)
footer      publication footer
```

The article remains the sole page `main`; drawers must not introduce a second
`main` landmark.

## 5. Navigation rail

### 5.1 Expanded dock

The expanded dock is 256px wide, sticky below the masthead and independently
scrollable. It consists of four ordered zones:

1. compact publication status label;
2. utility row: Search, theme mode and collapse control;
3. Explorer tree;
4. secondary routes only when present (graph, privacy, not-found).

Only the dock receives the strong outer border. Search is a full-width control;
the theme and collapse controls are square 44px buttons in the same row.

### 5.2 Tree grammar

| Node type | Type and spacing | Border/shadow rule | State rule |
| --- | --- | --- | --- |
| Folder | 13–14px semibold, 36px row | no card border | chevron rotates; expanded branch gets a 1px guide |
| Ordinary page | 14px regular, 36px row | no card border | hover underlines/inverts only that row |
| Current page | 14px semibold, 40px row | 4px signal start border | inverse or acid background plus `aria-current=page` |
| Nested child | 16px additional indent per level | guide line is secondary, never a box | truncates after two lines |

Folder, page and current-page differences must remain understandable in
grayscale. The Explorer must offer a short navigation label when frontmatter
eventually exposes one; until then, long labels use two-line clamp plus the
native full-title affordance.

### 5.3 Compact rail

The 56px compact rail exposes only labelled icon buttons. It does not attempt
to display a shrunk tree. Activating Navigation opens the same Explorer in a
drawer. Tooltips supplement, but never replace, accessible names.

## 6. Overlay and interaction system

### 6.1 Single owner state model

The theme client owns a small state machine through attributes on `html`:

```text
data-left-rail = expanded | compact | drawer
data-right-rail = expanded | hidden | drawer
data-overlay = none | navigation | outline | search | graph | image
data-reading-mode = standard | focused
```

Rules:

- only one modal overlay may be open at a time;
- opening an overlay closes any drawer and restores its trigger state;
- route navigation closes drawers and search results, except for a deliberate
  same-page anchor jump;
- viewport changes reconcile state before paint: a desktop dock may become a
  closed tablet drawer, never an orphaned visible overlay;
- overlay state is transient; only rail preference and reading mode persist;
- browser Back closes a theme-owned modal/drawer before leaving the page.

### 6.2 Navigation drawer

- Opens from the left on tablet/phone at `min(360px, 88vw)`.
- Uses a backdrop, `aria-modal=true`, labelled dialog semantics, focus trap and
  focus restoration to the exact trigger on close.
- Locks document scroll without changing page width; iOS uses `100dvh` and
  safe-area insets.
- A successful route activation closes the drawer before the new article is
  announced.
- Escape, backdrop pointer press and explicit Close all use the same close
  transition.

### 6.3 Outline drawer

The outline opens from the right on tablet/phone and is a sheet in mobile.
It contains the article title, reading progress and TOC. The current heading
is unique, high contrast and exposed with `aria-current` where supported.
Selecting a heading closes the drawer only on narrow viewports.

### 6.4 Search dialog

Search is a command palette on desktop and a full-screen sheet on narrow
viewports. It must provide:

- initial input focus after opening;
- keyboard-visible result selection;
- loading, empty, error and result states;
- title, location, tags and one bounded excerpt per result;
- Escape close and focus return;
- no nested modal inside a search result.

The existing Quartz search data remains the source of truth; this work changes
only its shell, state management and presentation.

### 6.5 Graph dialog

Graph is an on-demand relationship tool, not a permanent right-rail tax. A
desktop rail may contain a compact summary or trigger, while full interaction
opens a large dialog; narrow viewports use full screen. It needs labelled
loading, empty and failed states before the visual canvas appears.

### 6.6 Small overlays

Tooltips are supplemental and appear on pointer hover or keyboard focus.
Contextual popovers have no backdrop or focus trap. They may not contain
navigation trees, search results or any destructive action.

## 7. Article hierarchy and content primitives

### 7.1 Article head

The head follows this order and no duplicate information is permitted:

```text
section/path label → ancestor breadcrumbs → H1 → reading time and metadata → tags → standfirst
```

- Breadcrumbs show ancestors only; they must not repeat the complete H1.
- Kicker shows a compact route/category label, not a second full title.
- H1 is the only full article title and uses a container-aware scale.
- Metadata and tags occupy one compact group below the title.

### 7.2 Title rules

- The article container declares `container-type: inline-size`.
- H1 uses `clamp(2.75rem, 8cqi, 5.5rem)` on broad layouts and a separately
  audited narrow scale.
- `line-height` stays between 0.92 and 1.02; Chinese uses `line-break: strict`
  and normal word breaking.
- At 390px a representative long Chinese title fits within four visual lines;
  at 1440px it does not split a two-character Chinese word merely to satisfy
  a display scale.

### 7.3 Content primitives

- `h2` is a numbered or ruled editorial interruption, not a full-width primary
  call-to-action-shaped panel on every occurrence.
- Callouts distinguish note, warning and danger through label, border and
  icon—not colour alone.
- Code, tables, figures, captions and footnotes share measured spacing and
  controlled wide-content escape hatches.
- Images have loading, failure and optional lightbox states; image error keeps
  alt text visible.
- Backlinks use an article-closing section, visually quieter than the main
  article conclusion.

## 8. Visual tokens and component rules

The current palette remains valid. Its application is tightened by semantic
tokens:

```text
--stroke-subtle: 1px
--stroke-structural: 2px
--stroke-emphasis: 4px
--shadow-control: 3px 3px 0
--shadow-feature: 7px 7px 0
--space-1..8: 4, 8, 12, 16, 24, 32, 48, 72px
--rail-compact: 56px
--rail-expanded: 256px
--article-measure: 76ch
```

Usage rules:

- 4px strokes are reserved for page/rail boundaries, primary current state and
  major editorial interruptions.
- 3px hard shadow belongs to controls; 7px belongs to a rare featured surface.
- ordinary navigation rows have neither hard shadow nor card border.
- acid index colour marks current navigation, one editorial section treatment
  or one discovery surface; it is not a generic hover colour everywhere.
- orange signal marks action, progress or warning. Blue remains keyboard-focus
  only. Pink is reserved for rare editorial alert.

## 9. Engineering structure

The implementation stays entirely inside the external theme package:

```text
external-themes/brutalist/
  src/index.js                 descriptor, frames and semantic shell controls
  src/client.js                state machine, focus, dialog and preference logic
  src/styles/tokens.css
  src/styles/shell.css
  src/styles/navigation.css
  src/styles/article.css
  src/styles/overlays.css
  src/styles/responsive.css
```

The package build copies only declared production assets to `dist/`; the
descriptor declares the ordered style list. Theme code may decorate or compose
Quartz presentation components, but may not change Pages Publish selection,
visibility, routing, canonical URLs, output auditing or deployment behaviour.

The first implementation should style the existing Quartz Explorer, Search,
TOC and Graph. A replacement component is justified only if the existing DOM
cannot meet a specified behaviour after an evidence-backed attempt; it must
not be introduced merely to gain aesthetic control.

## 10. Implementation slices

### Slice A — Tokens and content-first frame

- split the monolithic stylesheet into ordered layers;
- add rail-width, article-measure and component-semantic tokens;
- make article geometry container-aware;
- remove duplicate article-head information;
- establish desktop/compact/tablet/mobile shell breakpoints.

**Done when:** 1440, 1024, 820 and 390 screenshots have stable title wrapping,
no horizontal overflow and readable article measure.

### Slice B — Navigation and reading focus

- add shell controls, expanded/compact/drawer rail states and persistence;
- rebuild Explorer hierarchy grammar and current state;
- add focused reading mode;
- preserve current Quartz Explorer’s route and visibility semantics.

**Done when:** a reader can collapse both rails, retain a bounded prose line
length, open navigation from every breakpoint and return focus correctly.

### Slice C — Dialogs, drawers and utility states

- implement single-overlay coordination, backdrop, focus trap, scroll lock and
  breakpoint reconciliation;
- productionise Search, TOC and Graph shells;
- add loading, empty and error presentation.

**Done when:** Escape, Back, keyboard traversal, route changes and mobile
viewport changes leave no stale overlay, focus or scroll-lock state.

### Slice D — Content-detail pass

- refine headings, callouts, table/code/figure primitives and image states;
- audit light/dark contrast and hard-shadow frequency;
- add component-level visual regression fixtures.

**Done when:** the rich HAT Vault is readable at every target viewport without
turning content primitives into repeated competing posters.

## 11. Production acceptance matrix

### Viewports and content

- 390×844, 430×932, 820×1180, 1024×768, 1280×900 and 1440×1000;
- one-line, medium, long Chinese, mixed Latin/Unicode and four-level nested
  notes;
- tables, code, callouts, Mermaid, images, missing images and long captions;
- light and dark mode; standard and focused reading mode.

### Interaction and accessibility

- all shell controls have 44×44px targets and discernible labels;
- keyboard-only open/close/select flow for navigation, TOC, search and graph;
- correct focus restoration and no interaction with inert background content;
- 200% zoom, reduced motion, browser Back and direct `#heading` URL;
- delayed Explorer hydration never changes the reader’s scroll position;
- no horizontal overflow, clipped focus outline or header overlap.

### Quality gates

- visual review compares before/after screenshots at every target viewport;
- functional tests cover state transitions and persistence boundaries;
- packed-theme smoke, real Quartz build and visibility/canonical/CSP checks
  continue to pass unchanged;
- HAT records human results for drawer, dialog, keyboard and long-form reading
  rather than treating static screenshots as sufficient proof.

## 12. Source Manifest

### Sources

- User direction on 2026-08-03: good UI requires Apple-level attention to
  detail; content is first-class; sidebars must collapse to create focused
  reading space; drawers and dialogs are part of the required design.
- [`BRUTALIST-QUARTZ-THEME-DESIGN.md`](./BRUTALIST-QUARTZ-THEME-DESIGN.md):
  implemented baseline visual language and external-theme boundary.
- [`CUSTOM-QUARTZ-THEME-SPEC.md`](./CUSTOM-QUARTZ-THEME-SPEC.md): stable theme
  package, renderer and safety contracts.
- [`external-themes/brutalist/src/index.js`](./external-themes/brutalist/src/index.js),
  [`external-themes/brutalist/src/styles/`](./external-themes/brutalist/src/styles/)
  and [`client.js`](./external-themes/brutalist/src/client.js): current
  descriptor, frame, ordered CSS layers and interaction implementation.
- [`hats/20260803-custom-quartz-theme/human-report.md`](./hats/20260803-custom-quartz-theme/human-report.md)
  and its Chrome long-form evidence: real Quartz fixture and earlier responsive
  verification.

### Produced artifacts

- This production UI specification.

### Key decisions

- Keep the theme’s brutalist identity; remove uncontrolled repetition of its
  strongest treatments.
- Make the article the spatial priority and convert rails into compact rails or
  accessible drawers before tablet widths become cramped.
- Treat drawers, dialogs, focus, scroll lock and responsive state changes as
  first-class theme behaviour.
- Keep all work inside the external theme package and preserve existing Pages
  Publish/Quartz ownership boundaries.

### Verification evidence

- Current real-Quartz Chrome review exercised 1440×1000, 1024×768, 820×1180,
  390×844 and 320×844 long-form pages. At 820px the Explorer is a modal
  drawer; at 390px the title uses protected CJK phrase spans; at 320px both
  standard and focused reading preserve 16px inline content gutters with no
  horizontal scroll.
- The Explorer current page is high-contrast and receives `aria-current=page`
  plus a native full-title affordance after asynchronous Quartz hydration.
- Search, image preview and native Graph were previously rechecked as labelled
  dialogs with focus return, inert background and zero horizontal overflow;
  their implementation remains covered by the external-theme state tests.

### Open questions / risks

- Existing Quartz component DOM may limit exact dialog semantics; Slice C must
  document any adapter gaps before replacing a presentation component.
- Browser Back integration must not conflict with Quartz’s SPA router.
- A future optional short navigation title needs an explicit content metadata
  contract; it is not introduced by this UI spec.
