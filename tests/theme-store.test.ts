import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ThemeStore,
  type ThemeSmokeRequest,
} from '../src/theme/theme-store';
import { ThemeTrustStore } from '../src/theme/theme-trust-store';
import {
  sha512Integrity,
  tarGz,
  themePackageArchive,
} from './support/theme-package-fixture';

const optionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { accent: { type: 'string', enum: ['orange', 'yellow'] } },
};

describe('isolated theme store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'pages-theme-store-'));
    roots.push(directory);
    return directory;
  }

  it('verifies, inventories, smokes and atomically installs an npm theme', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive({ optionsSchema });
    const smoke = vi.fn(async ({ packageDirectory, optionsSchema: schema }: ThemeSmokeRequest) => {
      await expect(readFile(join(packageDirectory, 'dist', 'index.js'), 'utf8'))
        .resolves.toContain('export default');
      expect(schema).toMatchObject({ additionalProperties: false });
    });
    const checkDiskCapacity = vi.fn(async () => undefined);
    const store = new ThemeStore({
      rootDirectory,
      smoke,
      checkDiskCapacity,
      now: () => new Date('2026-08-03T00:00:00.000Z'),
    });

    const installed = await store.install({
      archive,
      integrity: sha512Integrity(archive),
      source: {
        kind: 'npm',
        packageName: '@pages-publish-theme/brutalist',
        version: '1.0.0',
        tarballUrl: 'https://registry.npmjs.org/@pages-publish-theme/brutalist/-/brutalist-1.0.0.tgz',
      },
      supportedQuartzVersion: '5.0.0',
    });

    expect(installed.receipt).toMatchObject({
      formatVersion: 1,
      packageName: '@pages-publish-theme/brutalist',
      version: '1.0.0',
      smokeVersion: 1,
      installedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(installed.receipt.inventory.map((entry) => entry.path)).toEqual([
      'dist/index.js',
      'dist/options.schema.json',
      'dist/theme.css',
      'package.json',
    ]);
    expect(smoke).toHaveBeenCalledOnce();
    expect(checkDiskCapacity).toHaveBeenCalledOnce();
    await expect(readdir(join(rootDirectory, 'themes'))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.install-/)]),
    );
  });

  it('revalidates cache inventory and smoke without network or npm install', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive();
    const smoke = vi.fn(async () => undefined);
    const store = new ThemeStore({ rootDirectory, smoke });
    const request = {
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local' as const, artifact: '.publish/themes/theme.tgz' },
      supportedQuartzVersion: '5.0.0',
    };
    const first = await store.install(request);
    const second = await store.install(request);

    expect(second.installationDirectory).toBe(first.installationDirectory);
    expect(smoke).toHaveBeenCalledTimes(3);

    await chmod(join(first.packageDirectory, 'dist', 'theme.css'), 0o644);
    await writeFile(join(first.packageDirectory, 'dist', 'theme.css'), 'tampered');
    await expect(store.resolveIntegrity(request.integrity, '5.0.0')).rejects.toMatchObject({
      code: 'theme-installation-damaged',
    });
  });

  it('rejects unsafe archives, identity drift and invalid options schemas', async () => {
    const rootDirectory = await root();
    const store = new ThemeStore({ rootDirectory, smoke: async () => undefined });
    const unsafe = tarGz([
      { name: 'package/', type: 'directory' },
      { name: 'package/link', type: 'symlink', link: '/tmp/private' },
    ]);
    await expect(store.install({
      archive: unsafe,
      integrity: sha512Integrity(unsafe),
      source: { kind: 'local', artifact: '.publish/themes/unsafe.tgz' },
      supportedQuartzVersion: '5.0.0',
    })).rejects.toMatchObject({ code: 'theme-archive-unsafe' });

    const wrongIdentity = themePackageArchive({ name: 'other-theme' });
    await expect(store.install({
      archive: wrongIdentity,
      integrity: sha512Integrity(wrongIdentity),
      source: {
        kind: 'npm',
        packageName: '@pages-publish-theme/brutalist',
        version: '1.0.0',
        tarballUrl: 'https://registry.npmjs.org/theme.tgz',
      },
      supportedQuartzVersion: '5.0.0',
    })).rejects.toMatchObject({ code: 'theme-package-identity-mismatch' });

    const openSchema = themePackageArchive({
      optionsSchema: { type: 'object', additionalProperties: true },
    });
    await expect(store.install({
      archive: openSchema,
      integrity: sha512Integrity(openSchema),
      source: { kind: 'local', artifact: '.publish/themes/open.tgz' },
      supportedQuartzVersion: '5.0.0',
    })).rejects.toMatchObject({ code: 'theme-options-schema-invalid' });
  });

  it('keeps the old verified bytes when Repair smoke fails', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive();
    const smoke = vi.fn(async () => undefined);
    const request = {
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local' as const, artifact: '.publish/themes/theme.tgz' },
      supportedQuartzVersion: '5.0.0',
    };
    const store = new ThemeStore({ rootDirectory, smoke });
    const installed = await store.install(request);
    const receiptBefore = await readFile(join(installed.installationDirectory, 'receipt.json'));
    smoke.mockRejectedValueOnce(new Error('smoke failed'));

    await expect(store.repair(request)).rejects.toMatchObject({ code: 'theme-install-failed' });

    await expect(readFile(join(installed.installationDirectory, 'receipt.json')))
      .resolves.toEqual(receiptBefore);
  });

  it('requires explicit executable/client script trust for each integrity', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive({ capabilities: ['styles', 'clientScripts'] });
    const store = new ThemeStore({ rootDirectory, smoke: async () => undefined });
    const installed = await store.install({
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local', artifact: '.publish/themes/theme.tgz' },
      supportedQuartzVersion: '5.0.0',
    });
    const trust = new ThemeTrustStore(
      rootDirectory,
      () => new Date('2026-08-03T00:00:00.000Z'),
    );

    await expect(trust.isTrusted(installed.receipt)).resolves.toBe(false);
    await expect(trust.confirm(installed.receipt)).resolves.toMatchObject({
      executableCodeAccepted: true,
      clientScriptsAccepted: true,
      acceptedAt: '2026-08-03T00:00:00.000Z',
    });
    await expect(trust.isTrusted(installed.receipt)).resolves.toBe(true);
  });

  it('fails closed when a persisted execution trust receipt is malformed', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive({ capabilities: ['styles', 'clientScripts'] });
    const store = new ThemeStore({ rootDirectory, smoke: async () => undefined });
    const installed = await store.install({
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local', artifact: '.publish/themes/theme.tgz' },
      supportedQuartzVersion: '5.0.0',
    });
    await mkdir(join(rootDirectory, 'themes'), { recursive: true });
    await writeFile(join(rootDirectory, 'themes', 'trust-receipts.json'), JSON.stringify({
      formatVersion: 1,
      receipts: [{
        packageName: installed.receipt.packageName,
        displayName: 'Tampered',
        version: installed.receipt.version,
        integrity: installed.receipt.integrity,
        capabilities: ['clientScripts', 'unknown'],
        executableCodeAccepted: true,
        clientScriptsAccepted: true,
        acceptedAt: 'not-a-date',
      }],
    }));

    const trust = new ThemeTrustStore(rootDirectory);
    await expect(trust.isTrusted(installed.receipt)).rejects.toThrow(/capabilities is invalid/);
  });

  it('blocks uninstall while any Vault still references the exact theme', async () => {
    const rootDirectory = await root();
    const archive = themePackageArchive();
    const store = new ThemeStore({ rootDirectory, smoke: async () => undefined });
    const installed = await store.install({
      archive,
      integrity: sha512Integrity(archive),
      source: { kind: 'local', artifact: '.publish/themes/theme.tgz' },
      supportedQuartzVersion: '5.0.0',
    });
    const identity = installed.receipt;

    await expect(store.uninstall(identity, async () => true)).rejects.toMatchObject({
      code: 'theme-in-use',
    });
    await store.uninstall(identity, async () => false);
    await expect(store.resolveIntegrity(identity.integrity, '5.0.0')).rejects.toMatchObject({
      code: 'theme-not-installed',
    });
  });
});
