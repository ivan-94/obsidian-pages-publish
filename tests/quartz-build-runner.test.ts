import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
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
    expect(Buffer.from(output.files['static/vendor/test.js']!).toString('utf8')).toBe(
      'window.vendor=true',
    );
    expect(output.sourceDigest).toBe('frozen-source-digest');
  });

  it('keeps an unlisted section index out of a sections home page', async () => {
    const engineDirectory = await fakeEngine([
      "const home = await readFile(join(content, 'index.md'), 'utf8')",
      "if (home.includes('/writing/hidden-section/')) throw new Error('unlisted section leaked onto home')",
    ]);
    const buildRoot = await mkdtemp(join(tmpdir(), 'pages-quartz-builds-'));
    const runner = new QuartzBuildRunner({ rootDirectory: buildRoot });
    const base = staging();
    const input: Readonly<QuartzStagingCompilation> = {
      ...base,
      config: {
        ...base.config,
        site: { ...base.config.site, homeLayout: 'sections' },
      },
      routePlan: {
        ...base.routePlan,
        articles: [
          ...base.routePlan.articles,
          {
            sourcePath: 'Notes/Hidden/_index.md',
            url: '/writing/hidden-section/',
            onlineUrl: undefined,
            redirects: [],
          },
          {
            sourcePath: 'Notes/Hidden/Child.md',
            url: '/writing/hidden-section/child/',
            onlineUrl: undefined,
            redirects: [],
          },
        ],
        sections: [{
          directoryPath: 'Notes/Hidden',
          url: '/writing/hidden-section/',
          sourcePath: 'Notes/Hidden/_index.md',
          generated: false,
        }],
      },
      routeManifest: {
        ...base.routeManifest,
        articles: [
          ...base.routeManifest.articles,
          {
            sourcePath: 'Notes/Hidden/_index.md',
            title: 'Hidden section',
            url: '/writing/hidden-section/',
            visibility: 'unlisted',
            kind: 'index',
          },
          {
            sourcePath: 'Notes/Hidden/Child.md',
            title: 'Public child',
            url: '/writing/hidden-section/child/',
            visibility: 'public',
            kind: 'article',
          },
        ],
      },
    };

    await expect(runner.run(readyEngine(engineDirectory), input)).resolves.toBeDefined();
  });

  it.skipIf(process.platform !== 'darwin')(
    'denies Vault reads to native child processes as well as the Quartz Node process',
    async () => {
      const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-denied-vault-'));
      const secretPath = join(vaultRoot, 'private-canary.txt');
      await writeFile(secretPath, 'must-not-be-readable');
      const engineDirectory = await fakeEngine([
        "import { execFileSync } from 'node:child_process'",
        `execFileSync('/bin/cat', [${JSON.stringify(secretPath)}], { stdio: 'ignore' })`,
      ]);
      const buildRoot = await mkdtemp(join(tmpdir(), 'pages-quartz-builds-'));
      const runner = new QuartzBuildRunner({
        rootDirectory: buildRoot,
        deniedReadRoots: [vaultRoot],
      });

      await expect(runner.run(readyEngine(engineDirectory), staging())).rejects.toMatchObject({
        code: 'quartz-build-failed',
      });
    },
  );

  it('terminates the child and removes its workspace when cancelled', async () => {
    const engineDirectory = await fakeEngine([
      'await new Promise((resolve) => setTimeout(resolve, 30_000))',
    ]);
    const buildRoot = await mkdtemp(join(tmpdir(), 'pages-quartz-builds-'));
    const runner = new QuartzBuildRunner({ rootDirectory: buildRoot });
    const controller = new AbortController();
    const build = runner.run(readyEngine(engineDirectory), staging(), controller.signal);

    queueMicrotask(() => controller.abort());

    await expect(build).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readdir(join(buildRoot, 'builds'))).resolves.toEqual([]);
  });
});

async function fakeEngine(extraSource: readonly string[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pages-fake-quartz-'));
  await mkdir(join(directory, 'quartz'), { recursive: true });
  await mkdir(join(directory, '.pages-publish-runtime-assets', 'static', 'vendor'), {
    recursive: true,
  });
  await writeFile(
    join(directory, '.pages-publish-runtime-assets', 'static', 'vendor', 'test.js'),
    'window.vendor=true',
  );
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
      ...extraSource,
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
        title: 'Public title',
        url: '/writing/hello/',
        visibility: 'public' as const,
        kind: 'article' as const,
      }],
      redirects: [],
    },
    sourceDigest: 'frozen-source-digest',
  });
}
