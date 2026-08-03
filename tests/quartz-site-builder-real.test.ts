import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { QuartzBuildRunner } from '../src/site-builder/quartz-build-runner';
import { QuartzSiteBuilder } from '../src/site-builder/quartz-site-builder';

const engineDirectory = process.env.PAGES_PUBLISH_QUARTZ_ENGINE;
const nodeExecutable = process.env.PAGES_PUBLISH_NODE22;

describe('real Quartz SiteBuilder integration', () => {
  it.skipIf(!engineDirectory || !nodeExecutable)(
    'preserves routes while excluding private content and unlisting direct-only content',
    async () => {
      const vaultRoot = await fixtureVault();
      const buildRoot = await mkdtemp(join(tmpdir(), 'pages-real-site-builder-'));
      const engine = readyEngine();
      const builder = new QuartzSiteBuilder({
        environment: { ensureReady: async () => engine },
        runner: new QuartzBuildRunner({ rootDirectory: buildRoot, deniedReadRoots: [vaultRoot] }),
      });

      const preview = await builder.build({ vaultRoot, renderMode: 'published' });
      const repeated = await builder.build({ vaultRoot, renderMode: 'published' });

      expect(preview.files['/writing/hello/index.html']).toContain('Hello Quartz');
      expect(preview.files['/writing/hidden/index.html']).toContain('Hidden Quartz');
      expect(preview.files['/writing/hidden/index.html']).toMatch(
        /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/iu,
      );
      expect(preview.files['/writing/hello/index.html']).toContain(
        '<link rel="canonical" href="https://example.com/writing/hello/"/>',
      );
      expect(preview.files['/writing/中文 空格/index.html']).toContain(
        '<link rel="canonical" href="https://example.com/writing/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/"/>',
      );
      expect(preview.files['/index.html']).not.toContain('og-image.png');
      expect(preview.files['/404.html']).toBe(preview.files['/404/index.html']);
      expect(preview.files['/writing/hello/index.html']).toMatch(
        /<link\b[^>]*href="\/index-[a-f0-9]+\.css"/iu,
      );
      expect(preview.files['/writing/hello/index.html']).toContain(
        'fetch("/static/contentIndex.json")',
      );
      expect(preview.files['/writing/中文 空格/index.html']).toContain('Unicode Quartz');
      expect(preview.files['/writing/CaseSensitive/index.html']).toContain('Case Quartz');
      expect(preview.files['/writing/casesensitive/index.html']).toContain('Lower Case Quartz');
      expect(preview.files['/writing/guides/index.html']).toContain('Guides index');
      expect(preview.files['/writing/hidden-section/index.html']).toContain(
        'Unlisted Section',
      );
      expect(preview.files['/writing/hidden-section/child/index.html']).toContain(
        'Public section child',
      );
      expect(preview.files['/writing/hidden-section/child/index.html']).toContain(
        'href="/writing/">Notes</a>',
      );
      expect(preview.files['/writing/old-case/index.html']).toContain('/writing/CaseSensitive/');
      expect(preview.files['/_redirects']).toContain(
        '/writing/old-case/ /writing/CaseSensitive/ 301',
      );
      const contentIndex = JSON.parse(
        preview.files['/static/contentIndex.json'] ?? '{}',
      ) as Record<string, unknown>;
      expect(contentIndex).not.toHaveProperty('writing/hidden');
      expect(contentIndex).not.toHaveProperty('writing/hidden-section/index');
      expect(contentIndex).toHaveProperty('writing/hidden-section/child');
      expect(JSON.stringify(preview.files)).not.toContain('private-vault-token');
      const sectionArticle = /<article\b[^>]*>[\s\S]*?<\/article>/u.exec(
        preview.files['/writing/index.html'] ?? '',
      )?.[0] ?? '';
      expect(sectionArticle.indexOf('Case Quartz')).toBeLessThan(
        sectionArticle.indexOf('Hello Quartz'),
      );
      expect(sectionArticle).not.toContain('Hidden Quartz');
      expect(sectionArticle).not.toContain('Guides index');
      const homeArticle = /<article\b[^>]*>[\s\S]*?<\/article>/u.exec(
        preview.files['/index.html'] ?? '',
      )?.[0] ?? '';
      expect(homeArticle.indexOf('Case Quartz')).toBeLessThan(
        homeArticle.indexOf('Lower Case Quartz'),
      );
      expect(homeArticle.indexOf('Lower Case Quartz')).toBeLessThan(
        homeArticle.indexOf('Hello Quartz'),
      );
      expect(homeArticle).not.toContain('Unlisted Section');
      expect(Object.keys(preview.files)).toEqual(Object.keys(repeated.files));
      expect(preview.files).toEqual(repeated.files);
      expect(preview.assets).toEqual(repeated.assets);
      const privateArticle = preview.articles.find(
        (article) => article.sourcePath.endsWith('Private.md'),
      );
      expect(privateArticle).toMatchObject({ visibility: 'private' });
      expect(privateArticle?.url).toBeUndefined();
    },
    60_000,
  );

  it.skipIf(!engineDirectory || !nodeExecutable)(
    'builds a sections home without leaking an unlisted section index',
    async () => {
      const vaultRoot = await fixtureVault('sections');
      const buildRoot = await mkdtemp(join(tmpdir(), 'pages-real-sections-builder-'));
      const builder = new QuartzSiteBuilder({
        environment: { ensureReady: async () => readyEngine() },
        runner: new QuartzBuildRunner({ rootDirectory: buildRoot, deniedReadRoots: [vaultRoot] }),
      });

      const preview = await builder.build({ vaultRoot, renderMode: 'published' });
      const homeArticle = /<article\b[^>]*>[\s\S]*?<\/article>/u.exec(
        preview.files['/index.html'] ?? '',
      )?.[0] ?? '';

      expect(homeArticle).toContain('/writing/guides/');
      expect(homeArticle).not.toContain('/writing/hidden-section/');
      expect(preview.files['/writing/hidden-section/index.html']).toContain(
        'Unlisted Section',
      );
      expect(preview.files['/writing/hidden-section/child/index.html']).toContain(
        'Public section child',
      );
    },
    60_000,
  );
});

async function fixtureVault(homeLayout: 'latest' | 'sections' = 'latest'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pages-real-quartz-vault-'));
  await mkdir(join(root, '.publish'), { recursive: true });
  await mkdir(join(root, 'Notes'), { recursive: true });
  await mkdir(join(root, 'Notes', 'guides'), { recursive: true });
  await mkdir(join(root, 'Notes', 'hidden-section'), { recursive: true });
  await writeFile(
    join(root, '.publish', 'site.yml'),
    [
      'version: 1',
      'site:',
      '  name: Real Quartz Site',
      `  home_layout: ${homeLayout}`,
      'content_roots:',
      '  - path: Notes',
      '    public_root: /writing',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: real-quartz-site',
      '  custom_domain: example.com',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'Notes', 'Hello.md'),
    [
      '---',
      'publication:',
      '  visibility: public',
      '  title: Hello Quartz',
      '  slug: hello',
      '  order: 20',
      '  date: 2024-01-01',
      '---',
      '# Hello Quartz',
      '',
      'A direct-only link: [[Hidden]]. A private target: [[Private]].',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'Notes', 'Hidden.md'),
    '---\npublication:\n  visibility: unlisted\n  title: Hidden Quartz\n  slug: hidden\n---\n# Hidden Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'Private.md'),
    '---\npublication:\n  visibility: private\n  title: Private Quartz\n  slug: private\n---\nprivate-vault-token',
  );
  await writeFile(
    join(root, 'Notes', 'Unicode.md'),
    '---\npublication:\n  visibility: public\n  title: Unicode Quartz\n  slug: 中文 空格\n---\n# Unicode Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'Case.md'),
    '---\npublication:\n  visibility: public\n  title: Case Quartz\n  slug: CaseSensitive\n  order: 10\n  date: 2026-01-01\n  redirects: [/writing/old-case/]\n---\n# Case Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'CaseLower.md'),
    '---\npublication:\n  visibility: public\n  title: Lower Case Quartz\n  slug: casesensitive\n  date: 2025-01-01\n---\n# Lower Case Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'guides', '_index.md'),
    '---\npublication:\n  visibility: public\n  title: Guides index\n---\n# Guides index',
  );
  await writeFile(
    join(root, 'Notes', 'hidden-section', '_index.md'),
    '---\npublication:\n  visibility: unlisted\n  title: Unlisted Section\n---\n# Unlisted Section',
  );
  await writeFile(
    join(root, 'Notes', 'hidden-section', 'child.md'),
    '---\npublication:\n  visibility: public\n  title: Public section child\n---\n# Public section child',
  );
  return root;
}

function readyEngine(): ReadyQuartzEngine {
  return {
    engineDirectory: engineDirectory!,
    engineVersion: 'pages-publish-quartz-5.0.0.1',
    quartzVersion: '5.0.0',
    platform: 'darwin-arm64',
    nodeExecutable: nodeExecutable!,
    nodeVersion: '22.23.1',
    npmCliPath: '/unused/npm-cli.js',
    npmVersion: '10.9.8',
    usingFallback: false,
  };
}
