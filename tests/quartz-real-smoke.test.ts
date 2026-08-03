import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { QuartzBuildRunner } from '../src/site-builder/quartz-build-runner';
import { bridgeAndAuditQuartzOutput } from '../src/site-builder/quartz-output-auditor';
import type { QuartzStagingCompilation } from '../src/site-builder/quartz-staging-compiler';

const engineDirectory = process.env.PAGES_PUBLISH_QUARTZ_ENGINE;
const nodeExecutable = process.env.PAGES_PUBLISH_NODE22;

describe('real pinned Quartz smoke', () => {
  it.skipIf(!engineDirectory || !nodeExecutable)(
    'builds a minimal offline site with the pinned engine',
    async () => {
      const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-real-quartz-build-'));
      const runner = new QuartzBuildRunner({ rootDirectory });
      const engine: ReadyQuartzEngine = {
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

      const staging = minimalStaging();
      const raw = await runner.run(engine, staging);
      const output = bridgeAndAuditQuartzOutput(raw, staging);

      expect(Object.keys(output.files)).toContain('/index.html');
      expect(Object.keys(output.files)).toContain('/writing/hello/index.html');
      expect(Object.keys(output.files)).toContain('/writing/hidden/index.html');
      expect(output.files['/index.html']).toContain('Quartz');
      expect(output.files['/static/contentIndex.json']).not.toContain('writing/hidden');
    },
    60_000,
  );
});

function minimalStaging(): Readonly<QuartzStagingCompilation> {
  return {
    config: {
      version: 1,
      site: { name: 'Quartz Smoke', homeLayout: 'latest' },
      contentRoots: [{ path: 'Notes', publicRoot: '/writing' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'quartz-smoke', customDomain: 'example.com' },
    },
    contentFiles: {
      'writing/hello.md': [
        '---',
        'title: Hello Quartz',
        'permalink: /writing/hello/',
        'tags: [smoke]',
        '---',
        '# Hello Quartz',
        '',
        'A [[Hello|self link]] and a callout.',
        '',
        '> [!note] Quartz',
        '> Works offline.',
      ].join('\n'),
      'writing/hidden.md': [
        '---',
        'title: Hidden Quartz',
        'unlisted: true',
        '---',
        '# Hidden Quartz',
        '',
        'Direct URL only.',
      ].join('\n'),
    },
    assetFiles: {},
    routePlan: {
      articles: [{
        sourcePath: 'Notes/Hello.md',
        url: '/writing/hello/',
        onlineUrl: undefined,
        redirects: [],
      }, {
        sourcePath: 'Notes/Hidden.md',
        url: '/writing/hidden/',
        onlineUrl: undefined,
        redirects: [],
      }],
      sections: [],
      systemRoutes: ['/', '/404/', '/privacy/', '/search/', '/graph/'],
      redirects: [],
      issues: [],
    },
    routeManifest: {
      articles: [
        { sourcePath: 'Notes/Hello.md', url: '/writing/hello/', visibility: 'public' },
        { sourcePath: 'Notes/Hidden.md', url: '/writing/hidden/', visibility: 'unlisted' },
      ],
      redirects: [],
    },
    sourceDigest: 'real-smoke',
  };
}
