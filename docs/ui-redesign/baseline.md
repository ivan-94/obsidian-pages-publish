# UI redesign baseline

> Captured: 2026-08-05

> Final implementation review: 2026-08-05

## Automated baseline

| Check | Result | Wall time |
| --- | --- | --- |
| `npm run lint` | passed | 9.88 s |
| `npm run typecheck` | passed | 2.48 s |
| `npm test` | 79 files passed, 5 skipped; 697 tests passed, 9 skipped | 4.40 s |
| `npm run build` | passed | 3.08 s |
| production `main.js` | 2,315,165 bytes | — |

## Initial visual baseline (pre-migration)

- Open Design target files are recorded in `UI-REDESIGN-IMPLEMENTATION-SPEC.md`.
- Current production screens still use the legacy imperative DOM implementation.
- Existing real Obsidian 1.13.4 evidence provides light, dark, drawer, narrow and 200% states for the main production surfaces:
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/publish-center-light-baseline.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260801-213000/artifacts/publish-center-drawer-wide-dark.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/publish-center-200-percent.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/current-article-light-restored.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/current-article-dark.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/current-article-200-percent.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260801-223000/artifacts/settings-clean-light.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/settings-dark.jpeg`
  - `hats/20260801-s17-release-candidate/reports/20260802-064500/artifacts/settings-200-percent-fixed.jpeg`
- The Open Design HTML and shared CSS remain the read-only visual contract; image exports are not used as layout specifications.

## Initial visual diff

- Layout/hierarchy: the current publish center is a linear document with weak grouping; the target is a continuous workbench with a compact snapshot, a bounded review area and a stable action dock.
- Density/alignment: current metric buttons and tabs read as unrelated controls; the target aligns them into one scan-and-review rhythm.
- Article inspector: the current panel gives each section similar visual weight and pushes actions below dense content; the target prioritizes identity, intent-versus-online, frequent edits and checks inside a fixed-header/scroll-body/action-dock shell.
- Settings: the current document is functionally complete but long and visually flat; the target preserves native rows while separating identity, section navigation, theme management and maintenance tools.
- Theme discipline: target geometry is useful, but fixed Apple colors and the simulated Obsidian shell must not be copied into production.

## Final implementation baseline

| Check | Final result |
| --- | --- |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm test -- --run` | 90 files passed, 5 skipped; 661 tests passed, 9 skipped |
| `npm run build` | passed |
| `git diff --check` | passed |
| production `main.js` | 2,309,948 bytes (5,217 bytes below the migration baseline) |

- Visual source of truth: the seven Open Design HTML files plus `assets/obsidian-ui.css`; PNG/drawing files were not used as layout specifications.
- Production surfaces now mount Preact screens from thin Obsidian host adapters and reuse a scoped internal UI kit.
- Real Obsidian 1.13.4 evidence covers every HTML-mapped surface in light mode plus dark, wide, narrow article sidebar and high-zoom risk states.
- The real narrow article-sidebar pass found a URL wrapping defect. The compare grid was changed from three columns to the prototype's two-column rhythm and reverified in Obsidian.
- User feedback removed duplicate visible search labels from publish/log filters and removed the prototype-simulated card shell from the real Obsidian article sidebar.
- Settings feedback removed the global header and shared gray wrapper, promoted each functional section to one gray top-level group, unified controls, kept ordinary fields on one row and reserved full-width rows for long or compound input.
- Full evidence, scenario judgments and artifact hashes are recorded in `hats/20260805-ui-redesign/summary.md`.

## Source Manifest

### Sources

- `/Users/ivan/workspace/ai/obsidian-pages-plugin/UI-REDESIGN-IMPLEMENTATION-SPEC.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/package.json`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/esbuild.config.mjs`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/tests/`
- Baseline commands executed in `/Users/ivan/workspace/ai/obsidian-pages-plugin` on 2026-08-05.

### Produced artifacts

- `/Users/ivan/workspace/ai/obsidian-pages-plugin/docs/ui-redesign/baseline.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/docs/ui-redesign/tokens.md`
- `/Users/ivan/workspace/ai/obsidian-pages-plugin/hats/20260805-ui-redesign/`

### Key decisions

- Preserve the passing baseline while introducing Preact infrastructure before switching production screens.
- Compare later production bundle sizes against 2,315,165 bytes.

### Verification evidence

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `stat -f 'main.js bytes=%z' main.js`
- Real Obsidian 1.13.4 Computer Use review of all seven production surfaces.
- SHA-256 identity check between root build outputs and the isolated test Vault plugin copy.

### Open questions / risks

- Minimum-host visual compatibility should remain part of release testing because this HAT used Obsidian 1.13.4 rather than exactly 1.13.0.
- Early screenshots `light-publish-center-980.png` and `light-settings-900.png` are rejected pre-alignment evidence and are excluded from the final artifact set.
