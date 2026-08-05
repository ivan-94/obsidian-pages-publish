# Pages Publish UI Kit and tokens

The UI kit translates the Open Design HTML grammar into Obsidian-native production components. All rules are scoped below `.pages-publish-ui`; the plugin does not restyle the global Obsidian shell.

## Token mapping

| Purpose | UI token | Obsidian source |
| --- | --- | --- |
| Page background | `--bg` | `--background-primary` |
| Quiet surface | `--surface` | `--background-secondary` |
| Warm/header surface | `--surface-warm` | `--background-primary-alt` |
| Main text | `--fg` | `--text-normal` |
| Secondary text | `--muted` | `--text-muted` |
| Soft rule | `--border-soft` | `--background-modifier-border` |
| Accent | `--accent` | `--interactive-accent` |
| Success/warning/danger | `--success`, `--warn`, `--danger` | Obsidian semantic status colors |
| Interface/mono fonts | `--font-body`, `--font-mono` | Obsidian interface and monospace fonts |

Spacing uses the prototype's 4px rhythm (`--space-1` through `--space-8`). Reusable radii are `8px`, `12px`, `18px` and pill. Interactive controls use a 44px target token. These fixed geometry tokens define the HTML component grammar; colors and fonts remain host-owned.

## Shared component grammar

- `plugin-view`, `compact-page-header`: bounded page identity and top-level actions.
- `workbench`, `workbench-bar`, `workbench-body`: continuous review/install/editor surfaces.
- `compact-note`, `inline-alert`, `state-label`: non-modal status communication with icon and text.
- `field`, `field-row`, `setting-row`, `dense-row`, `key-value-list`: repeated form and fact layouts.
- `tab-list`, `tab-button`, `data-table`, `empty-state`: selectable content workbench.
- `sticky-actions`: stable page decision bar with one primary operation.
- `ObsidianButton`, `ObsidianIcon`, `openConfirmationModal`: ownership-safe bridges to Obsidian imperative components.

## Responsive discipline

- Container queries are based on the actual Obsidian leaf width, not the application window.
- Main workbenches collapse columns before tables become unreadable.
- The article inspector uses its own narrow-sidebar rules; the route comparison is two columns and moves actions below the URL.
- Sticky bars may stack at narrow width but retain status copy and the primary action.
- Paths and long status text use bounded wrapping; the page root hides horizontal overflow only after child grids define `min-width: 0`.

## Source Manifest

### Sources

- `../../UI-REDESIGN-IMPLEMENTATION-SPEC.md`
- `../../styles.css`
- `../../src/ui/`
- Open Design seven HTML files and `assets/obsidian-ui.css` listed in the implementation spec.

### Produced artifacts

- `tokens.md`

### Key decisions

- Obsidian owns theme color, typography and native component behavior.
- Open Design owns page hierarchy, spacing rhythm, component shape and responsive composition.
- Host bridge components own a dedicated child container so Preact and Obsidian never mutate the same node.

### Verification evidence

- `tests/ui-style-smoke.test.ts`
- `tests/ui-preact-runtime.test.tsx`
- `tests/ui-obsidian-button.test.tsx`
- `tests/ui-obsidian-icon.test.tsx`
- `hats/20260805-ui-redesign/summary.md`

### Open questions / risks

- New host versions may rename semantic variables; keep local fallbacks limited to the scoped root.
