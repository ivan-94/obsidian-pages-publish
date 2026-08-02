import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSiteConfigFromDirectory } from '../src/config/site-config';
import {
  SiteConfigEditorSession,
  SiteSettingsService,
} from '../src/config/site-settings';
import {
  commitArticleIntentEditToDirectory,
  readArticleMetadataFromDirectory,
  type PreparedArticleIntentEdit,
} from '../src/publication/article-metadata';

describe('site settings service', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('rescans only after the validated config has been saved', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Before',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.site.name = 'After';
    const scan = vi.fn(async () => {
      const current = await loadSiteConfigFromDirectory(vault);
      return { current };
    });
    const service = new SiteSettingsService(vault, { scan });

    const result = await service.save(draft, loaded.revision);

    expect(scan).toHaveBeenCalledOnce();
    expect(result.scan.current).toMatchObject({
      config: { site: { name: 'After' } },
    });
  });

  it('provides the latest editor draft at save time instead of the opening snapshot', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Before',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const session = await SiteConfigEditorSession.open(vault);
    const openingState = session.getState();
    session.update((draft) => {
      draft.site.name = 'Latest draft';
    });

    const saveInput = session.getSaveInput();

    expect(openingState.draft.site.name).toBe('Before');
    expect(saveInput.draft.site.name).toBe('Latest draft');
    expect(saveInput.expectedRevision).toBe(openingState.revision);
  });

  it('keeps a dirty draft and exposes reload/compare state after an external edit', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    const configPath = join(vault, '.publish', 'site.yml');
    const source = (name: string) =>
      [
        'version: 1',
        'site:',
        `  name: ${name}`,
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n');
    await writeFile(configPath, source('Original'), 'utf8');
    const session = await SiteConfigEditorSession.open(vault);
    session.update((draft) => {
      draft.site.name = 'Local draft';
    });
    await writeFile(configPath, source('External edit'), 'utf8');

    const conflicted = await session.detectExternalChange();

    expect(conflicted).toMatchObject({
      status: 'conflict',
      canSave: false,
      draft: { site: { name: 'Local draft' } },
    });
    expect(conflicted.comparison?.currentSource).toContain('name: External edit');
    const reloaded = await session.reloadExternal();
    expect(reloaded).toMatchObject({
      status: 'clean',
      canSave: true,
      draft: { site: { name: 'External edit' } },
    });
  });

  it('keeps a dirty draft when the externally edited source is malformed', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    const configPath = join(vault, '.publish', 'site.yml');
    await writeFile(
      configPath,
      [
        'version: 1',
        'site:',
        '  name: Original',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const session = await SiteConfigEditorSession.open(vault);
    session.update((draft) => {
      draft.site.name = 'Local draft';
    });
    await writeFile(configPath, 'version: 1\nsite: [broken\n', 'utf8');

    const conflicted = await session.detectExternalChange();

    expect(conflicted).toMatchObject({
      status: 'conflict',
      canSave: false,
      draft: { site: { name: 'Local draft' } },
    });
    expect(conflicted.comparison?.currentSource).toBe(
      'version: 1\nsite: [broken\n',
    );
    await expect(session.reloadExternal()).rejects.toThrow();
    expect(session.getState()).toMatchObject({
      status: 'conflict',
      draft: { site: { name: 'Local draft' } },
    });
  });

  it('keeps a dirty draft when the external config is deleted', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    const configPath = join(vault, '.publish', 'site.yml');
    await writeFile(
      configPath,
      [
        'version: 1',
        'site:',
        '  name: Original',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const session = await SiteConfigEditorSession.open(vault);
    session.update((draft) => {
      draft.site.name = 'Local draft';
    });
    await unlink(configPath);

    const conflicted = await session.detectExternalChange();

    expect(conflicted).toMatchObject({
      status: 'conflict',
      canSave: false,
      draft: { site: { name: 'Local draft' } },
      comparison: { currentSource: '' },
    });
    await expect(session.reloadExternal()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.getState().draft.site.name).toBe('Local draft');
  });

  it('previews public-root URL impact and preserves deployed URLs before saving the config', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Moving Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /old',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: moving-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guide.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '  redirects: [/old/guide, /old/%67uide/]',
        '  deployment:',
        '    url: /old/guide/',
        '---',
        '# Guide',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.contentRoots[0]!.publicRoot = '/new';
    const scan = vi.fn(async () => 'scanned');
    const service = new SiteSettingsService(vault, { scan });

    await expect(service.previewUrlChanges(draft)).resolves.toEqual([
      {
        sourcePath: 'notes/guide.md',
        onlineUrl: '/old/guide/',
        pendingUrl: '/new/guide/',
      },
    ]);
    const result = await service.save(draft, loaded.revision);

    expect(result.urlChanges).toHaveLength(1);
    expect(scan).toHaveBeenCalledOnce();
    const article = await readFile(join(vault, 'notes', 'guide.md'), 'utf8');
    expect(article).toContain('redirects:\n    - /old/guide/');
    await expect(
      readArticleMetadataFromDirectory(vault, 'notes/guide.md'),
    ).resolves.toMatchObject({
      redirects: { value: ['/old/guide/'] },
    });
    const savedConfig = await loadSiteConfigFromDirectory(vault);
    expect(savedConfig).toMatchObject({
      status: 'editable',
      config: { contentRoots: [{ path: 'notes', publicRoot: '/new' }] },
    });
  });

  it('previews deployed pages that become takedowns when a content root is removed', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await mkdir(join(vault, 'guide'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Removal Wiki',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      '  - path: guide',
      '    public_root: /guide',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: removal-wiki',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(vault, 'notes', 'keep.md'), '# Keep\n', 'utf8');
    await writeFile(join(vault, 'guide', 'online.md'), [
      '---',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    url: /guide/online/',
      '---',
      '# Online',
      '',
    ].join('\n'), 'utf8');
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.contentRoots.splice(1, 1);
    const service = new SiteSettingsService(vault);

    await expect(service.previewTakedowns(draft)).resolves.toEqual([{
      sourcePath: 'guide/online.md',
      onlineUrl: '/guide/online/',
    }]);
  });

  it('rolls back every article when a multi-article URL migration fails midway', async () => {
    const fixture = await createMovingRootFixture(vaults);
    let commitCount = 0;
    const commitArticleIntent = vi.fn(
      async (vaultRoot: string, prepared: PreparedArticleIntentEdit) => {
      commitCount += 1;
      if (commitCount === 2) throw new Error('second article failed');
      return commitArticleIntentEditToDirectory(vaultRoot, prepared);
      },
    );
    const service = new SiteSettingsService(fixture.vault, {
      scan: async () => 'scanned',
      commitArticleIntent,
    });

    await expect(
      service.save(fixture.draft, fixture.loaded.revision),
    ).rejects.toThrow('second article failed');

    await expect(readFile(fixture.configPath, 'utf8')).resolves.toBe(
      fixture.configSource,
    );
    for (const [path, source] of fixture.articleSources) {
      await expect(readFile(path, 'utf8')).resolves.toBe(source);
    }
  });

  it('rolls back article redirects while preserving a late external config write', async () => {
    const fixture = await createMovingRootFixture(vaults);
    const externalSource = fixture.configSource.replace(
      'name: Moving Wiki',
      'name: External Winner',
    );
    const service = new SiteSettingsService(fixture.vault, {
      scan: async () => 'scanned',
      afterArticleCommits: async () => {
        await writeFile(fixture.configPath, externalSource, 'utf8');
      },
    });

    await expect(
      service.save(fixture.draft, fixture.loaded.revision),
    ).rejects.toThrow();

    await expect(readFile(fixture.configPath, 'utf8')).resolves.toBe(
      externalSource,
    );
    for (const [path, source] of fixture.articleSources) {
      await expect(readFile(path, 'utf8')).resolves.toBe(source);
    }
  });

  it('never restores an article snapshot older than the source used by the forward edit', async () => {
    const fixture = await createMovingRootFixture(vaults);
    const [articlePath, originalSource] = fixture.articleSources.entries().next()
      .value as [string, string];
    const externalSource = `${originalSource}\nExternal edit\n`;
    let changed = false;
    const service = new SiteSettingsService(fixture.vault, {
      scan: async () => 'scanned',
      afterMigrationSnapshot: async () => {
        if (changed) return;
        changed = true;
        await writeFile(articlePath, externalSource, 'utf8');
      },
    });

    await expect(
      service.save(fixture.draft, fixture.loaded.revision),
    ).rejects.toThrow('Article changed while preparing URL migration');

    await expect(readFile(fixture.configPath, 'utf8')).resolves.toBe(
      fixture.configSource,
    );
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(externalSource);
  });

  it('does not confirm a config change when an article changes after redirect migration', async () => {
    const fixture = await createMovingRootFixture(vaults);
    const [articlePath, originalSource] = fixture.articleSources.entries().next()
      .value as [string, string];
    const externalSource = `${originalSource}\nExternal winner after migration\n`;
    const service = new SiteSettingsService(fixture.vault, {
      scan: async () => 'scanned',
      afterArticleCommits: async () => {
        await writeFile(articlePath, externalSource, 'utf8');
      },
    });

    await expect(
      service.save(fixture.draft, fixture.loaded.revision),
    ).rejects.toThrow('rollback was incomplete');

    await expect(readFile(fixture.configPath, 'utf8')).resolves.toBe(
      fixture.configSource,
    );
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(externalSource);
  });

  it('validates automatically proposed redirects against next-version page routes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await mkdir(join(vault, 'occupied'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Redirect Collision',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /old',
        '  - path: occupied',
        '    public_root: /occupied',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: redirect-collision',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'a.md'),
      '---\npublication:\n  visibility: public\n  deployment:\n    url: /old/a/\n---\n# A\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'occupied', 'b.md'),
      '---\npublication:\n  visibility: public\n  slug: a\n---\n# B\n',
      'utf8',
    );
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.contentRoots[0]!.publicRoot = '/new';
    draft.contentRoots[1]!.publicRoot = '/old';
    const service = new SiteSettingsService(vault);

    await expect(service.previewUrlChanges(draft)).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'redirect-route-conflict' })],
    });
  });

  it('includes a newly added content root in pre-save route validation', async () => {
    const fixture = await createMovingRootFixture(vaults);
    await mkdir(join(fixture.vault, 'newdocs'), { recursive: true });
    const source =
      '---\npublication:\n  visibility: public\n  slug: same\n---\n# Same\n';
    await writeFile(join(fixture.vault, 'newdocs', 'one.md'), source, 'utf8');
    await writeFile(join(fixture.vault, 'newdocs', 'two.md'), source, 'utf8');
    fixture.draft.contentRoots.push({
      path: 'newdocs',
      publicRoot: '/docs',
    });
    const service = new SiteSettingsService(fixture.vault);

    await expect(service.previewUrlChanges(fixture.draft)).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'route-conflict' })],
    });
  });
});

async function createMovingRootFixture(vaults: string[]): Promise<{
  vault: string;
  configPath: string;
  configSource: string;
  loaded: Extract<Awaited<ReturnType<typeof loadSiteConfigFromDirectory>>, { status: 'editable' }>;
  draft: Extract<Awaited<ReturnType<typeof loadSiteConfigFromDirectory>>, { status: 'editable' }>['config'];
  articleSources: Map<string, string>;
}> {
  const vault = await mkdtemp(join(tmpdir(), 'pages-publish-settings-'));
  vaults.push(vault);
  await mkdir(join(vault, '.publish'), { recursive: true });
  await mkdir(join(vault, 'notes'), { recursive: true });
  const configPath = join(vault, '.publish', 'site.yml');
  const configSource = [
    'version: 1',
    'site:',
    '  name: Moving Wiki',
    '  home_layout: sections',
    'content_roots:',
    '  - path: notes',
    '    public_root: /old',
    'assets:',
    '  exclude: []',
    'features:',
    '  search: false',
    '  graph: false',
    'cloudflare:',
    '  project_name: moving-wiki',
    '',
  ].join('\n');
  await writeFile(configPath, configSource, 'utf8');
  const articleSources = new Map<string, string>();
  for (const name of ['one', 'two']) {
    const path = join(vault, 'notes', `${name}.md`);
    const source =
      name === 'one'
        ? '\uFEFF---\r\npublication: { visibility: public, deployment: { url: /old/one/ } } # keep\r\ncustom:  value\r\n---\r\n# one\r\n'
        : [
            '---',
            'publication:',
            '  visibility: public',
            '  deployment:',
            `    url: /old/${name}/`,
            '---',
            `# ${name}`,
            '',
          ].join('\n');
    await writeFile(path, source, 'utf8');
    articleSources.set(path, source);
  }
  const loaded = await loadSiteConfigFromDirectory(vault);
  if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
  const draft = structuredClone(loaded.config);
  draft.contentRoots[0]!.publicRoot = '/new';
  return {
    vault,
    configPath,
    configSource,
    loaded,
    draft,
    articleSources,
  };
}
