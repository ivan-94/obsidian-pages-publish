import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { ThemeInstaller } from '../src/theme/theme-installer';
import { ThemeManagementService } from '../src/theme/theme-management';
import { ThemeRegistryClient } from '../src/theme/theme-registry-client';
import { ThemeStore } from '../src/theme/theme-store';
import { ThemeTrustStore } from '../src/theme/theme-trust-store';
import { sha512Integrity, themePackageArchive } from './support/theme-package-fixture';

describe('theme management', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('carries informational registry publisher data into the trust candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-theme-management-'));
    const vault = await mkdtemp(join(tmpdir(), 'pages-theme-vault-'));
    roots.push(root, vault);
    const archive = themePackageArchive();
    const store = new ThemeStore({ rootDirectory: root, smoke: async () => undefined });
    let request = 0;
    const fetcher = async (): Promise<Response> => {
      request += 1;
      return request === 1
        ? new Response(JSON.stringify({
          name: '@pages-publish-theme/brutalist',
          version: '1.0.0',
          _npmUser: { name: 'Theme Author', email: 'author@example.com' },
          dist: {
            integrity: sha512Integrity(archive),
            tarball: 'https://registry.npmjs.org/theme/-/theme-1.0.0.tgz',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(Uint8Array.from(archive).buffer, { status: 200 });
    };
    const service = new ThemeManagementService(
      vault,
      store,
      new ThemeInstaller(store, new ThemeRegistryClient(fetcher)),
      new ThemeTrustStore(join(root, 'trust.json')),
      async () => ({ quartzVersion: '5.0.0' }) as ReadyQuartzEngine,
    );

    const candidate = await service.installNpm('@pages-publish-theme/brutalist', '1.0.0');

    expect(candidate.publisher).toEqual({
      name: 'Theme Author',
      email: 'author@example.com',
    });
    const panel = await service.panelState(candidate.reference);
    expect(panel.configured?.publisher).toEqual(candidate.publisher);
  });
});
