import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { saveSiteConfigToDirectory, type SiteConfigV1 } from '../src/config/site-config';
import { QuartzBuildRunner } from '../src/site-builder/quartz-build-runner';
import { QuartzSiteBuilder } from '../src/site-builder/quartz-site-builder';
import { ThemeInstaller } from '../src/theme/theme-installer';
import { InstalledThemeResolver } from '../src/theme/theme-resolver';
import { ThemeRegistryClient } from '../src/theme/theme-registry-client';
import { createQuartzThemeSmoke } from '../src/theme/theme-quartz-smoke';
import { ThemeStore } from '../src/theme/theme-store';
import { ThemeTrustStore } from '../src/theme/theme-trust-store';
import { themeOptionsFromSchemaDefaults } from '../src/theme/theme-options-schema';

const engineDirectory = process.env.PAGES_PUBLISH_QUARTZ_ENGINE;
const nodeExecutable = process.env.PAGES_PUBLISH_NODE22;
const themeArtifact = process.env.PAGES_PUBLISH_BRUTALIST_THEME;

describe('external Brutalist theme real Quartz integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  it.skipIf(!engineDirectory || !nodeExecutable || !themeArtifact)(
    'installs the packed external theme and passes the isolated Quartz smoke',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pages-brutalist-real-'));
      roots.push(root);
      const archive = new Uint8Array(await readFile(themeArtifact!));
      const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
      const engine = readyEngine();
      const store = new ThemeStore({
        rootDirectory: root,
        checkDiskCapacity: async () => undefined,
        checkEnvironmentSize: async () => undefined,
        smoke: createQuartzThemeSmoke(join(root, 'smoke'), async () => engine),
      });

      const installed = await store.install({
        archive,
        integrity,
        source: { kind: 'local', artifact: '.publish/themes/brutalist-real.tgz' },
        supportedQuartzVersion: engine.quartzVersion,
      });

      expect(installed.receipt).toMatchObject({
        packageName: '@pages-publish-theme/brutalist',
        version: '1.0.0',
        integrity,
      });
      expect(installed.receipt.manifest.metadata.capabilities).toEqual([
        'styles',
        'assets',
        'layout',
        'components',
        'clientScripts',
      ]);
      expect(installed.optionsSchema?.additionalProperties).toBe(false);
    },
    60_000,
  );

  it.skipIf(!engineDirectory || !nodeExecutable || !themeArtifact)(
    'builds poster and editorial frames through the unchanged SiteBuilder facade',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pages-brutalist-site-'));
      roots.push(root);
      const vaultRoot = join(root, 'vault');
      const environmentRoot = join(root, 'environment');
      await mkdir(join(vaultRoot, 'Notes'), { recursive: true });
      const engine = readyEngine();
      const store = new ThemeStore({
        rootDirectory: environmentRoot,
        checkDiskCapacity: async () => undefined,
        checkEnvironmentSize: async () => undefined,
        smoke: createQuartzThemeSmoke(join(root, 'smoke'), async () => engine),
      });
      const noRegistryFetch: typeof fetch = async () => {
        throw new Error('Registry access is not expected for the local theme fixture.');
      };
      const installer = new ThemeInstaller(
        store,
        new ThemeRegistryClient(noRegistryFetch),
      );
      const imported = await installer.importLocal(
        vaultRoot,
        themeArtifact!,
        engine.quartzVersion,
      );
      const trust = new ThemeTrustStore(environmentRoot, () => new Date('2026-08-03T00:00:00.000Z'));
      await trust.confirm(imported.installed.receipt);
      const options = imported.installed.optionsSchema === undefined
        ? {}
        : themeOptionsFromSchemaDefaults(imported.installed.optionsSchema);
      const reference = { ...imported.reference, options };
      await writeFixtureNotes(vaultRoot);
      const config: SiteConfigV1 = {
        version: 1,
        site: {
          name: '野外笔记社',
          description: '一个公开维护的知识现场。',
          homeLayout: 'latest',
          theme: reference,
        },
        contentRoots: [{ path: 'Notes', publicRoot: '/notes' }],
        assets: { exclude: [] },
        features: { search: true, graph: true },
        cloudflare: { projectName: 'brutalist-visual-fixture' },
      };
      await saveSiteConfigToDirectory(vaultRoot, config, { expectedRevision: null });
      const builder = new QuartzSiteBuilder({
        environment: { ensureReady: async () => engine },
        runner: new QuartzBuildRunner({
          rootDirectory: join(root, 'builds'),
          deniedReadRoots: [vaultRoot],
          themeResolver: new InstalledThemeResolver(environmentRoot, store, trust),
        }),
      });

      const preview = await builder.build({ vaultRoot, renderMode: 'published' });
      const repeated = await builder.build({ vaultRoot, renderMode: 'published' });

      expect(preview.files['/index.html']).toContain('brutalist-poster-frame');
      expect(preview.files['/notes/field-note/index.html']).toContain('brutalist-editorial-frame');
      expect(preview.files['/notes/hidden-dispatch/index.html']).toContain('noindex');
      expect(Object.values(preview.files).join('\n')).toContain('brutalist-reading-progress');
      expect(Object.values(preview.files).join('\n')).toContain('--brutalist-paper');
      expect(preview.files['/index.html']).toContain(
        'data-pages-publish-brutalist-cascade="true"',
      );
      expect(preview.files['/index.html']).toContain(
        '/static/pages-publish-theme/dist/assets/brutalist-cascade.css',
      );
      expect(preview.assets['/static/pages-publish-theme/dist/assets/brutalist-cascade.css'])
        .toBeDefined();
      expect(new TextDecoder().decode(
        preview.assets['/static/pages-publish-theme/dist/assets/brutalist-cascade.css']!.content,
      )).not.toContain('@layer quartz-base');
      expect(preview.files['/index.html']).toContain('Content-Security-Policy');
      expect(preview.files['/static/contentIndex.json']).not.toContain('Hidden dispatch');
      expect(preview.files['/sitemap.xml']).not.toContain('hidden-dispatch');
      expect(JSON.stringify(preview.files)).not.toContain('private-canary-brutalist-0123456789');
      expect(repeated.files).toEqual(preview.files);
      expect(repeated.assets).toEqual(preview.assets);
      const visualOutput = process.env.PAGES_PUBLISH_VISUAL_OUTPUT;
      if (visualOutput) await writePreview(visualOutput, preview.files, preview.assets);
    },
    60_000,
  );
});

async function writeFixtureNotes(vaultRoot: string): Promise<void> {
  await Promise.all([
    writeFile(join(vaultRoot, 'Notes', 'Field Note.md'), [
      '---',
      'publication:',
      '  visibility: public',
      '  title: 城市边缘的开放系统',
      '  slug: field-note',
      '  tags: [systems, fieldwork]',
      '---',
      '# 城市边缘的开放系统',
      '',
      '这是一篇用于检验长篇中文阅读节奏、混合语言和结构层级的公开笔记。',
      '',
      '## 一、公开现场',
      '',
      '> 结构应该被看见，但不应该压过内容。',
      '',
      '### 观察记录',
      '',
      '| 编号 | 状态 | 说明 |',
      '| --- | --- | --- |',
      '| 01 | OPEN | 可重复验证 |',
      '| 02 | LINKED | 保留上下文 |',
      '',
      '```ts',
      'const publication = "public field notes";',
      '```',
      '',
      '## 二、维护而非装饰',
      '',
      '正文宽度、目录和反向链接必须保持可读，工具面板使用明确的仪表语言。',
    ].join('\n')),
    writeFile(join(vaultRoot, 'Notes', 'Second.md'), [
      '---',
      'publication:',
      '  visibility: public',
      '  title: 第二份公开记录',
      '  slug: second',
      '  tags: [systems]',
      '---',
      '# 第二份公开记录',
      '',
      '链接到 [[Field Note]]。',
    ].join('\n')),
    writeFile(join(vaultRoot, 'Notes', 'Hidden.md'), [
      '---',
      'publication:',
      '  visibility: unlisted',
      '  title: Hidden dispatch',
      '  slug: hidden-dispatch',
      '---',
      '# Hidden dispatch',
    ].join('\n')),
    writeFile(join(vaultRoot, 'Notes', 'Private.md'), [
      '---',
      'publication:',
      '  visibility: private',
      '  title: Private brutalist note',
      '  slug: private-brutalist',
      '---',
      'private-canary-brutalist-0123456789',
    ].join('\n')),
  ]);
}

async function writePreview(
  root: string,
  files: Readonly<Record<string, string>>,
  assets: Readonly<Record<string, { content: Uint8Array }>>,
): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.replace(/^\//u, '').split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  for (const [path, asset] of Object.entries(assets)) {
    const target = join(root, ...path.replace(/^\//u, '').split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, asset.content);
  }
}

function readyEngine(): ReadyQuartzEngine {
  return {
    engineDirectory: engineDirectory!,
    engineVersion: 'pages-publish-quartz-5.0.0.2',
    quartzVersion: '5.0.0',
    platform: 'darwin-arm64',
    nodeExecutable: nodeExecutable!,
    nodeVersion: '22.23.1',
    npmCliPath: '/unused/npm-cli.js',
    npmVersion: '10.9.8',
    usingFallback: false,
  };
}
