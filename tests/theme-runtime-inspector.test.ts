import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateThemePackageManifest } from '../src/theme/theme-contract';
import { inspectThemeRuntime } from '../src/theme/theme-runtime-inspector';

describe('restricted theme runtime inspector', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function fixture(entry: string, capabilities = [
    'styles',
    'layout',
    'components',
    'clientScripts',
  ]): Promise<{
    rootDirectory: string;
    engineDirectory: string;
    packageDirectory: string;
    manifest: ReturnType<typeof validateThemePackageManifest>;
  }> {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-theme-inspector-'));
    roots.push(rootDirectory);
    const engineDirectory = join(rootDirectory, 'engine');
    const packageDirectory = join(rootDirectory, 'package');
    await Promise.all([
      mkdir(join(engineDirectory, 'node_modules'), { recursive: true }),
      mkdir(join(packageDirectory, 'dist'), { recursive: true }),
    ]);
    const rawManifest = {
      name: '@pages-publish-theme/brutalist',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      peerDependencies: { '@pages-publish/theme-sdk': '1.x' },
      pagesPublishTheme: {
        apiVersion: 1,
        displayName: 'Brutalist UI',
        quartzVersion: '5.0.0',
        entry: './dist/index.js',
        capabilities,
      },
    };
    await Promise.all([
      writeFile(join(packageDirectory, 'package.json'), JSON.stringify(rawManifest)),
      writeFile(join(packageDirectory, 'dist', 'index.js'), entry),
      writeFile(join(packageDirectory, 'dist', 'theme.css'), ':root{--accent:red}'),
      writeFile(join(packageDirectory, 'dist', 'client.js'), 'window.themeReady=true'),
    ]);
    return {
      rootDirectory,
      engineDirectory,
      packageDirectory,
      manifest: validateThemePackageManifest(rawManifest, '5.0.0'),
    };
  }

  it('projects executable components and Page Frames without importing them in the plugin process', async () => {
    const input = await fixture(`
      import { defineTheme } from '@pages-publish/theme-sdk';
      export default defineTheme({
        configuration: { typography: { header: 'Arial Black' } },
        layout: {
          left: ['BrutalistNavigation'],
          right: ['Graph', 'TableOfContents'],
          frames: { home: 'BrutalistPoster', content: 'BrutalistEditorial' }
        },
        components: { BrutalistNavigation: () => () => null },
        pageFrames: {
          BrutalistPoster: { name: 'brutalist-poster', css: '[data-frame]{display:grid}', render: () => null },
          BrutalistEditorial: { name: 'brutalist-editorial', render: () => null }
        },
        styles: ['./dist/theme.css'],
        clientScripts: ['./dist/client.js']
      });
    `);

    await expect(inspectThemeRuntime({
      ...input,
      nodeExecutable: process.execPath,
      options: { accent: 'orange' },
    })).resolves.toMatchObject({
      configuration: { typography: { header: 'Arial Black' } },
      componentNames: ['BrutalistNavigation'],
      pageFrames: {
        BrutalistPoster: { name: 'brutalist-poster' },
        BrutalistEditorial: { name: 'brutalist-editorial' },
      },
      styles: ['./dist/theme.css'],
      clientScripts: ['./dist/client.js'],
    });
  });

  it('rejects undeclared capabilities and unknown layout references', async () => {
    const undeclared = await fixture(
      'export default { clientScripts: ["./dist/client.js"] };',
      ['styles'],
    );
    await expect(inspectThemeRuntime({
      ...undeclared,
      nodeExecutable: process.execPath,
    })).rejects.toThrow(/violates the host Theme Contract/);

    const unknown = await fixture(`
      export default {
        layout: { left: ['ReadsOriginalVault'] },
        components: {}
      };
    `, ['layout', 'components']);
    await expect(inspectThemeRuntime({
      ...unknown,
      nodeExecutable: process.execPath,
    })).rejects.toThrow(/violates the host Theme Contract/);
  });

  it('denies filesystem reads outside the engine and ephemeral workspace', async () => {
    const secret = join(tmpdir(), `theme-secret-${Date.now()}.txt`);
    await writeFile(secret, 'secret');
    const input = await fixture(`
      import { readFileSync } from 'node:fs';
      readFileSync(${JSON.stringify(secret)}, 'utf8');
      export default {};
    `, []);
    try {
      await expect(inspectThemeRuntime({
        ...input,
        nodeExecutable: process.execPath,
      })).rejects.toMatchObject({ code: 'theme-runtime-inspection-failed' });
    } finally {
      await rm(secret, { force: true });
    }
  });
});
