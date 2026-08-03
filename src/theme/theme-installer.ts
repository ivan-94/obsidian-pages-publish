import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  assertLocalThemeArtifact,
  type LocalThemeReference,
  type NpmThemeReference,
} from './theme-contract';
import { ThemeRegistryClient } from './theme-registry-client';
import {
  ThemeStore,
  ThemeStoreError,
  type InstalledTheme,
} from './theme-store';

const MAX_LOCAL_THEME_BYTES = 16 * 1024 * 1024;

export interface InstalledNpmTheme {
  installed: InstalledTheme;
  reference: NpmThemeReference;
  publisher?: { name?: string; email?: string };
}

export interface InstalledLocalTheme {
  installed: InstalledTheme;
  reference: LocalThemeReference;
}

export class ThemeInstaller {
  constructor(
    private readonly store: ThemeStore,
    private readonly registry: ThemeRegistryClient,
  ) {}

  async installNpm(
    packageName: string,
    version: string,
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledNpmTheme> {
    const artifact = await this.registry.downloadExact(packageName, version, signal);
    const installed = await this.store.install({
      archive: artifact.archive,
      integrity: artifact.integrity,
      source: {
        kind: 'npm',
        packageName: artifact.packageName,
        version: artifact.version,
        tarballUrl: artifact.tarballUrl,
        ...(artifact.publisher === undefined ? {} : { publisher: artifact.publisher }),
      },
      supportedQuartzVersion,
      signal,
    });
    return {
      installed,
      reference: {
        source: 'npm',
        package: artifact.packageName,
        version: artifact.version,
        integrity: artifact.integrity,
        options: {},
      },
      ...(artifact.publisher === undefined ? {} : { publisher: artifact.publisher }),
    };
  }

  async importLocal(
    vaultRoot: string,
    selectedFile: string,
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledLocalTheme> {
    signal?.throwIfAborted();
    const stats = await lstat(selectedFile);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0 || stats.size > MAX_LOCAL_THEME_BYTES) {
      throw new ThemeStoreError(
        'local-theme-artifact-invalid',
        'Selected local theme must be a regular bounded .tgz file.',
      );
    }
    if (!basename(selectedFile).toLowerCase().endsWith('.tgz')) {
      throw new ThemeStoreError(
        'local-theme-artifact-invalid',
        'Selected local theme must use the .tgz extension.',
      );
    }
    const archive = await readFile(selectedFile);
    signal?.throwIfAborted();
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    const artifact = `.publish/themes/theme-${createHash('sha256').update(integrity).digest('hex').slice(0, 20)}.tgz`;
    const target = join(vaultRoot, ...artifact.split('/'));
    const artifactCreated = await copyLocalArtifact(vaultRoot, archive, target);
    try {
      const installed = await this.store.install({
        archive,
        integrity,
        source: { kind: 'local', artifact },
        supportedQuartzVersion,
        signal,
      });
      return {
        installed,
        reference: {
          source: 'local',
          artifact,
          integrity,
          options: {},
        },
      };
    } catch (error) {
      if (artifactCreated) {
        await rm(target, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async repair(
    vaultRoot: string,
    reference: NpmThemeReference | LocalThemeReference,
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledTheme> {
    if (reference.source === 'npm') {
      const artifact = await this.registry.downloadExact(
        reference.package,
        reference.version,
        signal,
      );
      if (artifact.integrity !== reference.integrity) {
        throw new ThemeStoreError(
          'theme-repair-integrity-mismatch',
          'Registry artifact no longer matches the configured integrity.',
        );
      }
      return this.store.repair({
        archive: artifact.archive,
        integrity: artifact.integrity,
        source: {
          kind: 'npm',
          packageName: artifact.packageName,
          version: artifact.version,
          tarballUrl: artifact.tarballUrl,
          ...(artifact.publisher === undefined ? {} : { publisher: artifact.publisher }),
        },
        supportedQuartzVersion,
        signal,
      });
    }
    assertLocalThemeArtifact(reference.artifact, 'site.theme.artifact');
    const artifactPath = join(vaultRoot, ...reference.artifact.split('/'));
    await assertDirectoryNotSymlink(vaultRoot);
    await assertPathNotSymlink(join(vaultRoot, '.publish'));
    await assertPathNotSymlink(join(vaultRoot, '.publish', 'themes'));
    const stats = await lstat(artifactPath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size <= 0
      || stats.size > MAX_LOCAL_THEME_BYTES
    ) {
      throw new ThemeStoreError(
        'local-theme-artifact-invalid',
        'Configured local theme must be a regular bounded .tgz file.',
      );
    }
    const archive = new Uint8Array(await readFile(artifactPath));
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== reference.integrity) {
      throw new ThemeStoreError(
        'theme-repair-integrity-mismatch',
        'Vault theme artifact no longer matches the configured integrity.',
      );
    }
    return this.store.repair({
      archive,
      integrity,
      source: { kind: 'local', artifact: reference.artifact },
      supportedQuartzVersion,
      signal,
    });
  }
}

async function copyLocalArtifact(
  vaultRoot: string,
  archive: Uint8Array,
  target: string,
): Promise<boolean> {
  const publishDirectory = join(vaultRoot, '.publish');
  const themesDirectory = join(publishDirectory, 'themes');
  await assertDirectoryNotSymlink(vaultRoot);
  await assertPathNotSymlink(publishDirectory);
  await mkdir(themesDirectory, { recursive: true });
  await assertPathNotSymlink(publishDirectory);
  await assertPathNotSymlink(themesDirectory);
  try {
    const existing = await readFile(target);
    if (Buffer.compare(existing, archive) === 0) return false;
    throw new ThemeStoreError(
      'local-theme-artifact-conflict',
      'Vault theme artifact path already contains different bytes.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(archive);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    return true;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ThemeStoreError(
      'local-theme-vault-unsafe',
      'Vault root must be a real directory.',
    );
  }
}

async function assertPathNotSymlink(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ThemeStoreError(
        'local-theme-vault-unsafe',
        'Local theme directory cannot be a symbolic link.',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
