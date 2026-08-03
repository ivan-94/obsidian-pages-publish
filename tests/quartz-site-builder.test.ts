import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { QuartzSiteBuilder } from '../src/site-builder/quartz-site-builder';
import type { QuartzRawBuildOutput } from '../src/site-builder/quartz-build-runner';

describe('Quartz site builder', () => {
  it('returns the unchanged upper SiteBuilder contract from audited Quartz output', async () => {
    const vaultRoot = await fixtureVault();
    const engine = readyEngine();
    const builder = new QuartzSiteBuilder({
      environment: { ensureReady: async () => engine },
      runner: {
        run: async (_engine, staging): Promise<QuartzRawBuildOutput> => ({
          files: rawFiles(),
          sourceDigest: staging.sourceDigest,
          engineVersion: engine.engineVersion,
        }),
      },
    });

    const preview = await builder.build({ vaultRoot, renderMode: 'published' });

    expect(preview.siteName).toBe('Quartz Builder');
    expect(preview.pages).toEqual([
      { sourcePath: 'Notes/Hello.md', title: 'Hello', url: '/writing/hello/' },
    ]);
    expect(preview.articles).toEqual([
      expect.objectContaining({ sourcePath: 'Notes/Hello.md', visibility: 'public' }),
      expect.objectContaining({ sourcePath: 'Notes/Private.md', visibility: 'private' }),
    ]);
    expect(preview.files['/writing/hello/index.html']).toContain('Quartz article');
    expect(preview.assets['/static/icon.png']).toBeDefined();
  });
});

async function fixtureVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pages-quartz-builder-'));
  await mkdir(join(root, '.publish'), { recursive: true });
  await mkdir(join(root, 'Notes'), { recursive: true });
  await writeFile(
    join(root, '.publish', 'site.yml'),
    [
      'version: 1',
      'site:',
      '  name: Quartz Builder',
      '  home_layout: latest',
      'content_roots:',
      '  - path: Notes',
      '    public_root: /writing',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: false',
      '  graph: false',
      'cloudflare:',
      '  project_name: quartz-builder',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'Notes', 'Hello.md'),
    '---\npublication:\n  visibility: public\n  title: Hello\n  slug: hello\n---\nHello',
  );
  await writeFile(
    join(root, 'Notes', 'Private.md'),
    '---\npublication:\n  visibility: private\n  title: Private\n  slug: private\n---\nSecret',
  );
  return root;
}

function rawFiles(): Record<string, Uint8Array> {
  const values: Record<string, string> = {
    'index.html': '<html>Quartz home</html>',
    '404.html': '<html>404</html>',
    'privacy.html': '<html>Privacy</html>',
    'writing.html': '<html>Writing</html>',
    'writing/hello.html': '<html>Quartz article</html>',
    'sitemap.xml': '<loc>/writing/hello</loc>',
    'index.xml': '<item>/writing/hello</item>',
    'static/contentIndex.json': '{"writing/hello":{"title":"Hello"}}',
  };
  return {
    ...Object.fromEntries(
      Object.entries(values).map(([path, value]) => [path, new TextEncoder().encode(value)]),
    ),
    'static/icon.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
}

function readyEngine(): ReadyQuartzEngine {
  return {
    engineDirectory: '/engine',
    engineVersion: 'pages-publish-quartz-5.0.0.1',
    quartzVersion: '5.0.0',
    platform: 'darwin-arm64',
    nodeExecutable: '/runtime/node',
    nodeVersion: '22.23.1',
    npmCliPath: '/runtime/npm-cli.js',
    npmVersion: '10.9.8',
    usingFallback: false,
  };
}
