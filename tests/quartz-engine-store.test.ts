import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
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
    const lockfile = Buffer.from('{"lockfileVersion":3}');
    const archive = sourceArchive(lockfile);
    const manifest = engineManifest(archive, lockfile, 'pages-publish-quartz-5.0.0.1');
    const installDependencies = vi.fn(async ({ sourceDirectory }: LockedNpmInstallRequest) => {
      await mkdir(join(sourceDirectory, 'node_modules'), { recursive: true });
    });
    const smoke = vi.fn(async ({ engineDirectory }: QuartzEngineSmokeRequest) => {
      await expect(readFile(join(engineDirectory, 'package.json'), 'utf8')).resolves.toContain(
        '5.0.0',
      );
    });
    const store = new QuartzEngineStore({
      rootDirectory,
      download: async () => archive,
      installDependencies,
      smoke,
    });

    const runtime = await store.ensureReady(manifest, runtimeTools());

    expect(runtime.engineVersion).toBe(manifest.engineVersion);
    expect(runtime.platform).toBe('darwin-arm64');
    expect(runtime.usingFallback).toBe(false);
    expect(installDependencies).toHaveBeenCalledOnce();
    expect(smoke).toHaveBeenCalledOnce();
    const active = JSON.parse(
      await readFile(join(rootDirectory, 'active-darwin-arm64.json'), 'utf8'),
    ) as { engineVersion: string };
    expect(active.engineVersion).toBe(manifest.engineVersion);
  });

  it('reuses the exact verified installation without network access', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-engine-cache-'));
    const lockfile = Buffer.from('{"lockfileVersion":3}');
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
    const oldLockfile = Buffer.from('{"lockfileVersion":3,"old":true}');
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
    const newLockfile = Buffer.from('{"lockfileVersion":3,"new":true}');
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
        'sassPlugin({ cssImports: true, })',
        'sassPlugin({ cssImports: true, })',
        'await import(`../../${cacheFile}?update=${randomUUID()}`)',
      ].join('\n'),
    },
    { name: 'quartz-source/quartz/bootstrap-cli.mjs', body: 'export {}' },
  ]);
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
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
