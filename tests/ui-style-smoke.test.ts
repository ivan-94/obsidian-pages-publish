import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workspace = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, workspace), 'utf8');

describe('Open Design HTML visual contract', () => {
  it('maps the prototype palette to Obsidian tokens and keeps keyboard focus visible', async () => {
    const styles = await read('styles.css');
    expect(styles).toContain('--bg: var(--background-primary)');
    expect(styles).toContain('--accent: var(--interactive-accent)');
    expect(styles).toMatch(/\.pages-publish-ui :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--pp-accent\);/s);
    expect(styles).not.toContain(':has(');
  });

  it('translates publish-center.html into its snapshot, gates, workbench and table classes', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/publish-center/publish-center-screen.tsx')]);
    expect(screen).toContain('class="plugin-view pc-view"');
    expect(screen).toContain('class="pc-snapshot"');
    expect(screen).toContain('class="pc-gates"');
    expect(screen).toContain('class="data-table pc-table"');
    expect(screen).toContain('data-label="文章"');
    expect(styles).toMatch(/\.pages-publish-ui \.pc-snapshot\s*\{[^}]*grid-template-columns:/s);
    expect(styles).toMatch(/\.pages-publish-ui \.pc-table tbody tr\s*\{[^}]*height:\s*58px;/s);
  });

  it('keeps the publish review as the prototype overlay drawer', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/publish-center/publish-center-screen.tsx')]);
    expect(screen).toContain('class="review-drawer-scrim"');
    expect(screen).toContain('class="review-pane"');
    expect(screen).toContain('class="pc-drawer-body"');
    expect(styles).toMatch(/\.pages-publish-ui \.review-pane\s*\{[^}]*position:\s*fixed;/s);
  });

  it('keeps the current article on the article-inspector HTML structure', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/article-inspector/article-inspector-screen.tsx')]);
    expect(screen).toContain('class="article-inspector"');
    expect(screen).not.toContain('class="inspector-header"');
    expect(screen).not.toContain('className="inspector-pin"');
    expect(screen).toContain('class="inspector-body"');
    expect(screen).toContain('class="compare-block"');
    expect(styles).toMatch(/\.pages-publish-ui \.article-inspector\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.article-inspector\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
    expect(styles).toMatch(/\.pages-publish-article-panel\s*\{[^}]*background:\s*var\(--background-secondary\);[^}]*padding:\s*0;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.inspector-actions\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toContain('grid-template-columns: 64px minmax(0, 1fr) auto');
    expect(styles).toContain('.pages-publish-ui .compare-block dd:nth-of-type(2)');
    expect(styles).toMatch(/\.pages-publish-ui \.pp-inspector-section\s*\{[^}]*border:\s*0;[^}]*border-bottom:/s);
  });

  it('keeps plugin-settings.html section order and sticky decision bar', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/settings/settings-screen.tsx')]);
    expect(screen).toMatch(/id="site"[\s\S]*id="cloudflare"[\s\S]*id="features"[\s\S]*id="theme"[\s\S]*id="environment"/);
    expect(screen).toContain('class="settings-section"');
    expect(screen).not.toContain('class="settings-hero"');
    expect(screen).toContain('setting-row${wide ?');
    expect(screen).toContain('class="sticky-actions settings-actions"');
    expect(styles).toMatch(/\.pages-publish-ui \.settings-section\s*\{[^}]*background:\s*var\(--background-secondary\);[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-md\);/s);
    expect(styles).toMatch(/\.pages-publish-settings\s*\{[^}]*background:\s*var\(--background-primary\) !important;[^}]*border:\s*0 !important;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.setting-row\s*\{[^}]*grid-template-columns:\s*minmax\(160px, \.8fr\) minmax\(240px, 1\.2fr\);/s);
    expect(styles).toContain('.pages-publish-ui .setting-row.is-wide');
    expect(styles).toMatch(/\.pages-publish-ui \.setting-control > select\s*\{[^}]*max-width:\s*100%;[^}]*width:\s*auto;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.pp-settings-select-action\s*\{[^}]*grid-template-columns:\s*max-content auto;/s);
    expect(styles).toContain('@container (max-width: 440px)');
  });

  it('keeps setup-wizard.html progression and bounded panel', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/setup/setup-wizard-screen.tsx')]);
    expect(screen).toContain('class="plugin-view setup-shell"');
    expect(screen).toContain('class="setup-progress"');
    expect(screen).toContain('class="setup-panel"');
    expect(screen).toContain('title="不会执行"');
    expect(styles).toMatch(/\.pages-publish-ui \.setup-progress\s*\{[^}]*grid-template-columns:\s*repeat\(5, 1fr\);/s);
  });

  it('keeps theme-manager.html workbenches, preview and dense theme rows', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/theme-manager/theme-manager-screen.tsx')]);
    expect(screen).toContain('class="current-theme-panel"');
    expect(screen).toContain('class="theme-preview"');
    expect(screen).toContain('class="workbench install-panel"');
    expect(screen).toContain('查看并使用');
    expect(styles).toContain('.pages-publish-ui .theme-option');
    expect(styles).toMatch(/\.pages-publish-ui \.theme-meta\s*\{[^}]*padding:\s*0;/s);
  });

  it('normalizes native form controls across every Preact screen', async () => {
    const styles = await read('styles.css');
    expect(styles).toContain("input:not([type='checkbox']):not([type='radio']):not([type='file']), select, textarea");
    expect(styles).toMatch(/\.pages-publish-ui input\[type='file'\]::file-selector-button\s*\{[^}]*border-radius:/s);
    expect(styles).toMatch(/\.pages-publish-ui \.input-shell input\s*\{[^}]*border:\s*0;[^}]*min-height:\s*0;[^}]*padding:\s*0;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.checkbox-hit input\s*\{[^}]*appearance:\s*none;[^}]*border-radius:\s*5px;/s);
    expect(styles).toMatch(/\.pages-publish-ui \.checkbox-hit input:checked\s*\{[^}]*background:\s*var\(--accent\);/s);
  });

  it('keeps site-config-repair.html on the YAML and validation split', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/config-repair/config-repair-screen.tsx')]);
    expect(screen).toContain('class="yaml-layout"');
    expect(screen).toContain('class="editor-shell"');
    expect(screen).toContain('class="yaml-editor"');
    expect(screen).toContain('class="validation-panel section-stack"');
    expect(styles).toMatch(/\.pages-publish-ui \.yaml-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px;/s);
  });

  it('keeps safe-logs.html toolbar and three-column log rows', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/safe-logs/safe-logs-screen.tsx')]);
    expect(screen).toContain('class="log-toolbar"');
    expect(screen).toContain('class="log-head"');
    expect(screen).toContain('class="log-list"');
    expect(screen).toContain('class="log-row"');
    expect(styles).toMatch(/\.pages-publish-ui \.log-head, \.pages-publish-ui \.log-row\s*\{[^}]*grid-template-columns:\s*112px 66px minmax\(0, 1fr\);/s);
  });

  it('keeps publication as a four-stage background task', async () => {
    const [styles, screen] = await Promise.all([read('styles.css'), read('src/ui/publish-center/publish-center-screen.tsx')]);
    expect(screen).toContain('class="pp-task-progress"');
    expect(screen).toContain('pp-publication-status is-');
    expect(styles).toMatch(/\.pp-publication-status\s*\{[^}]*background:\s*var\(--pp-surface-muted\);[^}]*border:\s*1px solid var\(--pp-border\);/s);
  });
});
