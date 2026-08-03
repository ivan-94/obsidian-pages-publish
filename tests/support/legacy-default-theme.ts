export const defaultThemePath = '/assets/default-theme.css';

export const defaultThemeCss = `
:root {
  color-scheme: light dark;
  --page-bg: Canvas;
  --page-text: CanvasText;
  --page-link: LinkText;
  --page-muted: GrayText;
  --page-border: color-mix(in srgb, CanvasText 22%, Canvas);
  --page-panel: color-mix(in srgb, CanvasText 5%, Canvas);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.7;
}

* { box-sizing: border-box; }

html { overflow-wrap: anywhere; }

body {
  min-width: 0;
  margin: 0;
  background: var(--page-bg);
  color: var(--page-text);
}

a { color: var(--page-link); text-underline-offset: 0.18em; }
a:hover { text-decoration-thickness: 0.14em; }
:focus-visible { outline: 0.2rem solid var(--page-link); outline-offset: 0.2rem; }

.skip-link {
  position: fixed;
  inset-block-start: 0.5rem;
  inset-inline-start: 0.5rem;
  z-index: 10;
  padding: 0.55rem 0.8rem;
  transform: translateY(-150%);
  background: var(--page-bg);
  border: 1px solid var(--page-border);
}
.skip-link:focus { transform: translateY(0); }

[data-pages-preview="local"] {
  padding: 0.5rem clamp(1rem, 4vw, 2rem);
  text-align: center;
  border-block-end: 1px solid var(--page-border);
  color: var(--page-muted);
  background: var(--page-panel);
}

.site-header,
main,
footer {
  width: min(100% - 2rem, 72rem);
  margin-inline: auto;
}

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 1rem;
  border-block-end: 1px solid var(--page-border);
}
.site-header > a { color: inherit; font-weight: 700; text-decoration: none; }
.site-header nav { display: flex; flex-wrap: wrap; gap: 1rem; }

main { min-height: 65vh; padding-block: clamp(2rem, 6vw, 5rem); }
main > * { max-width: 72ch; margin-inline: auto; }
.site-hero { padding-block-end: 1.5rem; }
h1 { font-size: clamp(2rem, 7vw, 4rem); line-height: 1.08; letter-spacing: -0.025em; }
h2, h3 { line-height: 1.25; }
p, li { max-width: 68ch; }

pre,
table {
  max-width: 100%;
  overflow-x: auto;
}
pre {
  padding: 1rem;
  border: 1px solid var(--page-border);
  border-radius: 0.5rem;
  background: var(--page-panel);
}
code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
table { display: block; border-collapse: collapse; }
th, td { padding: 0.55rem 0.75rem; border: 1px solid var(--page-border); }

img,
svg {
  max-width: 100%;
  height: auto;
}

.callout {
  padding: 1rem 1.2rem;
  border-inline-start: 0.25rem solid var(--page-link);
  background: var(--page-panel);
}
.task-list-item { list-style: none; }
.task-list-item-checkbox { margin-inline: -1.2rem 0.45rem; }
[data-pages-route-summary] {
  padding: 1rem;
  border: 1px dashed var(--page-border);
  color: var(--page-muted);
}
footer { padding-block: 2rem; border-block-start: 1px solid var(--page-border); color: var(--page-muted); }

@media (max-width: 40rem) {
  .site-header { align-items: flex-start; flex-direction: column; }
  main { padding-block: 2rem; }
  h1 { font-size: clamp(2rem, 12vw, 3rem); }
}
`;
