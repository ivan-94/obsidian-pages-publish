import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSiteConfigFromDirectory,
  saveSiteConfigToDirectory,
} from '../src/config/site-config';

const integrity = `sha512-${Buffer.alloc(64, 11).toString('base64')}`;
const localArtifact = Buffer.from('local-theme-tgz-fixture');
const localIntegrity = `sha512-${createHash('sha512').update(localArtifact).digest('base64')}`;

function configSource(themeLines: string[] = []): string {
  return [
    'version: 1',
    'site:',
    '  name: Theme Wiki',
    '  home_layout: sections',
    '  timezone: Asia/Shanghai',
    ...themeLines,
    'content_roots:',
    '  - path: notes',
    '    public_root: /notes',
    'assets:',
    '  exclude: []',
    'features:',
    '  search: true',
    '  graph: true',
    'cloudflare:',
    '  project_name: theme-wiki',
    '',
  ].join('\n');
}

describe('site theme configuration', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  async function createVault(source: string): Promise<string> {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-theme-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), source, 'utf8');
    return vault;
  }

  it('keeps existing Vaults on the default Quartz theme when site.theme is absent', async () => {
    const vault = await createVault(configSource());

    const loaded = await loadSiteConfigFromDirectory(vault);

    expect(loaded).toMatchObject({
      status: 'editable',
      config: { site: { name: 'Theme Wiki' } },
    });
    if (loaded.status !== 'editable') throw new Error('Expected editable config.');
    expect(loaded.config.site.theme).toBeUndefined();
  });

  it('loads and stably serializes a curated built-in theme reference', async () => {
    const vault = await createVault(configSource([
      '  theme:',
      '    source: builtin',
      '    id: tokyo-night',
    ]));
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable config.');

    expect(loaded.config.site.theme).toEqual({
      source: 'builtin',
      id: 'tokyo-night',
    });

    await saveSiteConfigToDirectory(vault, loaded.config, {
      expectedRevision: loaded.revision,
    });
    const saved = await readFile(join(vault, '.publish', 'site.yml'), 'utf8');
    expect(saved).toContain('source: builtin');
    expect(saved).toContain('id: tokyo-night');
  });

  it('loads and stably serializes an exact npm theme reference', async () => {
    const vault = await createVault(configSource([
      '  theme:',
      '    source: npm',
      '    package: "@pages-publish-theme/brutalist"',
      '    version: 1.0.0',
      `    integrity: ${integrity}`,
      '    options:',
      '      zeta: 4',
      '      accent: "#ff4b17"',
      '      nested:',
      '        z: true',
      '        a: first',
    ]));
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable config.');

    expect(loaded.config.site.theme).toEqual({
      source: 'npm',
      package: '@pages-publish-theme/brutalist',
      version: '1.0.0',
      integrity,
      options: {
        accent: '#ff4b17',
        nested: { a: 'first', z: true },
        zeta: 4,
      },
    });

    await saveSiteConfigToDirectory(vault, loaded.config, {
      expectedRevision: loaded.revision,
    });
    const saved = await readFile(join(vault, '.publish', 'site.yml'), 'utf8');
    expect(saved.indexOf('accent:')).toBeLessThan(saved.indexOf('nested:'));
    expect(saved.indexOf('nested:')).toBeLessThan(saved.indexOf('zeta:'));
    expect(saved).toContain('package: "@pages-publish-theme/brutalist"');
  });

  it('loads a Vault-portable local tgz reference', async () => {
    const vault = await createVault(configSource([
      '  theme:',
      '    source: local',
      '    artifact: .publish/themes/brutalist-1.0.0.tgz',
      `    integrity: ${localIntegrity}`,
    ]));
    await mkdir(join(vault, '.publish', 'themes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'themes', 'brutalist-1.0.0.tgz'),
      localArtifact,
    );

    const loaded = await loadSiteConfigFromDirectory(vault);

    expect(loaded).toMatchObject({
      status: 'editable',
      config: {
        site: {
          theme: {
            source: 'local',
            artifact: '.publish/themes/brutalist-1.0.0.tgz',
            integrity: localIntegrity,
            options: {},
          },
        },
      },
    });
  });

  it('blocks missing and integrity-drifted local artifacts', async () => {
    const vault = await createVault(configSource([
      '  theme:',
      '    source: local',
      '    artifact: .publish/themes/brutalist-1.0.0.tgz',
      `    integrity: ${localIntegrity}`,
    ]));

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'theme-artifact-missing', path: 'site.theme.artifact' }],
    });
    await mkdir(join(vault, '.publish', 'themes'));
    await writeFile(
      join(vault, '.publish', 'themes', 'brutalist-1.0.0.tgz'),
      'changed',
    );
    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{
        code: 'theme-artifact-integrity-drift',
        path: 'site.theme.integrity',
      }],
    });
  });

  it.each([
    {
      name: 'unknown built-in theme',
      theme: [
        '  theme:',
        '    source: builtin',
        '    id: unreviewed-theme',
      ],
      code: 'unknown-builtin-theme',
      path: 'site.theme.id',
    },
    {
      name: 'version range',
      theme: [
        '  theme:',
        '    source: npm',
        '    package: brutalist',
        '    version: ^1.0.0',
        `    integrity: ${integrity}`,
      ],
      code: 'invalid-exact-version',
      path: 'site.theme.version',
    },
    {
      name: 'short integrity',
      theme: [
        '  theme:',
        '    source: npm',
        '    package: brutalist',
        '    version: 1.0.0',
        '    integrity: sha512-YWJjZA==',
      ],
      code: 'invalid-integrity',
      path: 'site.theme.integrity',
    },
    {
      name: 'artifact traversal',
      theme: [
        '  theme:',
        '    source: local',
        '    artifact: .publish/themes/../../private.tgz',
        `    integrity: ${integrity}`,
      ],
      code: 'unsafe-theme-artifact',
      path: 'site.theme.artifact',
    },
    {
      name: 'unknown field',
      theme: [
        '  theme:',
        '    source: npm',
        '    package: brutalist',
        '    version: 1.0.0',
        `    integrity: ${integrity}`,
        '    registry: https://registry.example.com',
      ],
      code: 'unknown-theme-field',
      path: 'site.theme.registry',
    },
  ])('rejects $name', async ({ theme, code, path }) => {
    const vault = await createVault(configSource(theme));

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code, path }],
    });
  });
});
