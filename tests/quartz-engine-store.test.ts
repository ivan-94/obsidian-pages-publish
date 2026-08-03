import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  QuartzEngineStore,
  type QuartzEngineSmokeRequest,
  type QuartzEngineRuntimeTools,
} from '../src/runtime/quartz-engine-store';
import type { QuartzEngineManifest } from '../src/runtime/quartz-engine-manifest';
import type { LockedNpmInstallRequest } from '../src/runtime/npm-installer';

describe('Quartz engine store', () => {
  it('installs, smoke-checks, and atomically activates an exact engine', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-store-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const runtimeAsset = bytes('window.vendor=true');
    const manifest: QuartzEngineManifest = {
      ...engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.1'),
      runtimeAssets: [{
        outputPath: 'static/vendor/test-1.2.3.js',
        sourceUrl: 'https://cdn.jsdelivr.net/npm/test@1.2.3/dist/test.js',
        sourceSha256: sha256(runtimeAsset),
      }],
    };
    const installDependencies = vi.fn(async ({ sourceDirectory }: LockedNpmInstallRequest) => {
      await Promise.all([
        mkdir(join(sourceDirectory, 'node_modules', 'sharp'), { recursive: true }),
        mkdir(join(sourceDirectory, 'node_modules', 'serve-handler'), { recursive: true }),
        mkdir(join(sourceDirectory, 'node_modules', '@img', 'sharp-libvips-test'), {
          recursive: true,
        }),
      ]);
    });
    const smoke = vi.fn(async ({ engineDirectory }: QuartzEngineSmokeRequest) => {
      await expect(readFile(join(engineDirectory, 'package.json'), 'utf8')).resolves.toContain(
        '5.0.0',
      );
    });
    const checkDiskCapacity = vi.fn(async () => undefined);
    const checkEnvironmentSize = vi.fn(async () => undefined);
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async (url) => url === manifest.sourceUrl ? archive : runtimeAsset,
      installDependencies,
      smoke,
      checkDiskCapacity,
      checkEnvironmentSize,
    });

    const progress: string[] = [];
    const runtime = await store.ensureReady(
      manifest,
      runtimeTools(),
      undefined,
      (stage) => progress.push(stage),
    );

    expect(runtime.engineVersion).toBe(manifest.engineVersion);
    expect(runtime.platform).toBe('darwin-arm64');
    expect(runtime.usingFallback).toBe(false);
    expect(installDependencies).toHaveBeenCalledOnce();
    expect(smoke).toHaveBeenCalledOnce();
    expect(checkDiskCapacity).toHaveBeenCalledOnce();
    expect(checkEnvironmentSize).toHaveBeenCalledOnce();
    expect(progress).toEqual([
      'downloading-engine',
      'installing-engine',
      'smoke-testing',
    ]);
    await expect(
      access(join(runtime.engineDirectory, 'node_modules', 'sharp')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(runtime.engineDirectory, '.pages-publish-dependencies.json'), 'utf8'),
    ).resolves.toContain('"securityDispositions"');
    await expect(
      readFile(
        join(
          runtime.engineDirectory,
          '.pages-publish-runtime-assets',
          'static',
          'vendor',
          'test-1.2.3.js',
        ),
        'utf8',
      ),
    ).resolves.toBe('window.vendor=true');
    const active = JSON.parse(
      await readFile(join(rootDirectory, 'active-darwin-arm64.json'), 'utf8'),
    ) as { engineVersion: string };
    expect(active.engineVersion).toBe(manifest.engineVersion);
  });

  it('reuses the exact verified installation without network access', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-cache-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.2');
    const first = new QuartzEngineStore({
      rootDirectory,
      download: async () => archive,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    });
    await first.ensureReady(manifest, runtimeTools());
    const download = vi.fn();
    const second = new QuartzEngineStore({
      rootDirectory,
      download,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    });

    await expect(second.ensureReady(manifest, runtimeTools())).resolves.toMatchObject({
      engineVersion: manifest.engineVersion,
      usingFallback: false,
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps and returns the last verified engine when an update fails', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-fallback-'));
    const oldLockfile = Buffer.from('{"lockfileVersion":3,"packages":{},"old":true}');
    const oldArchive = sourceArchive(oldLockfile);
    const oldManifest = engineManifest(
      oldArchive,
      oldLockfile,
      'pages-publish-quartz-5.0.0.3',
    );
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async () => oldArchive,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    });
    await store.ensureReady(oldManifest, runtimeTools());
    const newLockfile = Buffer.from('{"lockfileVersion":3,"packages":{},"new":true}');
    const newArchive = sourceArchive(newLockfile);
    const newManifest = engineManifest(
      newArchive,
      newLockfile,
      'pages-publish-quartz-5.0.0.4',
    );
    const failingStore = new QuartzEngineStore({
      rootDirectory,
      download: async () => newArchive,
      installDependencies: async () => undefined,
      smoke: async () => {
        throw new Error('offline smoke failed');
      },
    });

    await expect(failingStore.ensureReady(newManifest, runtimeTools())).resolves.toMatchObject({
      engineVersion: oldManifest.engineVersion,
      usingFallback: true,
    });
    const active = JSON.parse(
      await readFile(join(rootDirectory, 'active-darwin-arm64.json'), 'utf8'),
    ) as { engineVersion: string };
    expect(active.engineVersion).toBe(oldManifest.engineVersion);
  });

  it('does not turn cancellation into a successful fallback', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-cancel-'));
    const oldLockfile = Buffer.from('{"lockfileVersion":3,"packages":{},"old":true}');
    const oldArchive = sourceArchive(oldLockfile);
    const oldManifest = engineManifest(
      oldArchive,
      oldLockfile,
      'pages-publish-quartz-5.0.0.3',
    );
    await new QuartzEngineStore({
      rootDirectory,
      download: async () => oldArchive,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    }).ensureReady(oldManifest, runtimeTools());
    const newLockfile = Buffer.from('{"lockfileVersion":3,"packages":{},"new":true}');
    const newArchive = sourceArchive(newLockfile);
    const newManifest = engineManifest(
      newArchive,
      newLockfile,
      'pages-publish-quartz-5.0.0.4',
    );
    const controller = new AbortController();
    controller.abort();
    const updatingStore = new QuartzEngineStore({
      rootDirectory,
      download: async (_url, signal) => {
        signal?.throwIfAborted();
        return newArchive;
      },
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    });

    await expect(
      updatingStore.ensureReady(newManifest, runtimeTools(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes the temporary engine only after the cancelled installer has stopped', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-cancel-cleanup-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(
      archive,
      lockfile,
      'pages-publish-quartz-5.0.0.6',
    );
    const controller = new AbortController();
    let markInstallStarted = (): void => undefined;
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async () => archive,
      installDependencies: async ({ sourceDirectory, signal }) => {
        markInstallStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            void writeFile(join(sourceDirectory, 'installer-stopped'), 'stopped').then(
              () => reject(new DOMException('cancelled', 'AbortError')),
              (error: Error) => reject(error),
            );
          }, { once: true });
        });
      },
      smoke: async () => undefined,
    });

    const preparing = store.ensureReady(manifest, runtimeTools(), controller.signal);
    const cancelled = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    await installStarted;
    controller.abort();
    await cancelled;

    await expect(readdir(join(rootDirectory, 'engines', 'darwin-arm64'))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.install-/)]),
    );
  });

  it('forces a verified engine reinstall during Repair', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-repair-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.5');
    const download = vi.fn(async () => archive);
    const installDependencies = vi.fn(async () => undefined);
    const store = new QuartzEngineStore({
      rootDirectory,
      download,
      installDependencies,
      smoke: async () => undefined,
    });

    await store.ensureReady(manifest, runtimeTools());
    await store.repair(manifest, runtimeTools());

    expect(download).toHaveBeenCalledTimes(2);
    expect(installDependencies).toHaveBeenCalledTimes(2);
    await expect(readdir(join(rootDirectory, 'engines', 'darwin-arm64'))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.replaced-/)]),
    );
  });

  it('retains only the active engine and its previous verified fallback across upgrades', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-retention-'));
    const install = async (suffix: number): Promise<string> => {
      const lockfile = Buffer.from(`{"lockfileVersion":3,"packages":{},"v":${suffix}}`);
      const archive = sourceArchive(lockfile);
      const manifest = engineManifest(
        archive,
        lockfile,
        `pages-publish-quartz-5.0.0.${suffix}`,
      );
      return (await new QuartzEngineStore({
        rootDirectory,
        download: async () => archive,
        installDependencies: async () => undefined,
        smoke: async () => undefined,
      }).ensureReady(manifest, runtimeTools())).engineDirectory;
    };

    const first = await install(11);
    const second = await install(12);
    const unknownDirectory = join(
      rootDirectory,
      'engines',
      'darwin-arm64',
      'unrecognised-directory',
    );
    await mkdir(unknownDirectory, { recursive: true });
    const third = await install(13);

    await expect(access(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(second)).resolves.toBeUndefined();
    await expect(access(third)).resolves.toBeUndefined();
    await expect(access(unknownDirectory)).resolves.toBeUndefined();
  });

  it.each([
    {
      label: 'download',
      expectedCode: 'quartz-engine-download-failed',
      dependencies: { download: async () => { throw new Error('offline'); } },
    },
    {
      label: 'integrity',
      expectedCode: 'quartz-engine-integrity-failed',
      dependencies: { download: async () => new Uint8Array([1, 2, 3]) },
    },
    {
      label: 'install',
      expectedCode: 'quartz-engine-install-failed',
      dependencies: { installDependencies: async () => { throw new Error('npm failed'); } },
    },
    {
      label: 'smoke',
      expectedCode: 'quartz-engine-smoke-failed',
      dependencies: { smoke: async () => { throw new Error('smoke failed'); } },
    },
  ])('reports a stable $label failure code', async ({ expectedCode, dependencies }) => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-errors-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.6');
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async () => archive,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
      ...dependencies,
    });

    await expect(store.ensureReady(manifest, runtimeTools())).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it('rejects an incompatible runtime with a stable error code', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-runtime-'));
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.7');
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async () => archive,
      installDependencies: async () => undefined,
      smoke: async () => undefined,
    });

    await expect(store.ensureReady(manifest, {
      ...runtimeTools(),
      nodeVersion: '20.19.0',
    })).rejects.toMatchObject({ code: 'node-runtime-incompatible' });
  });
});

function runtimeTools(): QuartzEngineRuntimeTools {
  return {
    nodeExecutable: '/runtime/bin/node',
    nodeVersion: '22.14.0',
    npmCliPath: '/runtime/lib/node_modules/npm/bin/npm-cli.js',
    npmVersion: '10.9.2',
  };
}

function engineManifest(
  archive: Uint8Array,
  lockfile: Uint8Array,
  engineVersion: string,
): QuartzEngineManifest {
  return {
    engineVersion,
    quartzVersion: '5.0.0',
    sourceUrl: 'https://github.com/jackyzha0/quartz/archive/0123456789abcdef0123456789abcdef01234567.tar.gz',
    sourceSha256: sha256(archive),
    lockfileSha256: sha256(lockfile),
    nodeRange: '>=22',
    npmVersionRange: '>=10.9.2',
    platform: 'darwin-arm64',
  };
}

function sourceArchive(lockfile: Uint8Array): Uint8Array {
  return tarGz([
    { name: 'quartz-source/', type: 'directory' },
    { name: 'quartz-source/package.json', body: '{"name":"@jackyzha0/quartz","version":"5.0.0"}' },
    { name: 'quartz-source/package-lock.json', body: Buffer.from(lockfile).toString('utf8') },
    { name: 'quartz-source/quartz/', type: 'directory' },
    { name: 'quartz-source/quartz/cli/', type: 'directory' },
    {
      name: 'quartz-source/quartz/cli/handlers.js',
      body: [
        'import serveHandler from "serve-handler"',
        'sassPlugin({ cssImports: true, })',
        'sassPlugin({ cssImports: true, })',
        'await import(`../../${cacheFile}?update=${randomUUID()}`)',
        '        await serveHandler(req, res, {',
      ].join('\n'),
    },
    { name: 'quartz-source/quartz/bootstrap-cli.mjs', body: 'export {}' },
    { name: 'quartz-source/quartz/util/', type: 'directory' },
    {
      name: 'quartz-source/quartz/util/glob.ts',
      body: 'await globby(pattern, { cwd, ignore: ignorePatterns, gitignore: true, })',
    },
    {
      name: 'quartz-source/node_modules/@quartz-community/folder-page/package.json',
      body: '{"name":"@quartz-community/folder-page","version":"0.1.0"}',
    },
    {
      name: 'quartz-source/node_modules/@quartz-community/folder-page/dist/index.js',
      body: 'const pageListContent = PageList(listProps);',
    },
  ]);
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface TarMember {
  name: string;
  body?: string;
  type?: 'file' | 'directory';
}

function tarGz(members: TarMember[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const body = Buffer.from(member.body ?? '');
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100, 'utf8');
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, body.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = member.type === 'directory' ? 0x35 : 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    octal(header, 148, 8, header.reduce((sum, value) => sum + value, 0));
    blocks.push(header, body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function octal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 2, '0')}\0 `, offset, length, 'ascii');
}
