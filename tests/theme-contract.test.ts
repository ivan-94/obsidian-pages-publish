import { describe, expect, it } from 'vitest';
import {
  defineTheme,
  normalizeThemeOptions,
  ThemeContractError,
  validateThemePackageManifest,
} from '../src/theme/theme-contract';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function validManifest(): Record<string, unknown> {
  return {
    name: '@pages-publish-theme/brutalist',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './dist/index.js' },
    peerDependencies: {
      '@pages-publish/theme-sdk': '1.x',
      preact: '^10.0.0',
    },
    pagesPublishTheme: {
      apiVersion: 1,
      displayName: 'Brutalist UI',
      quartzVersion: '5.0.0',
      entry: './dist/index.js',
      capabilities: [
        'styles',
        'assets',
        'layout',
        'components',
        'clientScripts',
        'localFonts',
      ],
      optionsSchema: './dist/options.schema.json',
    },
  };
}

describe('external theme contract', () => {
  it('accepts the constrained Quartz presentation surface', () => {
    const Header = () => null;
    const descriptor = {
      configuration: {
        typography: { header: 'Arial Black', body: 'Arial', code: 'monospace' },
      },
      layout: {
        header: ['Header'],
        byPageType: { content: { right: ['Graph', 'TableOfContents'] } },
        frames: { home: 'BrutalistPoster', content: 'BrutalistEditorial' },
      },
      components: { Header },
      pageFrames: {
        BrutalistPoster: {
          name: 'brutalist-poster',
          css: '[data-frame="brutalist-poster"] { display: grid; }',
          render: () => null,
        },
      },
      styles: ['./dist/brutalist.css'],
      assets: ['./dist/assets/grid.svg'],
      clientScripts: ['./dist/client.js'],
      localFonts: ['./dist/fonts/display.woff2'],
    } as const;

    expect(defineTheme(descriptor)).toBe(descriptor);
  });

  it('rejects arbitrary Quartz configuration and unsafe resources', () => {
    expect(() => defineTheme({ configuration: { locale: 'en-US' } } as never))
      .toThrow(ThemeContractError);
    expect(() => defineTheme({ styles: ['../../vault.css'] }))
      .toThrow(/relative path without traversal/);
    expect(() => defineTheme({ layout: { left: ['notPascalCase'] } }))
      .toThrow(/PascalCase/);
  });

  it('validates the package manifest, capabilities and exact Quartz version', () => {
    expect(validateThemePackageManifest(validManifest(), '5.0.0')).toEqual({
      name: '@pages-publish-theme/brutalist',
      version: '1.0.0',
      type: 'module',
      entry: './dist/index.js',
      metadata: {
        apiVersion: 1,
        displayName: 'Brutalist UI',
        quartzVersion: '5.0.0',
        entry: './dist/index.js',
        capabilities: [
          'styles',
          'assets',
          'layout',
          'components',
          'clientScripts',
          'localFonts',
        ],
        optionsSchema: './dist/options.schema.json',
      },
    });

    const futureApi = validManifest();
    (futureApi.pagesPublishTheme as Record<string, unknown>).apiVersion = 2;
    expect(() => validateThemePackageManifest(futureApi, '5.0.0'))
      .toThrow(/Only Theme API 1/);

    const unknownCapability = validManifest();
    (unknownCapability.pagesPublishTheme as Record<string, unknown>).capabilities = [
      'styles',
      'network',
    ];
    expect(() => validateThemePackageManifest(unknownCapability, '5.0.0'))
      .toThrow(/Unknown theme capability: network/);

    expect(() => validateThemePackageManifest(validManifest(), '5.1.0'))
      .toThrow(/this engine provides 5\.1\.0/);
  });

  it('rejects dependency graphs, lifecycle scripts and entry mismatch', () => {
    const dependency = validManifest();
    dependency.dependencies = { sharp: '^1.0.0' };
    expect(() => validateThemePackageManifest(dependency, '5.0.0'))
      .toThrow(/dependencies are not allowed/);

    const lifecycle = validManifest();
    lifecycle.scripts = { postinstall: 'node install.js' };
    expect(() => validateThemePackageManifest(lifecycle, '5.0.0'))
      .toThrow(/cannot define postinstall/);

    const mismatch = validManifest();
    (mismatch.pagesPublishTheme as Record<string, unknown>).entry = './dist/other.js';
    expect(() => validateThemePackageManifest(mismatch, '5.0.0'))
      .toThrow(/must match exports/);
  });

  it('normalizes options as stable, JSON-only data', () => {
    expect(normalizeThemeOptions({ z: 1, a: { y: true, b: null } })).toEqual({
      a: { b: null, y: true },
      z: 1,
    });
    expect(() => normalizeThemeOptions({ invalid: Number.NaN }))
      .toThrow(/JSON-compatible/);
    expect(() => normalizeThemeOptions({ invalid: new Date() }))
      .toThrow(/JSON-compatible/);
  });

  it('uses a structurally complete sha512 integrity in fixtures', () => {
    expect(integrity).toMatch(/^sha512-/);
    expect(Buffer.from(integrity.slice(7), 'base64')).toHaveLength(64);
  });
});
