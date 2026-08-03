# HAT Run Logs — 20260803-185611

## Prepare

- `bash -n hats/20260803-custom-quartz-theme/prepare.sh` → PASS
- shellcheck → not available
- `prepare.sh prepare` → `status=prepared`
- Seed → notes:4, themes:1
- External actions → none

## Package boundary

Command summary:

```text
release/pages-publish-0.1.0/main.js
release/pages-publish-0.1.0/manifest.json
release/pages-publish-0.1.0/styles.css
count=3
theme payload scan=no external theme payload found
```

## Static and unit verification

```text
npm run lint
PASS

npm test
Test Files 77 passed | 5 skipped (82)
Tests 673 passed | 8 skipped (681)
```

Final trust-UI regression adds coverage that registry publisher data survives the
immutable install receipt and is shown only as informational identity metadata;
the exact integrity remains the trust identity.

Skipped tests are environment-gated real runtime/benchmark tests; the relevant real Quartz tests were executed separately below.

## External theme package

```text
external-themes/brutalist: npm test
3 passed, 0 failed

npm pack
files=8
unpacked=22.9 kB
lifecycle scripts=none
```

## Real Quartz

Environment:

```text
PAGES_PUBLISH_QUARTZ_ENGINE=/tmp/pages-publish-quartz-engine-74b3fc9e
PAGES_PUBLISH_NODE22=/Users/ivan/.nvm/versions/node/v22.17.1/bin/node
PAGES_PUBLISH_BRUTALIST_THEME=external-themes/brutalist/artifacts/pages-publish-theme-brutalist-1.0.0.tgz
```

Command:

```text
npx vitest run tests/brutalist-theme-real.test.ts tests/quartz-real-smoke.test.ts tests/quartz-site-builder-real.test.ts
Test Files 3 passed (3)
Tests 5 passed (5)
```

Assertions include unchanged SiteBuilder façade, poster/editorial frames, clientScripts, theme CSS/assets/options, CSP, local graph vendor assets, public/unlisted/private, sitemap/contentIndex, default Quartz regression, sandbox and deterministic repeated output.

## Browser

- Desktop 1440×1000: 72px header; columns 252/900/288; `scrollWidth=innerWidth`; Graph canvas=1.
- Tablet 768×1024: no horizontal overflow; two-column + full-width utility rail.
- Mobile 390×844: no horizontal overflow; frame uses flex column; article single visible H1; dark toggle 44×44.
- Mobile 320×667: no horizontal overflow; Search overlay exactly viewport size; input auto-focused.
- Keyboard: Escape closes Search, `aria-expanded=false`, focus returns to button.
- Reduced motion: theme bundle contains `@media (prefers-reduced-motion: reduce)`; full OS-level subjective check remains manual.

## Safety notes

- No npm publish, registry install, Cloudflare write or cleanup was performed.
- No secret, token or external account identifier appears in this report.
