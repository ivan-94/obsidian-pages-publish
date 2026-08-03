import {
  assertExactThemeVersion,
  assertThemeIntegrity,
  assertThemePackageName,
} from './theme-contract';

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_THEME_ARCHIVE_BYTES = 16 * 1024 * 1024;

export interface RegistryThemeArtifact {
  packageName: string;
  version: string;
  integrity: string;
  tarballUrl: string;
  archive: Uint8Array;
  publisher?: {
    name?: string;
    email?: string;
  };
}

export class ThemeRegistryError extends Error {
  readonly name = 'ThemeRegistryError';

  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class ThemeRegistryClient {
  constructor(
    private readonly fetchImplementation: typeof fetch,
    private readonly maxArchiveBytes = MAX_THEME_ARCHIVE_BYTES,
  ) {}

  async downloadExact(
    packageName: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<RegistryThemeArtifact> {
    assertThemePackageName(packageName, 'package');
    assertExactThemeVersion(version, 'version');
    const metadataUrl = `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
    let response: Response;
    try {
      response = await this.fetchImplementation(metadataUrl, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      rethrowAbort(error);
      throw new ThemeRegistryError(
        'theme-registry-metadata-failed',
        `Could not read exact registry metadata for ${packageName}@${version}.`,
        error,
      );
    }
    if (!response.ok) {
      throw new ThemeRegistryError(
        'theme-registry-metadata-failed',
        `Registry metadata request failed with HTTP ${response.status}.`,
      );
    }
    const metadata = await boundedJson(response, 1024 * 1024);
    const record = asRecord(metadata, 'Registry metadata must be an object.');
    if (record.name !== packageName || record.version !== version) {
      throw new ThemeRegistryError(
        'theme-registry-identity-mismatch',
        'Registry metadata did not match the requested exact package identity.',
      );
    }
    const dist = asRecord(record.dist, 'Registry metadata did not include dist.');
    if (typeof dist.integrity !== 'string') {
      throw new ThemeRegistryError(
        'theme-registry-integrity-missing',
        'Registry metadata did not include sha512 integrity.',
      );
    }
    assertThemeIntegrity(dist.integrity, 'dist.integrity');
    if (typeof dist.tarball !== 'string') {
      throw new ThemeRegistryError(
        'theme-registry-tarball-missing',
        'Registry metadata did not include a tarball URL.',
      );
    }
    const tarballUrl = trustedRegistryUrl(dist.tarball);
    let tarballResponse: Response;
    try {
      tarballResponse = await this.fetchImplementation(tarballUrl, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { accept: 'application/octet-stream' },
      });
    } catch (error) {
      rethrowAbort(error);
      throw new ThemeRegistryError(
        'theme-registry-download-failed',
        `Could not download ${packageName}@${version}.`,
        error,
      );
    }
    if (!tarballResponse.ok) {
      throw new ThemeRegistryError(
        'theme-registry-download-failed',
        `Theme tarball request failed with HTTP ${tarballResponse.status}.`,
      );
    }
    const archive = await boundedBytes(tarballResponse, this.maxArchiveBytes);
    const publisher = optionalPublisher(record._npmUser);
    return {
      packageName,
      version,
      integrity: dist.integrity,
      tarballUrl,
      archive,
      ...(publisher === undefined ? {} : { publisher }),
    };
  }
}

function trustedRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ThemeRegistryError(
      'theme-registry-tarball-untrusted',
      'Registry tarball URL is invalid.',
      error,
    );
  }
  if (
    url.origin !== REGISTRY_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ThemeRegistryError(
      'theme-registry-tarball-untrusted',
      'Registry tarball URL must stay on the official npm registry origin.',
    );
  }
  return url.href;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await boundedBytes(response, limit);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new ThemeRegistryError(
      'theme-registry-metadata-invalid',
      'Registry metadata was not valid JSON.',
      error,
    );
  }
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      throw new ThemeRegistryError(
        'theme-registry-response-too-large',
        'Registry response exceeded the theme size limit.',
      );
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    throw new ThemeRegistryError(
      'theme-registry-response-too-large',
      'Registry response exceeded the theme size limit.',
    );
  }
  return bytes;
}

function optionalPublisher(value: unknown): RegistryThemeArtifact['publisher'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const publisher = value as Record<string, unknown>;
  const name = typeof publisher.name === 'string' ? publisher.name : undefined;
  const email = typeof publisher.email === 'string' ? publisher.email : undefined;
  return name === undefined && email === undefined ? undefined : { name, email };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ThemeRegistryError('theme-registry-metadata-invalid', message);
  }
  return value as Record<string, unknown>;
}

function rethrowAbort(error: unknown): void {
  if (
    error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && error.name === 'AbortError'
  ) {
    throw error;
  }
}
