import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workspace = new URL('..', import.meta.url);

describe('global UI responsive and accessibility smoke', () => {
  it('shares the Obsidian-native visual discipline across every plugin surface', async () => {
    const styles = await readFile(new URL('styles.css', workspace), 'utf8');

    expect(styles).toMatch(
      /\.pages-publish-view,\s*\.pages-publish-settings,\s*\.pages-publish-article-panel\s*\{[^}]*--pages-publish-control-height:\s*1\.75rem;[^}]*--pages-publish-content-width:\s*72rem;[^}]*--pages-publish-panel-radius:\s*var\(--radius-s\);[^}]*font-size:\s*var\(--font-ui-small\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view button,\s*\.pages-publish-settings button,\s*\.pages-publish-article-panel button\s*\{[^}]*min-height:\s*var\(--pages-publish-control-height\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__eyebrow,\s*\.pages-publish-view__type\s*\{[^}]*font-size:\s*var\(--font-smallest\);[^}]*font-weight:\s*var\(--font-semibold\);/s,
    );
  });

  it('keeps narrow publish-center rows labelled and global interaction focus-visible', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(styles).toContain('.pages-publish-view :focus-visible');
    expect(styles).toContain('@container (max-width: 640px)');
    expect(styles).toContain('content: attr(data-label)');
    expect(styles).toContain('.pages-publish-view__actions');
    expect(styles).toMatch(/\.pages-publish-view\s*\{[^}]*box-sizing:\s*border-box;/s);
    expect(styles).toMatch(/\.pages-publish-view\s*\{[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(
      /\.view-content\.pages-publish-view\s*\{[^}]*overflow-x:\s*hidden;/s,
    );
    expect(styles).toMatch(/\.pages-publish-view__articles td\s*\{[^}]*box-sizing:\s*border-box;/s);
    expect(styles).toContain('.pages-publish-view button:disabled');
    expect(styles).toMatch(/button:disabled[^}]*\{[^}]*background:\s*var\(--interactive-normal\);/s);
    expect(styles).toContain('@container (min-width: 641px) and (max-width: 899px)');
    expect(styles).toMatch(/\.pages-publish-view h2,[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(
      /\.pages-publish-view__setup-summary,[^}]*\.pages-publish-view__setup-example[^}]*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__workspace\.has-review\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(20rem,\s*26rem\);/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*899px\)[\s\S]*\.pages-publish-view__workspace\.has-review \.pages-publish-view__list\s*\{[^}]*display:\s*none;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*899px\)[\s\S]*\.pages-publish-view__workspace\.has-review \.pages-publish-view__review\s*\{[^}]*position:\s*static;/s,
    );
    expect(view).toContain("'data-label': '下一版包含'");
    expect(view).toContain("'data-label': '文章 / 路径'");
    expect(view).toContain("cls: 'pages-publish-view__setup-example',\n        text: `默认域名：");
  });

  it('composes the publish center as one continuous review workspace', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(view).toContain("cls: 'pages-publish-view__page-header'");
    expect(view).toContain(".setClass('pages-publish-view__metric')");
    expect(view).toContain(".setClass(`pages-publish-view__metric--${metric.tone}`)");
    expect(view).toMatch(/setButtonText\('返回内容列表'\)[\s\S]*?\.setIcon\('x'\)/);
    expect(view).toContain("cls: 'pages-publish-view__callout pages-publish-view__callout--danger'");
    expect(view).toContain('this.renderPublicationStatus(footerStatus, publication)');
    expect(styles).toMatch(
      /\.pages-publish-view__page-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__metric\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__tabs \.is-active\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\);/s,
    );
  });

  it('uses an inspector drawer and explicit safety-state surfaces', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(view).toContain("cls: 'pages-publish-view__review-path'");
    expect(view).toContain("cls: 'pages-publish-view__review-issues'");
    expect(view).toContain("cls: 'pages-publish-view__review-disclosure'");
    expect(view).toContain("this.modalEl?.addClass('pages-publish-modal')");
    expect(styles).toMatch(
      /\.pages-publish-view__review-issues li\s*\{[^}]*background:\s*var\(--background-secondary\);[^}]*border-inline-start:\s*3px solid/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__publication-status\s*\{[^}]*border-radius:\s*var\(--pages-publish-panel-radius\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-modal\s*\{[^}]*max-width:\s*32rem;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-status-bar:not\(\.is-hidden\)\s*\{[^}]*border:\s*1px solid var\(--background-modifier-border\);[^}]*border-radius:\s*var\(--radius-s\);/s,
    );
  });

  it('keeps the current-article panel structured and usable in a narrow sidebar', async () => {
    const styles = await readFile(new URL('styles.css', workspace), 'utf8');

    expect(styles).toMatch(
      /\.view-content\.pages-publish-article-panel\s*\{[^}]*overflow-x:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel__value,\s*\.pages-publish-article-panel__fact\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(4rem,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel__check-item\s*\{[^}]*border-inline-start:\s*3px solid/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel__actions\s*\{[^}]*position:\s*static;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*320px\)[\s\S]*\.pages-publish-article-panel__value,\s*\.pages-publish-article-panel__fact\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel h3\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it('presents the current article as a compact inspector with a stable action dock', async () => {
    const [styles, articleView] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/current-article-view.ts', workspace), 'utf8'),
    ]);

    expect(articleView).toContain("cls: 'pages-publish-article-panel__identity'");
    expect(articleView).toContain("cls: 'pages-publish-article-panel__sync-row'");
    expect(articleView).toContain("container.createEl('h4', { text: '发布设置' })");
    expect(articleView).toContain(".setIcon('wrench')");
    expect(articleView).toContain(".setIcon('external-link')");
    expect(styles).toMatch(
      /\.pages-publish-article-panel__identity\s*\{[^}]*border-bottom:\s*1px solid var\(--background-modifier-border\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel__actions button\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    );
  });

  it('keeps settings sections ordered and the local save action bar sticky', async () => {
    const [styles, settings] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/settings-tab.ts', workspace), 'utf8'),
    ]);

    expect(settings).toMatch(
      /setName\('Cloudflare'\)\.setHeading\(\);[\s\S]*renderCloudflareConnection\(container[\s\S]*setName\('站点功能'\)\.setHeading\(\);/,
    );
    expect(settings).toContain("footer.settingEl.addClass('pages-publish-settings__footer')");
    expect(settings).toContain('text: settingsHeaderStatusText(state.status)');
    expect(settings).toContain("cls: 'pages-publish-settings__remote-status'");
    expect(styles).toMatch(
      /\.pages-publish-settings__footer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-settings\s*\{[^}]*container-type:\s*inline-size;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*640px\)[\s\S]*\.pages-publish-settings__footer \.setting-item-control\s*\{[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*640px\)[\s\S]*\.pages-publish-settings__footer\s*\{[^}]*position:\s*static;/s,
    );
  });

  it('renders settings as a compact native settings document instead of a flat form', async () => {
    const [styles, settings] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/settings-tab.ts', workspace), 'utf8'),
    ]);

    expect(settings).toContain("cls: 'pages-publish-settings__hero'");
    expect(settings).toContain("cls: 'pages-publish-settings__site-identity'");
    expect(settings).toContain("button.buttonEl.createSpan({ text: label })");
    expect(settings).toContain('.setTooltip(label)');
    expect(settings).toContain("button.buttonEl.toggleClass('is-active'");
    expect(styles).toMatch(
      /\.pages-publish-settings__hero\s*\{[^}]*border-bottom:\s*1px solid var\(--pages-publish-rule\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-settings__anchors button\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-settings__anchors button\.is-active\s*\{[^}]*border-bottom:\s*2px solid var\(--interactive-accent\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-settings__body > \.setting-item\s*\{[^}]*padding:\s*var\(--size-4-4\)\s+0;/s,
    );
  });

  it('centers first-run setup around a staged, scan-before-continue workflow', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(view).toContain("container.addClass('pages-publish-view--setup')");
    expect(view).toContain("cls: 'pages-publish-view__setup-scan-summary'");
    expect(styles).toMatch(
      /\.pages-publish-view--setup > \*\s*\{[^}]*margin-inline:\s*auto;[^}]*max-width:\s*60rem;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__setup-progress\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__setup-content-root\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s+auto;/s,
    );
  });

  it('gives config repair and safe logs the same utility-view hierarchy', async () => {
    const [styles, repairView, logView] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/site-config-repair-view.ts', workspace), 'utf8'),
      readFile(new URL('src/plugin/maintenance-log-view.ts', workspace), 'utf8'),
    ]);

    expect(repairView).toContain("cls: 'pages-publish-utility__header'");
    expect(repairView).toContain("cls: 'pages-publish-config-repair__editor-shell'");
    expect(repairView).toContain("cls: 'pages-publish-config-repair__validation'");
    expect(repairView).toContain("再次点击以放弃修复草稿");
    expect(repairView).toContain("cls: 'pages-publish-utility__actions'");
    expect(logView).toContain("cls: 'pages-publish-utility__header'");
    expect(logView).toContain("cls: 'pages-publish-utility__toolbar'");
    expect(logView).toContain("cls: 'pages-publish-utility__footer'");
    expect(logView).toContain("导出诊断包");
    expect(logView).toContain("pages-publish-view__articles pages-publish-utility__table");
    expect(styles).toMatch(
      /\.pages-publish-utility__header\s*\{[^}]*border-bottom:\s*1px solid var\(--background-modifier-border\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-config-repair__editor-shell\s*\{[^}]*background:\s*var\(--background-primary-alt\);[^}]*border:\s*1px solid var\(--background-modifier-border\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-config-repair__validation\[data-state='danger'\]\s*\{[^}]*border-color:\s*var\(--background-modifier-error\);/s,
    );
  });

  it('renders staged publication feedback instead of a single status sentence', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(view).toContain("cls: 'pages-publish-view__publication-track'");
    expect(view).toContain("cls: 'pages-publish-view__publication-message'");
    expect(styles).toMatch(
      /\.pages-publish-view__publication-status\s*\{[^}]*background:\s*var\(--background-secondary\);[^}]*border:\s*1px solid var\(--background-modifier-border\);/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-view__publication-status--succeeded\s*\{[^}]*border-color:\s*var\(--background-modifier-success\);/s,
    );
  });
});
