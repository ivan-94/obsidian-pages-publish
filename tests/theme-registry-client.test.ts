import { describe, expect, it, vi } from 'vitest';
import { ThemeRegistryClient } from '../src/theme/theme-registry-client';
import {
  sha512Integrity,
  themePackageArchive,
} from './support/theme-package-fixture';

describe('exact npm theme registry client', () => {
  it('downloads only exact metadata and an integrity-identified official tarball', async () => {
    const archive = themePackageArchive();
    const integrity = sha512Integrity(archive);
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/1.0.0')) {
        return new Response(JSON.stringify({
          name: '@pages-publish-theme/brutalist',
          version: '1.0.0',
          _npmUser: { name: 'publisher', email: 'publisher@example.com' },
          dist: {
            integrity,
            tarball: 'https://registry.npmjs.org/@pages-publish-theme/brutalist/-/brutalist-1.0.0.tgz',
          },
        }), { status: 200 });
      }
      return new Response(Buffer.from(archive), {
        status: 200,
        headers: { 'content-length': String(archive.byteLength) },
      });
    });
    const client = new ThemeRegistryClient(fetchImplementation);

    await expect(client.downloadExact(
      '@pages-publish-theme/brutalist',
      '1.0.0',
    )).resolves.toMatchObject({
      packageName: '@pages-publish-theme/brutalist',
      version: '1.0.0',
      integrity,
      publisher: { name: 'publisher', email: 'publisher@example.com' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchImplementation.mock.calls[0]?.[0])).toContain(
      '%40pages-publish-theme%2Fbrutalist/1.0.0',
    );
  });

  it('rejects version ranges and untrusted tarball origins before download', async () => {
    const client = new ThemeRegistryClient(vi.fn<typeof fetch>());
    await expect(client.downloadExact('brutalist', '^1.0.0')).rejects.toThrow(
      /exact semantic version/,
    );

    const archive = themePackageArchive({ name: 'brutalist' });
    const untrusted = new ThemeRegistryClient(vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        name: 'brutalist',
        version: '1.0.0',
        dist: {
          integrity: sha512Integrity(archive),
          tarball: 'https://evil.example/theme.tgz',
        },
      }), { status: 200 })));
    await expect(untrusted.downloadExact('brutalist', '1.0.0')).rejects.toMatchObject({
      code: 'theme-registry-tarball-untrusted',
    });
  });

  it('does not turn cancellation into a registry failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new ThemeRegistryClient(fetch);

    await expect(client.downloadExact('brutalist', '1.0.0', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
