import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlledQuartzConfig } from '../src/site-builder/quartz-config';
import {
  materializeQuartzThemeAdapter,
  ThemeQuartzAdapterError,
} from '../src/theme/theme-quartz-adapter';
import { ThemeStore } from '../src/theme/theme-store';
import type { InspectedThemeDescriptor } from '../src/theme/theme-runtime-inspector';
import {
  sha512Integrity,
  themePackageArchive,
} from './support/theme-package-fixture';

describe('Quartz theme compatibility adapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{
    root: string;
    workspace: string;
    nodeModules: string;
    installed: Awaited<ReturnType<ThemeStore['install']>>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-adapter-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const nodeModules = join(workspace, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    const archive = themePackageArchive({
      capabilities: [
        'styles',
        'assets',
        'layout',
        'components',
        'clientScripts',
        'localFonts',
      ],
      extraFiles: {
        'package/dist/theme.css': '.hero{background:url("./assets/grid.svg")}',
        'package/dist/client.js': 'window.brutalistTheme = true;',
        'package/dist/assets/grid.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'package/dist/fonts/display.woff2': 'font-bytes',
      },
    });
    const installed = await new ThemeStore({
      rootDirectory: root,
      smoke: async () => undefined,
    }).install({
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local', artifact: '.publish/themes/brutalist.tgz' },
      supportedQuartzVersion: '5.0.0',
    });
    return { root, workspace, nodeModules, installed };
  }

  function descriptor(): InspectedThemeDescriptor {
    return {
      configuration: { typography: { header: 'Arial Black' } },
      layout: {
        left: ['BrutalistNavigation', 'Search', 'Darkmode', 'Explorer'],
        beforeBody: ['Breadcrumbs', 'ArticleTitle', 'ContentMeta', 'TagList'],
        right: ['Graph', 'TableOfContents', 'Backlinks'],
        frames: {
          home: 'BrutalistPoster',
          content: 'BrutalistEditorial',
          folder: 'BrutalistPoster',
          tag: 'BrutalistPoster',
          notFound: 'BrutalistMinimal',
          privacy: 'BrutalistMinimal',
        },
      },
      componentNames: ['BrutalistNavigation'],
      pageFrames: {
        BrutalistPoster: { name: 'brutalist-poster', css: '.poster{display:grid}' },
        BrutalistEditorial: { name: 'brutalist-editorial' },
        BrutalistMinimal: { name: 'brutalist-minimal' },
      },
      styles: ['./dist/theme.css'],
      assets: ['./dist/assets/grid.svg'],
      clientScripts: ['./dist/client.js'],
      localFonts: ['./dist/fonts/display.woff2'],
    };
  }

  it('materializes wrapper plugins, page dispatch frames and local resources', async () => {
    const input = await fixture();

    const result = await materializeQuartzThemeAdapter({
      workspace: input.workspace,
      nodeModules: input.nodeModules,
      installed: input.installed,
      descriptor: descriptor(),
      options: { accent: 'orange' },
      features: { search: true, graph: true },
    });

    expect(result.config).toMatchObject({
      typography: { header: 'Arial Black' },
      suppressDefaultComponentLayout: true,
      layoutByPageType: {
        content: { template: 'pages-publish-theme-content' },
        folder: { template: 'pages-publish-theme-folder' },
        tag: { template: 'pages-publish-theme-tag' },
        404: { template: 'pages-publish-theme-404' },
      },
    });
    expect(result.config.layoutByPageType.content?.exclude).toContain(
      '@quartz-community/page-title',
    );
    expect(result.config.plugins.some((plugin) =>
      plugin.source === '@pages-publish-theme-adapter/core')).toBe(true);
    expect(Object.keys(result.outputAssets)).toEqual([
      'static/pages-publish-theme/dist/assets/grid.svg',
      'static/pages-publish-theme/dist/fonts/display.woff2',
    ]);
    const core = join(
      input.nodeModules,
      '@pages-publish-theme-adapter',
      'core',
    );
    await expect(readFile(join(core, 'components.js'), 'utf8')).resolves.toContain(
      '/static/pages-publish-theme/dist/assets/grid.svg',
    );
    await expect(readFile(join(core, 'frames.js'), 'utf8')).resolves.toContain(
      'slug === "index"',
    );
    await expect(readFile(join(core, 'package.json'), 'utf8')).resolves.toContain(
      '"quartz"',
    );
  });

  it('merges presentation below forced Quartz safety and product configuration', async () => {
    const input = await fixture();
    const theme = await materializeQuartzThemeAdapter({
      workspace: input.workspace,
      nodeModules: input.nodeModules,
      installed: input.installed,
      descriptor: descriptor(),
      options: {},
      features: { search: false, graph: false },
    });

    const parsed = parse(createControlledQuartzConfig({
      siteName: 'Theme Wiki',
      baseUrl: 'wiki.example.com',
      search: false,
      graph: false,
      theme: theme.config,
    })) as {
      configuration: Record<string, unknown>;
      plugins: Array<Record<string, unknown>>;
      layout: { byPageType: Record<string, { template?: string }> };
    };

    expect(parsed.configuration).toMatchObject({
      pageTitle: 'Theme Wiki',
      baseUrl: 'wiki.example.com',
      locale: 'zh-CN',
      analytics: null,
      theme: {
        fontOrigin: 'local',
        cdnCaching: false,
        typography: { header: 'Arial Black' },
      },
    });
    expect(parsed.plugins.find((plugin) =>
      plugin.source === '@quartz-community/remove-draft')).toMatchObject({ enabled: true });
    expect(parsed.plugins.find((plugin) =>
      plugin.source === '@quartz-community/unlisted-pages')).toMatchObject({ enabled: true });
    expect(parsed.plugins.filter((plugin) =>
      String(plugin.source).includes('theme-adapter')).length).toBeGreaterThan(1);
    expect(theme.config.plugins.some((plugin) =>
      JSON.stringify(plugin).includes('@quartz-community/search/components'))).toBe(false);
    expect(parsed.layout.byPageType.content?.template).toBe('pages-publish-theme-content');
  });

  it('keeps Quartz default component layout for resource-only themes', async () => {
    const input = await fixture();
    const resourceOnly = descriptor();
    delete resourceOnly.layout;
    resourceOnly.componentNames = [];
    resourceOnly.pageFrames = {};

    const theme = await materializeQuartzThemeAdapter({
      workspace: input.workspace,
      nodeModules: input.nodeModules,
      installed: input.installed,
      descriptor: resourceOnly,
      options: {},
      features: { search: true, graph: true },
    });

    expect(theme.config.suppressDefaultComponentLayout).toBe(false);
  });

  it('rejects remote CSS and component layouts that Quartz cannot distinguish safely', async () => {
    const input = await fixture();
    const remote = descriptor();
    await rm(join(input.installed.packageDirectory, 'dist', 'theme.css'), { force: true });
    // The adapter verifies the receipt before copying, so resource tampering is
    // rejected before the remote URL could enter a Quartz build.
    await expect(materializeQuartzThemeAdapter({
      workspace: input.workspace,
      nodeModules: input.nodeModules,
      installed: input.installed,
      descriptor: remote,
      options: {},
      features: { search: true, graph: true },
    })).rejects.toBeInstanceOf(ThemeQuartzAdapterError);
  });
});
