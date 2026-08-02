import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workspace = new URL('..', import.meta.url);

describe('global UI responsive and accessibility smoke', () => {
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
      /\.pages-publish-view__workspace\.has-review\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(18rem,\s*28rem\);/s,
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
      /\.pages-publish-article-panel__actions\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width:\s*320px\)[\s\S]*\.pages-publish-article-panel__value,\s*\.pages-publish-article-panel__fact\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s,
    );
    expect(styles).toMatch(
      /\.pages-publish-article-panel h3\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
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
});
