import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePluginPackage } from '../scripts/release-package.mjs';

describe('release package staging', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('stages exactly the installable Obsidian plugin files under a versioned directory', async () => {
    const root = await pluginProject();
    const dist = await mkdtemp(join(tmpdir(), 'pages-publish-release-'));
    directories.push(dist);

    const result = await stagePluginPackage({ projectRoot: root, distRoot: dist });

    expect(result.pluginId).toBe('pages-publish');
    expect(result.version).toBe('0.1.0');
    expect(await readdir(result.directory)).toEqual([
      'main.js',
      'manifest.json',
      'styles.css',
    ]);
  });

  it('refuses a package with an unsupported minimum Obsidian version', async () => {
    const root = await pluginProject({ minAppVersion: '1.12.9' });
    const dist = await mkdtemp(join(tmpdir(), 'pages-publish-release-'));
    directories.push(dist);

    await expect(stagePluginPackage({ projectRoot: root, distRoot: dist })).rejects.toThrow(
      /minimum Obsidian version/i,
    );
  });

  it('refuses a release whose compatibility map disagrees with its manifest', async () => {
    const root = await pluginProject({ versionsMinAppVersion: '1.13.1' });
    const dist = await mkdtemp(join(tmpdir(), 'pages-publish-release-'));
    directories.push(dist);

    await expect(stagePluginPackage({ projectRoot: root, distRoot: dist })).rejects.toThrow(
      /versions\.json/i,
    );
  });

  it('refuses to stage when a required generated plugin asset is absent', async () => {
    const root = await pluginProject({ omit: 'main.js' });
    const dist = await mkdtemp(join(tmpdir(), 'pages-publish-release-'));
    directories.push(dist);

    await expect(stagePluginPackage({ projectRoot: root, distRoot: dist })).rejects.toThrow(
      /main\.js/i,
    );
  });

  async function pluginProject(
    options: {
      minAppVersion?: string;
      versionsMinAppVersion?: string;
      omit?: 'main.js' | 'styles.css';
    } = {},
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pages-publish-project-'));
    directories.push(root);
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        id: 'pages-publish',
        name: 'Pages Publish',
        version: '0.1.0',
        minAppVersion: options.minAppVersion ?? '1.13.0',
        isDesktopOnly: true,
      }),
      'utf8',
    );
    await writeFile(
      join(root, 'versions.json'),
      JSON.stringify({
        '0.1.0': options.versionsMinAppVersion ?? options.minAppVersion ?? '1.13.0',
      }),
      'utf8',
    );
    if (options.omit !== 'main.js') {
      await writeFile(join(root, 'main.js'), 'module.exports = {};\n', 'utf8');
    }
    if (options.omit !== 'styles.css') {
      await writeFile(join(root, 'styles.css'), '', 'utf8');
    }
    await mkdir(join(root, 'unrelated'), { recursive: true });
    await writeFile(join(root, 'unrelated', 'secret.txt'), 'not packaged', 'utf8');
    return root;
  }
});
