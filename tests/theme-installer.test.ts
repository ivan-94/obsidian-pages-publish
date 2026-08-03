import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeInstaller } from '../src/theme/theme-installer';
import { ThemeRegistryClient } from '../src/theme/theme-registry-client';
import { ThemeStore } from '../src/theme/theme-store';
import {
  sha512Integrity,
  themePackageArchive,
} from './support/theme-package-fixture';

describe('theme installer workflows', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  it('imports a local tgz into the Vault and installs an offline store copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-installer-'));
    const vault = await mkdtemp(join(tmpdir(), 'pages-theme-vault-'));
    roots.push(root, vault);
    const selected = join(root, 'brutalist.tgz');
    const archive = themePackageArchive();
    await writeFile(selected, archive);
    const installer = new ThemeInstaller(
      new ThemeStore({ rootDirectory: root, smoke: async () => undefined }),
      new ThemeRegistryClient(async () => {
        throw new Error('Registry must not be used for a local import.');
      }),
    );

    const result = await installer.importLocal(vault, selected, '5.0.0');

    expect(result.reference).toMatchObject({
      source: 'local',
      integrity: sha512Integrity(archive),
      options: {},
    });
    await expect(readFile(join(vault, ...result.reference.artifact.split('/'))))
      .resolves.toEqual(Buffer.from(archive));
    await rm(selected);
    await expect(readFile(join(result.installed.packageDirectory, 'package.json'), 'utf8'))
      .resolves.toContain('@pages-publish-theme/brutalist');
  });

  it('imports pathless browser file bytes without requiring a desktop absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-installer-'));
    const vault = await mkdtemp(join(tmpdir(), 'pages-theme-vault-'));
    roots.push(root, vault);
    const archive = themePackageArchive();
    const installer = new ThemeInstaller(
      new ThemeStore({ rootDirectory: root, smoke: async () => undefined }),
      new ThemeRegistryClient(async () => {
        throw new Error('Registry must not be used for a local byte import.');
      }),
    );

    const result = await installer.importLocalArchive(
      vault,
      'brutalist.tgz',
      archive,
      '5.0.0',
    );

    expect(result.reference.integrity).toBe(sha512Integrity(archive));
    await expect(readFile(join(vault, ...result.reference.artifact.split('/'))))
      .resolves.toEqual(Buffer.from(archive));
  });

  it('rejects a symlinked local artifact and symlinked Vault theme directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-installer-'));
    const vault = await mkdtemp(join(tmpdir(), 'pages-theme-vault-'));
    roots.push(root, vault);
    const archiveFile = join(root, 'real.tgz');
    const selected = join(root, 'linked.tgz');
    await writeFile(archiveFile, themePackageArchive());
    await symlink(archiveFile, selected);
    const installer = new ThemeInstaller(
      new ThemeStore({ rootDirectory: root, smoke: async () => undefined }),
      new ThemeRegistryClient(async () => {
        throw new Error('Registry must not be used for a local import.');
      }),
    );
    await expect(installer.importLocal(vault, selected, '5.0.0')).rejects.toMatchObject({
      code: 'local-theme-artifact-invalid',
    });

    await rm(selected);
    await mkdir(join(vault, '.publish'));
    await symlink(root, join(vault, '.publish', 'themes'));
    await expect(installer.importLocal(vault, archiveFile, '5.0.0')).rejects.toMatchObject({
      code: 'local-theme-vault-unsafe',
    });
  });

  it('rejects a local Repair artifact replaced by a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-installer-'));
    const vault = await mkdtemp(join(tmpdir(), 'pages-theme-vault-'));
    roots.push(root, vault);
    const selected = join(root, 'brutalist.tgz');
    await writeFile(selected, themePackageArchive());
    const installer = new ThemeInstaller(
      new ThemeStore({ rootDirectory: root, smoke: async () => undefined }),
      new ThemeRegistryClient(async () => {
        throw new Error('Registry must not be used for local Repair.');
      }),
    );
    const imported = await installer.importLocal(vault, selected, '5.0.0');
    const artifactPath = join(vault, ...imported.reference.artifact.split('/'));
    await rm(artifactPath);
    await symlink(selected, artifactPath);

    await expect(installer.repair(vault, imported.reference, '5.0.0')).rejects.toMatchObject({
      code: 'local-theme-artifact-invalid',
    });
  });
});
