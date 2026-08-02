import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveArticlePublicationState,
  resolveCurrentArticlePanelFromDirectory,
} from '../src/publication/current-article-panel';

describe('current article panel state', () => {
  const vaults: string[] = [];

  it('distinguishes synchronized, updated, URL, visibility, blocker, and failed states', () => {
    const synced = {
      visibility: 'public' as const,
      onlineUrl: '/notes/article/',
      pendingUrl: '/notes/article/',
      currentSourceDigest: 'same',
      deployedSourceDigest: 'same',
      deployedVisibility: 'public' as const,
      hasBlocker: false,
    };
    expect(deriveArticlePublicationState(synced)).toBe('synced');
    expect(deriveArticlePublicationState({ ...synced, currentSourceDigest: 'new' }))
      .toBe('updated');
    expect(deriveArticlePublicationState({ ...synced, pendingUrl: '/notes/new/' }))
      .toBe('url-changed');
    expect(deriveArticlePublicationState({ ...synced, visibility: 'unlisted' }))
      .toBe('visibility-changed');
    expect(deriveArticlePublicationState({ ...synced, hasBlocker: true }))
      .toBe('blocked');
    expect(deriveArticlePublicationState({ ...synced, deployedSourceDigest: undefined }))
      .toBe('unknown');
  });

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

  it('does not mistake a retained historical first-publication date for an online deployment', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'offline.md'),
      '---\npublication:\n  visibility: private\n  deployment:\n    first_published_at: 2026-08-01T10:20:30+08:00\n---\n# Offline\n',
      'utf8',
    );

    await expect(resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/offline.md',
    })).resolves.toMatchObject({
      status: 'article',
      publicationState: 'private',
      metadata: {
        deployment: { firstPublishedAt: '2026-08-01T10:20:30+08:00' },
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

  it('keeps an online article visible after it moves outside the configured content roots', async () => {
    const vault = await createConfiguredVault(vaults);
    await mkdir(join(vault, 'guide'), { recursive: true });
    await writeFile(join(vault, 'guide', 'online.md'), [
      '---',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    url: https://panel-test.pages.dev/notes/online/',
      '---',
      '# Online',
      '',
    ].join('\n'), 'utf8');

    await expect(resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'guide/online.md',
    })).resolves.toEqual({
      status: 'out-of-scope-online',
      selection: 'active',
      sourcePath: 'guide/online.md',
      onlineUrl: 'https://panel-test.pages.dev/notes/online/',
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

  it('projects the pending URL, online URL, and flattened redirect result together', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'guide.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '  slug: new',
        '  redirects: [/notes/old/]',
        '  deployment:',
        '    url: /notes/old/',
        '---',
        '# Guide',
        '',
      ].join('\n'),
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/guide.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      route: {
        pendingUrl: '/notes/new/',
        onlineUrl: '/notes/old/',
        redirects: [{ from: '/notes/old/', to: '/notes/new/' }],
        issues: [],
      },
    });
  });

  it('keeps current article facts available when another article has malformed Frontmatter', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'current.md'),
      '---\npublication:\n  visibility: public\n  slug: current\n---\n# Current\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'broken.md'),
      '---\npublication: [\n---\n# Broken\n',
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/current.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      sourcePath: 'notes/current.md',
      metadata: {
        visibility: { value: 'public' },
        slug: { value: 'current' },
      },
      route: {
        pendingUrl: '/notes/current/',
      },
    });
  });

  it('includes blockers owned by an ancestor section in the current article route state', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Panel Test',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /search',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: true',
        '  graph: false',
        'cloudflare:',
        '  project_name: panel-test',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'article.md'),
      '---\npublication:\n  visibility: public\n---\n# Article\n',
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/article.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      route: {
        issues: [
          expect.objectContaining({
            severity: 'blocker',
            code: 'section-system-route-conflict',
            directoryPath: 'notes',
          }),
        ],
      },
    });
  });

  it('does not attach a public section blocker to a private article without a route', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Panel Test',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /search',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: true',
        '  graph: false',
        'cloudflare:',
        '  project_name: panel-test',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'private.md'), '# Private\n', 'utf8');
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public\n',
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/private.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      publicationState: 'private',
      route: { issues: [] },
    });
  });

  it('projects locatable note-reference issues for the current article', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'current.md'),
      '---\npublication:\n  visibility: public\n---\n# Current\n\n[[missing|missing note]]\n',
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/current.md',
    });

    expect(state).toMatchObject({
      status: 'article',
      dependencies: { images: 0, notes: 1, externalLinks: 0 },
      contentIssues: [
        {
          severity: 'warning',
          code: 'missing-note-reference',
          sourcePath: 'notes/current.md',
          line: 7,
          impact: 'The published page will show text instead of a link.',
          dormant: false,
        },
      ],
    });
  });

  it('projects locatable image and raw HTML issues for the current article', async () => {
    const vault = await createConfiguredVault(vaults);
    await writeFile(
      join(vault, 'notes', 'current.md'),
      '---\npublication:\n  visibility: public\n---\n# Current\n\n![missing image](missing.png)\n<script>blocked</script>\n',
      'utf8',
    );

    const state = await resolveCurrentArticlePanelFromDirectory(vault, {
      activePath: 'notes/current.md',
    });

    expect(state.status).toBe('article');
    if (state.status !== 'article') return;
    expect(state.dependencies).toEqual({ images: 1, notes: 0, externalLinks: 0 });
    expect(state.contentIssues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-missing',
        sourcePath: 'notes/current.md',
        line: 7,
        impact: 'The image cannot be included in the next site version.',
        dormant: false,
      }),
    );
    expect(state.contentIssues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'unsafe-raw-html',
        sourcePath: 'notes/current.md',
        line: 8,
        impact: 'Unsafe HTML will be removed from the rendered page.',
        dormant: false,
      }),
    );
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
