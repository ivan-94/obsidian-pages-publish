import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installStagedObsidianPlugin,
  uninstallStagedObsidianPlugin,
} from '../scripts/obsidian-plugin-install.mjs';

describe('clean-Vault plugin file lifecycle smoke', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it('installs, upgrades, and uninstalls only the candidate plugin directory', async () => {
    const vault = await temporaryDirectory('pages-publish-clean-vault-');
    const firstPackage = await stagedPackage('first');
    const secondPackage = await stagedPackage('second');
    const configDir = 'config';
    const pluginDirectory = join(vault, configDir, 'plugins', 'pages-publish');
    const siteConfig = join(vault, '.publish', 'site.yml');
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(siteConfig, 'version: 1\n', 'utf8');

    await expect(installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir,
      stagedDirectory: firstPackage,
    })).resolves.toEqual({
      pluginDirectory,
      pluginId: 'pages-publish',
      version: '0.1.0',
    });
    expect(await readdir(pluginDirectory)).toEqual([
      'main.js',
      'manifest.json',
      'styles.css',
    ]);
    await writeFile(join(pluginDirectory, 'data.json'), '{"selectedAccountId":"account-1"}\n', 'utf8');

    await installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir,
      stagedDirectory: secondPackage,
    });
    await expect(readFile(join(pluginDirectory, 'main.js'), 'utf8')).resolves.toBe('second\n');
    await expect(readFile(join(pluginDirectory, 'data.json'), 'utf8')).resolves.toContain('account-1');
    await expect(readFile(siteConfig, 'utf8')).resolves.toBe('version: 1\n');

    await uninstallStagedObsidianPlugin({
      vaultRoot: vault,
      configDir,
      pluginId: 'pages-publish',
    });
    await expect(readdir(pluginDirectory)).rejects.toThrow();
    await expect(readFile(siteConfig, 'utf8')).resolves.toBe('version: 1\n');
  });

  it('refuses unsafe package contents and a config directory outside the selected Vault', async () => {
    const vault = await temporaryDirectory('pages-publish-clean-vault-');
    const packageDirectory = await stagedPackage('candidate');
    await writeFile(join(packageDirectory, 'token.txt'), 'not installable', 'utf8');

    await expect(installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: 'config',
      stagedDirectory: packageDirectory,
    })).rejects.toThrow(/exactly the three installable files/i);
    await expect(uninstallStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: '../outside',
      pluginId: 'pages-publish',
    })).rejects.toThrow(/remain inside the selected Vault/i);
  });

  it('does not create a config directory when uninstalling an absent plugin', async () => {
    const vault = await temporaryDirectory('pages-publish-clean-vault-');

    await uninstallStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: 'config',
      pluginId: 'pages-publish',
    });

    await expect(readdir(join(vault, 'config'))).rejects.toThrow();
  });

  it('rejects ancestor symlinks and atomically replaces a malicious destination symlink', async () => {
    const vault = await temporaryDirectory('pages-publish-clean-vault-');
    const outside = await temporaryDirectory('pages-publish-outside-');
    const packageDirectory = await stagedPackage('candidate');
    await symlink(outside, join(vault, 'config'));

    await expect(installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: 'config/nested',
      stagedDirectory: packageDirectory,
    })).rejects.toThrow(/symbolic link|remain inside the selected Vault/i);
    await expect(uninstallStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: 'config/nested',
      pluginId: 'pages-publish',
    })).rejects.toThrow(/symbolic link|remain inside the selected Vault/i);
    await expect(readdir(outside)).resolves.toEqual([]);

    const safeConfigDir = 'safe-config';
    const installed = await installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: safeConfigDir,
      stagedDirectory: packageDirectory,
    });
    const outsideMain = join(outside, 'outside-main.js');
    await writeFile(outsideMain, 'must-not-change\n', 'utf8');
    await rm(join(installed.pluginDirectory, 'main.js'));
    await symlink(outsideMain, join(installed.pluginDirectory, 'main.js'));

    await installStagedObsidianPlugin({
      vaultRoot: vault,
      configDir: safeConfigDir,
      stagedDirectory: packageDirectory,
    });
    expect((await lstat(join(installed.pluginDirectory, 'main.js'))).isSymbolicLink()).toBe(false);
    await expect(readFile(join(installed.pluginDirectory, 'main.js'), 'utf8')).resolves.toBe('candidate\n');
    await expect(readFile(outsideMain, 'utf8')).resolves.toBe('must-not-change\n');
  });

  async function stagedPackage(mainSource: string): Promise<string> {
    const directory = await temporaryDirectory('pages-publish-staged-package-');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      id: 'pages-publish',
      name: 'Pages Publish',
      version: '0.1.0',
      minAppVersion: '1.13.0',
      isDesktopOnly: true,
    }), 'utf8');
    await writeFile(join(directory, 'main.js'), `${mainSource}\n`, 'utf8');
    await writeFile(join(directory, 'styles.css'), '', 'utf8');
    return directory;
  }

  async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }
});
