import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuartzBuildRunner } from '../src/site-builder/quartz-build-runner';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import type { QuartzStagingCompilation } from '../src/site-builder/quartz-staging-compiler';

describe('Quartz build runner', () => {
  it('runs the pinned CLI against controlled staging and collects its complete output', async () => {
    const engineDirectory = await fakeEngine();
    const buildRoot = await mkdtemp(join(tmpdir(), 'pages-quartz-builds-'));
    const runner = new QuartzBuildRunner({ rootDirectory: buildRoot });

    const output = await runner.run(readyEngine(engineDirectory), staging());

    expect(Buffer.from(output.files['index.html']!).toString('utf8')).toContain('Quartz fake');
    expect(Buffer.from(output.files['writing/hello/index.html']!).toString('utf8')).toContain(
      'Public title',
    );
    expect(output.files['static/app.js']).toBeDefined();
    expect(output.sourceDigest).toBe('frozen-source-digest');
  });
});

async function fakeEngine(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pages-fake-quartz-'));
  await mkdir(join(directory, 'quartz'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    '{"name":"@jackyzha0/quartz","version":"5.0.0"}',
  );
  await writeFile(join(directory, 'quartz', 'build.ts'), 'export {}');
  await writeFile(
    join(directory, 'quartz', 'bootstrap-cli.mjs'),
    [
      "import { mkdir, readFile, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "const value = (name) => process.argv[process.argv.indexOf(name) + 1]",
      "const content = value('--directory')",
      "const output = value('--output')",
      "const config = await readFile(join(process.cwd(), 'quartz.config.yaml'), 'utf8')",
      "if (!config.includes('analytics: null') || config.includes('googleFonts')) process.exit(8)",
      "const article = await readFile(join(content, 'Notes', 'Public.md'), 'utf8')",
      "await mkdir(join(output, 'writing', 'hello'), { recursive: true })",
      "await mkdir(join(output, 'static'), { recursive: true })",
      "await writeFile(join(output, 'index.html'), '<html>Quartz fake</html>')",
      "await writeFile(join(output, 'writing', 'hello', 'index.html'), `<html>${article}</html>`)",
      "await writeFile(join(output, 'static', 'app.js'), 'window.quartz=true')",
    ].join('\n'),
  );
  return directory;
}

function readyEngine(engineDirectory: string): ReadyQuartzEngine {
  return {
    engineDirectory,
    engineVersion: 'pages-publish-quartz-5.0.0.1',
    quartzVersion: '5.0.0',
    platform: 'darwin-arm64',
    nodeExecutable: process.execPath,
    nodeVersion: process.versions.node,
    npmCliPath: '/unused/npm-cli.js',
    npmVersion: '11.6.2',
    usingFallback: false,
  };
}

function staging(): Readonly<QuartzStagingCompilation> {
  return Object.freeze({
    config: {
      version: 1 as const,
      site: { name: 'Runner Site', homeLayout: 'latest' as const },
      contentRoots: [{ path: 'Notes', publicRoot: '/writing' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'runner-site', customDomain: 'notes.example.com' },
    },
    contentFiles: { 'Notes/Public.md': '---\ntitle: Public title\n---\nBody' },
    assetFiles: {},
    routePlan: {
      articles: [{ sourcePath: 'Notes/Public.md', url: '/writing/hello/', onlineUrl: undefined, redirects: [] }],
      sections: [],
      systemRoutes: ['/', '/404/', '/privacy/', '/search/', '/graph/'],
      redirects: [],
      issues: [],
    },
    routeManifest: {
      articles: [{
        sourcePath: 'Notes/Public.md',
        url: '/writing/hello/',
        visibility: 'public' as const,
      }],
      redirects: [],
    },
    sourceDigest: 'frozen-source-digest',
  });
}
