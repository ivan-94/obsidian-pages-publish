import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createControlledQuartzConfig } from '../src/site-builder/quartz-config';

describe('controlled Quartz configuration', () => {
  it('disables analytics, remote fonts, embeds, and runtime plugin installation', () => {
    const source = createControlledQuartzConfig({
      siteName: 'Controlled Site',
      baseUrl: 'notes.example.com',
      search: true,
      graph: true,
    });
    const config = parse(source) as {
      configuration: Record<string, unknown> & { theme: Record<string, unknown> };
      plugins: Array<{ source: string; enabled: boolean; options?: Record<string, unknown> }>;
    };

    expect(config.configuration.analytics).toBeNull();
    expect(config.configuration.theme).toMatchObject({ fontOrigin: 'local', cdnCaching: false });
    expect(config.plugins.every((plugin) => plugin.source.startsWith('@quartz-'))).toBe(true);
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/obsidian-flavored-markdown')))
      .toMatchObject({ options: { enableInHtmlEmbed: false } });
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/created-modified-date')))
      .toBeUndefined();
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/search'))?.enabled).toBe(true);
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/graph'))?.enabled).toBe(true);
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/folder-page'))?.enabled)
      .toBe(true);
    expect(config.plugins.find((plugin) => plugin.source.endsWith('/content-index')))
      .toMatchObject({ options: { enableSiteMap: true, enableRSS: false } });
    expect(source).not.toContain('googleFonts');
    expect(source).not.toContain('github:');
    expect(source).not.toContain('comments');
    expect(source).not.toContain('@quartz-community/latex');
  });
});
