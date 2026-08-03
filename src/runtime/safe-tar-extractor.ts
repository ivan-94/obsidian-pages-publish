import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const tarBlockSize = 512;
const defaultCompressedLimit = 64 * 1024 * 1024;
const defaultExpandedLimit = 256 * 1024 * 1024;

export interface TrustedTarLimits {
  maxCompressedBytes?: number;
  maxExpandedBytes?: number;
}

export class UnsafeArchiveError extends Error {
  readonly name = 'UnsafeArchiveError';
  readonly code = 'quartz-engine-integrity-failed';
}

export async function extractTrustedTarGz(
  archive: Uint8Array,
  destination: string,
  limits: TrustedTarLimits = {},
): Promise<void> {
  const compressedLimit = limits.maxCompressedBytes ?? defaultCompressedLimit;
  const expandedLimit = limits.maxExpandedBytes ?? defaultExpandedLimit;
  if (archive.byteLength === 0 || archive.byteLength > compressedLimit) {
    throw unsafe('The Quartz source archive exceeds its trusted size limit.');
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: expandedLimit });
  } catch {
    throw unsafe('The Quartz source archive is not a valid bounded gzip stream.');
  }

  const destinationRoot = resolve(destination);
  await mkdir(destinationRoot, { recursive: true });
  let offset = 0;
  let archiveRoot: string | undefined;
  let localPax: Record<string, string> | undefined;
  let globalPax: Record<string, string> = {};
  let longPath: string | undefined;

  while (offset + tarBlockSize <= tar.length) {
    const header = tar.subarray(offset, offset + tarBlockSize);
    offset += tarBlockSize;
    if (header.every((byte) => byte === 0)) break;
    verifyHeaderChecksum(header);

    const size = readTarNumber(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) {
      throw unsafe('The Quartz source archive contains an invalid member size.');
    }
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / tarBlockSize) * tarBlockSize;
    const type = String.fromCharCode(header[156] ?? 0);
    const headerPath = readHeaderPath(header);
    validateMemberPath(headerPath);

    if (type === 'x' || type === 'g') {
      const values = parsePax(body);
      if (type === 'x') localPax = values;
      else globalPax = { ...globalPax, ...values };
      continue;
    }
    if (type === 'L') {
      longPath = readNullTerminated(body);
      validateMemberPath(longPath);
      continue;
    }

    const pax = { ...globalPax, ...localPax };
    localPax = undefined;
    const memberPath = pax.path ?? longPath ?? headerPath;
    longPath = undefined;
    validateMemberPath(memberPath);
    if (pax.linkpath !== undefined) {
      throw unsafe(`The Quartz source archive contains an unsafe member: ${memberPath}`);
    }
    if (type !== '\0' && type !== '0' && type !== '5') {
      throw unsafe(`The Quartz source archive contains an unsafe member: ${memberPath}`);
    }

    const parts = memberPath.replace(/\/$/u, '').split('/');
    const currentRoot = parts[0];
    if (archiveRoot === undefined) archiveRoot = currentRoot;
    if (currentRoot !== archiveRoot) {
      throw unsafe('The Quartz source archive must have exactly one root directory.');
    }
    const relativeParts = parts.slice(1);
    if (relativeParts.length === 0) {
      if (type !== '5') {
        throw unsafe('The Quartz source archive root must be a directory.');
      }
      continue;
    }

    const target = resolve(destinationRoot, ...relativeParts);
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${sep}`)) {
      throw unsafe(`The Quartz source archive contains an unsafe member: ${memberPath}`);
    }
    if (type === '5') {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    try {
      await writeFile(target, body, { flag: 'wx', mode: 0o644 });
    } catch {
      throw unsafe(`The Quartz source archive contains a conflicting member: ${memberPath}`);
    }
  }

  if (archiveRoot === undefined) {
    throw unsafe('The Quartz source archive did not contain an engine root.');
  }
}

function validateMemberPath(path: string): void {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw unsafe(`The Quartz source archive contains an unsafe member: ${path}`);
  }
  const parts = path.replace(/\/$/u, '').split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw unsafe(`The Quartz source archive contains an unsafe member: ${path}`);
  }
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = readTarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
  }
  if (actual !== expected) {
    throw unsafe('The Quartz source archive contains a corrupt tar header.');
  }
}

function readHeaderPath(header: Buffer): string {
  const name = readNullTerminated(header.subarray(0, 100));
  const prefix = readNullTerminated(header.subarray(345, 500));
  return prefix.length === 0 ? name : `${prefix}/${name}`;
}

function readTarNumber(buffer: Buffer, offset: number, length: number): number {
  const raw = readNullTerminated(buffer.subarray(offset, offset + length)).trim();
  if (!/^[0-7]+$/u.test(raw)) return Number.NaN;
  return Number.parseInt(raw, 8);
}

function readNullTerminated(buffer: Uint8Array): string {
  const end = buffer.indexOf(0);
  return Buffer.from(end === -1 ? buffer : buffer.subarray(0, end)).toString('utf8');
}

function parsePax(body: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw unsafe('The Quartz source archive contains invalid PAX metadata.');
    const length = Number.parseInt(body.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) {
      throw unsafe('The Quartz source archive contains invalid PAX metadata.');
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw unsafe('The Quartz source archive contains invalid PAX metadata.');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function unsafe(message: string): UnsafeArchiveError {
  return new UnsafeArchiveError(message);
}
