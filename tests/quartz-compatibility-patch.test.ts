import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyInstalledQuartzCompatibilityPatch,
  applyQuartzEngineCompatibilityPatch,
  quartzCompatibilityPatchesMatch,
} from '../src/runtime/quartz-compatibility-patch';

describe('Quartz engine compatibility patch', () => {
  it('confines both Sass resolvers to the controlled workspace node_modules', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-patch-'));
    await mkdir(join(directory, 'quartz', 'cli'), { recursive: true });
    await writeFile(
      join(directory, 'quartz', 'cli', 'handlers.js'),
      [
        'import serveHandler from "serve-handler"',
        'sassPlugin({',
        '  type: "css-text",',
        '  cssImports: true,',
        '}),',
        'const mod = await import(`../../${cacheFile}?update=${randomUUID()}`)',
        'sassPlugin({',
        '  filter: /x/,',
        '  type: "css",',
        '  cssImports: true,',
        '}),',
        '        await serveHandler(req, res, {',
      ].join('\n'),
    );
    await writeGlobFixture(directory);

    await applyQuartzEngineCompatibilityPatch(directory);

    const patched = await readFile(join(directory, 'quartz', 'cli', 'handlers.js'), 'utf8');
    expect(patched.match(/loadPaths:/gu)).toHaveLength(2);
    expect(patched).toContain('path.join(process.cwd(), "node_modules")');
    expect(patched).toContain('import(`${path.resolve(cacheFile)}?update=${randomUUID()}`)');
    expect(patched).not.toContain('import serveHandler from "serve-handler"');
    expect(patched).toContain('await import("serve-handler")');
    await expect(readFile(join(directory, 'quartz', 'util', 'glob.ts'), 'utf8'))
      .resolves.toContain('pages-publish-controlled-content-root');
  });

  it('fails closed when the pinned upstream source shape changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-patch-reject-'));
    await mkdir(join(directory, 'quartz', 'cli'), { recursive: true });
    await writeFile(join(directory, 'quartz', 'cli', 'handlers.js'), 'changed upstream');
    await writeGlobFixture(directory);

    await expect(applyQuartzEngineCompatibilityPatch(directory)).rejects.toThrow(
      'compatibility patch',
    );
  });

  it('removes the duplicate FolderPage listing from the pinned installed plugin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-folder-patch-'));
    const packageDirectory = join(
      directory,
      'node_modules',
      '@quartz-community',
      'folder-page',
    );
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      '{"name":"@quartz-community/folder-page","version":"0.1.0"}',
    );
    await writeFile(
      join(packageDirectory, 'dist', 'index.js'),
      'before\nconst pageListContent = PageList(listProps);\nafter',
    );

    await applyInstalledQuartzCompatibilityPatch(directory);

    const patched = await readFile(join(packageDirectory, 'dist', 'index.js'), 'utf8');
    expect(patched).toContain('pages-publish-controlled-section-list');
    expect(patched).not.toContain('PageList(listProps)');
  });

  it('verifies both source and installed compatibility patches before cache reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-all-patches-'));
    await mkdir(join(directory, 'quartz', 'cli'), { recursive: true });
    await writeFile(
      join(directory, 'quartz', 'cli', 'handlers.js'),
      [
        'import serveHandler from "serve-handler"',
        'cssImports: true,',
        'cssImports: true,',
        'await import(`../../${cacheFile}?update=${randomUUID()}`)',
        '        await serveHandler(req, res, {',
      ].join('\n'),
    );
    await writeGlobFixture(directory);
    const packageDirectory = join(
      directory,
      'node_modules',
      '@quartz-community',
      'folder-page',
    );
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      '{"name":"@quartz-community/folder-page","version":"0.1.0"}',
    );
    await writeFile(
      join(packageDirectory, 'dist', 'index.js'),
      'const pageListContent = PageList(listProps);',
    );

    await applyQuartzEngineCompatibilityPatch(directory);
    await applyInstalledQuartzCompatibilityPatch(directory);

    await expect(quartzCompatibilityPatchesMatch(directory)).resolves.toBe(true);
    await writeFile(join(packageDirectory, 'dist', 'index.js'), 'tampered');
    await expect(quartzCompatibilityPatchesMatch(directory)).resolves.toBe(false);
  });
});

async function writeGlobFixture(directory: string): Promise<void> {
  await mkdir(join(directory, 'quartz', 'util'), { recursive: true });
  await writeFile(
    join(directory, 'quartz', 'util', 'glob.ts'),
    'await globby(pattern, { cwd, ignore: ignorePatterns, gitignore: true, })',
  );
}
