import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAGES_PUBLISH_THEME_API_VERSION,
  PAGES_PUBLISH_THEME_CAPABILITIES,
  THEME_LAYOUT_SLOTS as hostLayoutSlots,
  THEME_PAGE_TYPES as hostPageTypes,
} from '../src/theme/theme-contract';
import {
  defineTheme,
  THEME_API_VERSION,
  THEME_CAPABILITIES,
  THEME_LAYOUT_SLOTS,
  THEME_PAGE_TYPES,
} from '../packages/theme-sdk/src/index';

describe('publishable theme SDK package', () => {
  it('stays aligned with the host Theme Contract', () => {
    expect(THEME_API_VERSION).toBe(PAGES_PUBLISH_THEME_API_VERSION);
    expect(THEME_CAPABILITIES).toEqual(PAGES_PUBLISH_THEME_CAPABILITIES);
    expect(THEME_LAYOUT_SLOTS).toEqual(hostLayoutSlots);
    expect(THEME_PAGE_TYPES).toEqual(hostPageTypes);
  });

  it('is an independently packable ESM package without runtime dependencies', async () => {
    const source = await readFile(
      join(process.cwd(), 'packages', 'theme-sdk', 'package.json'),
      'utf8',
    );
    const manifest = JSON.parse(source) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: '@pages-publish/theme-sdk',
      version: '1.0.0',
      type: 'module',
      files: ['dist'],
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('provides typed descriptor inference without acquiring host capabilities', () => {
    const descriptor = defineTheme({
      layout: { frames: { home: 'BrutalistPoster' } },
      styles: ['./dist/theme.css'],
    });

    expect(descriptor.layout.frames.home).toBe('BrutalistPoster');
    expect(() => defineTheme(null as never)).toThrow(/must be an object/);
  });
});
