import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface ThemePackageFixtureOptions {
  name?: string;
  version?: string;
  quartzVersion?: string;
  capabilities?: string[];
  entrySource?: string;
  optionsSchema?: unknown;
  extraFiles?: Record<string, string>;
  mutateManifest?: (manifest: Record<string, unknown>) => void;
}

export function themePackageArchive(
  options: ThemePackageFixtureOptions = {},
): Uint8Array {
  const name = options.name ?? '@pages-publish-theme/brutalist';
  const version = options.version ?? '1.0.0';
  const capabilities = options.capabilities ?? ['styles', 'layout', 'components'];
  const manifest: Record<string, unknown> = {
    name,
    version,
    type: 'module',
    exports: { '.': './dist/index.js' },
    peerDependencies: { '@pages-publish/theme-sdk': '1.x' },
    pagesPublishTheme: {
      apiVersion: 1,
      displayName: 'Brutalist UI',
      quartzVersion: options.quartzVersion ?? '5.0.0',
      entry: './dist/index.js',
      capabilities,
      ...(options.optionsSchema === undefined
        ? {}
        : { optionsSchema: './dist/options.schema.json' }),
    },
  };
  options.mutateManifest?.(manifest);
  const files: Record<string, string> = {
    'package/package.json': JSON.stringify(manifest),
    'package/dist/index.js': options.entrySource ?? 'export default { styles: ["./dist/theme.css"] }',
    'package/dist/theme.css': ':root { --accent: #ff4b17; }',
    ...(options.optionsSchema === undefined
      ? {}
      : { 'package/dist/options.schema.json': JSON.stringify(options.optionsSchema) }),
    ...options.extraFiles,
  };
  return tarGz([
    { name: 'package/', type: 'directory' },
    { name: 'package/dist/', type: 'directory' },
    ...Object.entries(files).map(([name, body]) => ({ name, body })),
  ]);
}

export function sha512Integrity(content: Uint8Array): string {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`;
}

interface TarMember {
  name: string;
  body?: string;
  type?: 'file' | 'directory' | 'symlink';
  link?: string;
}

export function tarGz(members: TarMember[]): Uint8Array {
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
    const padding = (512 - body.length % 512) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  buffer.write(
    `${value.toString(8).padStart(length - 2, '0')}\0 `,
    offset,
    length,
    'ascii',
  );
}
