import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCurrentArticlePanelFromDirectory } from '../src/publication/current-article-panel';

describe('current article panel state', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('follows the active article until a different article is pinned', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'active.md'),
      '---\npublication:\n  visibility: public\n---\n# Active\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'pinned.md'),
      '# Pinned\n',
      'utf8',
    );

    const active = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/active.md',
    });
    const pinned = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/active.md',
      pinnedPath: 'notes/pinned.md',
    });

    expect(active).toMatchObject({
      status: 'article',
      selection: 'active',
      sourcePath: 'notes/active.md',
      publicationState: 'pending-first-publish',
      metadata: {
        visibility: { value: 'public', source: 'publication.visibility' },
      },
    });
    expect(pinned).toMatchObject({
      status: 'article',
      selection: 'pinned',
      sourcePath: 'notes/pinned.md',
      publicationState: 'private',
      metadata: {
        visibility: { value: 'private', source: 'default' },
      },
    });
  });

  it('projects no-active, non-Markdown, out-of-scope, config-error, and missing-pinned states', async () => {
    const vault = await createConfiguredVault(vaults);
    await mkdir(join(vault, 'private'), { recursive: true });
    await writeFile(join(vault, 'private', 'outside.md'), '# Outside\n', 'utf8');

    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {}),
    ).resolves.toEqual({ status: 'no-active' });
    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {
        activePath: 'notes/board.canvas',
      }),
    ).resolves.toEqual({
      status: 'non-markdown',
      selection: 'active',
      sourcePath: 'notes/board.canvas',
    });
    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {
        activePath: 'private/outside.md',
      }),
    ).resolves.toEqual({
      status: 'out-of-scope',
      selection: 'active',
      sourcePath: 'private/outside.md',
    });
    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {
        pinnedPath: 'notes/removed.md',
      }),
    ).resolves.toEqual({
      status: 'missing-pinned',
      sourcePath: 'notes/removed.md',
    });

    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite: [invalid]\n',
      'utf8',
    );
    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {
        activePath: 'notes/active.md',
      }),
    ).resolves.toMatchObject({
      status: 'config-error',
      sourcePath: 'notes/active.md',
    });
  });

  it('exposes a lossless legacy migration plan to the current article surface', async () => {
    const vault = await createConfiguredVault(vaults);
    const source = '---\npublish: true\nowner: Ivan\n---\n# Legacy\n';
    await writeFile(join(vault, 'notes', 'legacy.md'), source, 'utf8');

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/legacy.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      legacyMigration: {
        legacyFields: [{ path: 'publish', value: true }],
        next: {
          visibility: { value: 'public', source: 'publication.visibility' },
        },
      },
    });
  });

  it('projects an unconfigured Vault as a no-site setup state', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-panel-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, 'notes', 'draft.md'), '# Draft\n', 'utf8');

    await expect(
      resolveCurrentArticlePanelFromDirectory(vault, {
        activePath: 'notes/draft.md',
      }),
    ).resolves.toEqual({
      status: 'no-site',
      sourcePath: 'notes/draft.md',
    });
  });
});

async function createConfiguredVault(vaults: string[]): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'pages-publish-panel-'));
  vaults.push(vault);
  await mkdir(join(vault, '.publish'), { recursive: true });
  await mkdir(join(vault, 'notes'), { recursive: true });
  await writeFile(
    join(vault, '.publish', 'site.yml'),
    [
      'version: 1',
      'site:',
      '  name: Panel Test',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: panel-test',
      '',
    ].join('\n'),
    'utf8',
  );
  return vault;
}
