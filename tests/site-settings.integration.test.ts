import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSiteConfigFromDirectory } from '../src/config/site-config';
import {
  SiteConfigEditorSession,
  SiteSettingsService,
} from '../src/config/site-settings';

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
});
