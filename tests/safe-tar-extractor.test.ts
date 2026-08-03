import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractTrustedNodeRuntimeTarGz,
  extractTrustedTarGz,
} from '../src/runtime/safe-tar-extractor';

describe('safe Quartz source extraction', () => {
  it('extracts regular files beneath the single archive root', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'pages-quartz-extract-'));
    const archive = tarGz([
      { name: 'quartz-commit/', type: 'directory' },
      { name: 'quartz-commit/package.json', body: '{"name":"@jackyzha0/quartz"}' },
      { name: 'quartz-commit/quartz/bootstrap-cli.mjs', body: 'export {}' },
    ]);

    await extractTrustedTarGz(archive, destination);

    await expect(readFile(join(destination, 'package.json'), 'utf8')).resolves.toContain(
      '@jackyzha0/quartz',
    );
    await expect(
      readFile(join(destination, 'quartz/bootstrap-cli.mjs'), 'utf8'),
    ).resolves.toBe('export {}');
  });

  it.each([
    { name: '../outside.txt', body: 'escape' },
    { name: '/absolute.txt', body: 'escape' },
    { name: 'quartz-commit/link', type: 'symlink' as const, link: '/tmp/target' },
  ])('rejects unsafe archive member $name', async (member) => {
    const destination = await mkdtemp(join(tmpdir(), 'pages-quartz-reject-'));

    await expect(extractTrustedTarGz(tarGz([member]), destination)).rejects.toThrow(
      'unsafe member',
    );
  });

  it('omits only the official Node CLI symlinks from a managed runtime', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'pages-node-extract-'));
    const archive = tarGz([
      { name: 'node-v22.23.1/', type: 'directory' },
      { name: 'node-v22.23.1/bin/', type: 'directory' },
      { name: 'node-v22.23.1/bin/node', body: 'binary' },
      {
        name: 'node-v22.23.1/bin/npm',
        type: 'symlink',
        link: '../lib/node_modules/npm/bin/npm-cli.js',
      },
    ]);

    await extractTrustedNodeRuntimeTarGz(archive, destination);

    await expect(readFile(join(destination, 'bin/node'), 'utf8')).resolves.toBe('binary');
    await expect(readFile(join(destination, 'bin/npm'), 'utf8')).rejects.toThrow();
  });
});

interface TestTarMember {
  name: string;
  body?: string;
  type?: 'file' | 'directory' | 'symlink';
  link?: string;
}

function tarGz(members: TestTarMember[]): Uint8Array {
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
    const type = member.type ?? 'file';
    header[156] = type === 'directory' ? 0x35 : type === 'symlink' ? 0x32 : 0x30;
    if (member.link) header.write(member.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeOctal(header, 148, 8, header.reduce((sum, value) => sum + value, 0));
    blocks.push(header, body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, '0');
  buffer.write(`${encoded}\0 `, offset, length, 'ascii');
}
