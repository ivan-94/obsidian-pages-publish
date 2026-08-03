import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  builtinManagedNodeManifest,
  ManagedNodeRuntimeStore,
  type ManagedNodeVerificationRequest,
} from '../src/runtime/managed-node-runtime';

describe('managed Node runtime', () => {
  it.each([
    ['darwin-arm64', 'ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953'],
    ['darwin-x64', 'b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81'],
  ] as const)('pins the official Node 22 runtime for %s', (platform, sha256) => {
    expect(builtinManagedNodeManifest(platform)).toEqual({
      version: '22.23.1',
      npmVersion: '10.9.8',
      platform,
      sourceUrl: `https://nodejs.org/dist/v22.23.1/node-v22.23.1-${platform.replace('darwin-', 'darwin-')}.tar.gz`,
      sourceSha256: sha256,
    });
  });

  it('installs and reuses a checksum-verified runtime outside the Vault', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-node-store-'));
    const archive = nodeArchive();
    const manifest = {
      ...builtinManagedNodeManifest('darwin-arm64'),
      sourceSha256: createHash('sha256').update(archive).digest('hex'),
    };
    const download = vi.fn(async () => archive);
    const verify = vi.fn(async ({ nodeExecutable, npmCliPath }: ManagedNodeVerificationRequest) => {
      await expect(readFile(nodeExecutable, 'utf8')).resolves.toBe('node-binary');
      await expect(readFile(npmCliPath, 'utf8')).resolves.toBe('npm-cli');
    });
    const store = new ManagedNodeRuntimeStore({ rootDirectory, download, verify });

    const first = await store.ensureReady(manifest);
    const second = await store.ensureReady(manifest);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ nodeVersion: '22.23.1', npmVersion: '10.9.8' });
    expect(download).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it('rejects a runtime whose archive checksum does not match', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-node-reject-'));
    const verify = vi.fn();
    const store = new ManagedNodeRuntimeStore({
      rootDirectory,
      download: async () => nodeArchive(),
      verify,
    });

    await expect(
      store.ensureReady(builtinManagedNodeManifest('darwin-arm64')),
    ).rejects.toThrow('checksum');
    expect(verify).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.PAGES_PUBLISH_NODE_ARCHIVE)(
    'extracts and verifies the real pinned Node distribution',
    async () => {
      const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-real-node-store-'));
      const archive = await readFile(process.env.PAGES_PUBLISH_NODE_ARCHIVE!);
      const store = new ManagedNodeRuntimeStore({
        rootDirectory,
        download: async () => archive,
      });

      await expect(
        store.ensureReady(builtinManagedNodeManifest('darwin-arm64')),
      ).resolves.toMatchObject({ nodeVersion: '22.23.1', npmVersion: '10.9.8' });
    },
    60_000,
  );
});

function nodeArchive(): Uint8Array {
  return tarGz([
    { name: 'node-v22.23.1/', type: 'directory' },
    { name: 'node-v22.23.1/bin/', type: 'directory' },
    { name: 'node-v22.23.1/bin/node', body: 'node-binary' },
    { name: 'node-v22.23.1/lib/', type: 'directory' },
    { name: 'node-v22.23.1/lib/node_modules/', type: 'directory' },
    { name: 'node-v22.23.1/lib/node_modules/npm/', type: 'directory' },
    { name: 'node-v22.23.1/lib/node_modules/npm/bin/', type: 'directory' },
    { name: 'node-v22.23.1/lib/node_modules/npm/bin/npm-cli.js', body: 'npm-cli' },
  ]);
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
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = member.type === 'directory' ? 0x35 : 0x30;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 2, '0')}\0 `, offset, length, 'ascii');
}
