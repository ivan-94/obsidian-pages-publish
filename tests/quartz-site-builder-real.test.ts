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
        runner: new QuartzBuildRunner({ rootDirectory: buildRoot }),
      });

      const preview = await builder.build({ vaultRoot, renderMode: 'published' });

      expect(preview.files['/writing/hello/index.html']).toContain('Hello Quartz');
      expect(preview.files['/writing/hidden/index.html']).toContain('Hidden Quartz');
      expect(preview.files['/static/contentIndex.json']).not.toContain('writing/hidden');
      expect(JSON.stringify(preview.files)).not.toContain('private-vault-token');
      const privateArticle = preview.articles.find(
        (article) => article.sourcePath.endsWith('Private.md'),
      );
      expect(privateArticle).toMatchObject({ visibility: 'private' });
      expect(privateArticle?.url).toBeUndefined();
    },
    60_000,
  );
});

async function fixtureVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pages-real-quartz-vault-'));
  await mkdir(join(root, '.publish'), { recursive: true });
  await mkdir(join(root, 'Notes'), { recursive: true });
  await writeFile(
    join(root, '.publish', 'site.yml'),
    [
      'version: 1',
      'site:',
      '  name: Real Quartz Site',
      '  home_layout: latest',
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
    '---\npublication:\n  visibility: public\n  title: Hello Quartz\n  slug: hello\n---\n# Hello Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'Hidden.md'),
    '---\npublication:\n  visibility: unlisted\n  title: Hidden Quartz\n  slug: hidden\n---\n# Hidden Quartz',
  );
  await writeFile(
    join(root, 'Notes', 'Private.md'),
    '---\npublication:\n  visibility: private\n  title: Private Quartz\n  slug: private\n---\nprivate-vault-token',
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
