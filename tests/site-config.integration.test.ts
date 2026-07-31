import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSiteConfigFromDirectory,
  saveSiteConfigToDirectory,
  SiteConfigConflictError,
  type SiteConfigV1,
} from '../src/config/site-config';

describe('site config repository', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('loads the complete supported v1 schema as a normalized editable config', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  description: 面向开发者的知识库',
        '  home_layout: latest',
        '  timezone: Asia/Shanghai',
        'content_roots:',
        '  - path: notes',
        '    public_root: /articles',
        'assets:',
        '  exclude:',
        '    - private/**',
        'features:',
        '  search: true',
        '  graph: false',
        'cloudflare:',
        '  project_name: llm-wiki',
        '  custom_domain: wiki.example.com',
        '',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadSiteConfigFromDirectory(vault);

    expect(loaded).toMatchObject({
      status: 'editable',
      config: {
        version: 1,
        site: {
          name: 'LLM Wiki',
          description: '面向开发者的知识库',
          homeLayout: 'latest',
          timezone: 'Asia/Shanghai',
        },
        contentRoots: [{ path: 'notes', publicRoot: '/articles' }],
        assets: { exclude: ['private/**'] },
        features: { search: true, graph: false },
        cloudflare: {
          projectName: 'llm-wiki',
          customDomain: 'wiki.example.com',
        },
      },
    });
    expect(loaded.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('locates malformed YAML without exposing parser internals as the contract', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite: [broken\n',
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'invalid-yaml', path: '$', line: 3, column: 1 }],
    });
    await expect(loadSiteConfigFromDirectory(vault)).rejects.toThrow(/line 3/);
  });

  it('locates an optional field with the wrong YAML type', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  description: 42',
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

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'invalid-field-type', path: 'site.description' }],
    });
    await expect(loadSiteConfigFromDirectory(vault)).rejects.toThrow(
      /site\.description/,
    );
  });

  it('locates a missing required schema field', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'invalid-field-type', path: 'features.graph' }],
    });
    await expect(loadSiteConfigFromDirectory(vault)).rejects.toThrow(
      /features\.graph/,
    );
  });

  it('locates a null content root entry instead of leaking a TypeError', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - null',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'invalid-field-type', path: 'content_roots[0]' }],
    });
  });

  it('locates a site description longer than 160 visible characters', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        `  description: ${'文'.repeat(161)}`,
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

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'site-description-too-long',
          path: 'site.description',
        },
      ],
    });
  });

  it('rejects a custom domain that is not a hostname', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '  custom_domain: https://wiki.example.com/path',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'invalid-custom-domain',
          path: 'cloudflare.custom_domain',
        },
      ],
    });
  });

  it('locates an invalid site timezone', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        '  timezone: Moon/Sea-of-Tranquility',
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

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'invalid-site-timezone',
          path: 'site.timezone',
        },
      ],
    });
  });

  it('rejects overlapping content roots and locates the conflicting field', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        '  - path: notes/private',
        '    public_root: /private',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'content-root-overlap',
          path: 'content_roots[1].path',
        },
      ],
    });
  });

  it('rejects duplicate normalized public roots', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /articles',
        '  - path: docs',
        '    public_root: /articles/',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'public-root-conflict',
          path: 'content_roots[1].public_root',
        },
      ],
    });
  });

  it('rejects a content root that traverses outside its declared path', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes/../private',
        '    public_root: /articles',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'unsafe-content-root',
          path: 'content_roots[0].path',
        },
      ],
    });
  });

  it('rejects a public root that is not an absolute URL path', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: ../private',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'unsafe-public-root',
          path: 'content_roots[0].public_root',
        },
      ],
    });
  });

  it('rejects a configured content root symlink that escapes the vault', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    const outside = await mkdtemp(join(tmpdir(), 'pages-publish-outside-'));
    vaults.push(vault, outside);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await symlink(outside, join(vault, 'linked'), 'dir');
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: linked',
        '    public_root: /articles',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'content-root-symlink-escape',
          path: 'content_roots[0].path',
        },
      ],
    });
  });

  it('rejects a configured content root symlink even when it stays inside the vault', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await symlink(join(vault, 'notes'), join(vault, 'linked-notes'), 'dir');
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: linked-notes',
        '    public_root: /articles',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [
        {
          code: 'content-root-symlink',
          path: 'content_roots[0].path',
        },
      ],
    });
  });

  it('rejects a .publish directory symlink without reading or writing outside the Vault', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    const outside = await mkdtemp(join(tmpdir(), 'pages-publish-config-outside-'));
    vaults.push(vault, outside);
    const outsideConfigPath = join(outside, 'site.yml');
    const outsideSource = [
      'version: 1',
      'site:',
      '  name: Outside',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: outside',
      '',
    ].join('\n');
    await writeFile(outsideConfigPath, outsideSource, 'utf8');
    await symlink(outside, join(vault, '.publish'));

    await expect(loadSiteConfigFromDirectory(vault)).rejects.toMatchObject({
      issues: [{ code: 'config-path-symlink', path: '.publish' }],
    });
    const draft: SiteConfigV1 = {
      version: 1,
      site: { name: 'Local', homeLayout: 'sections' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'local' },
    };
    await expect(
      saveSiteConfigToDirectory(vault, draft, { expectedRevision: null }),
    ).rejects.toMatchObject({
      issues: [{ code: 'config-path-symlink', path: '.publish' }],
    });
    await expect(readFile(outsideConfigPath, 'utf8')).resolves.toBe(outsideSource);
  });

  it('atomically saves a validated edit and exposes its new revision', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
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
    const edited = structuredClone(loaded.config);
    edited.site.name = 'After';

    const saved = await saveSiteConfigToDirectory(vault, edited, {
      expectedRevision: loaded.revision,
    });

    expect(saved.revision).not.toBe(loaded.revision);
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      status: 'editable',
      revision: saved.revision,
      config: { site: { name: 'After' } },
    });
  });

  it('keeps the old config and the caller draft when atomic replacement fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
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
    const edited = structuredClone(loaded.config);
    edited.site.name = 'Unsaved draft';

    await expect(
      saveSiteConfigToDirectory(vault, edited, {
        expectedRevision: loaded.revision,
        replaceFile: async () => {
          throw new Error('injected replace failure');
        },
      }),
    ).rejects.toThrow('injected replace failure');

    expect(edited.site.name).toBe('Unsaved draft');
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      config: { site: { name: 'Before' } },
    });
    await expect(readdir(join(vault, '.publish'))).resolves.toEqual(['site.yml']);
  });

  it('blocks a dirty draft from overwriting an external edit and returns comparison data', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
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
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.site.name = 'Local draft';
    await writeFile(configPath, source('External edit'), 'utf8');

    const conflict = await saveSiteConfigToDirectory(vault, draft, {
      expectedRevision: loaded.revision,
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(SiteConfigConflictError);
    if (!(conflict instanceof SiteConfigConflictError)) {
      throw new Error('Expected a config conflict.');
    }
    expect(conflict.expectedRevision).toBe(loaded.revision);
    expect(conflict.currentSource).toContain('name: External edit');
    expect(conflict.draft).toEqual(draft);
    expect(draft.site.name).toBe('Local draft');
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      config: { site: { name: 'External edit' } },
    });
  });

  it('rechecks the revision after preparing the temporary file and before replacement', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
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
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.site.name = 'Local draft';

    await expect(
      saveSiteConfigToDirectory(vault, draft, {
        expectedRevision: loaded.revision,
        beforeReplace: async () => {
          await writeFile(configPath, source('Late external edit'), 'utf8');
        },
      }),
    ).rejects.toBeInstanceOf(SiteConfigConflictError);
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      config: { site: { name: 'Late external edit' } },
    });
    await expect(readdir(join(vault, '.publish'))).resolves.toEqual(['site.yml']);
  });

  it('does not clobber an external edit that arrives after the final revision check', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
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
    const loaded = await loadSiteConfigFromDirectory(vault);
    if (loaded.status !== 'editable') throw new Error('Expected editable fixture.');
    const draft = structuredClone(loaded.config);
    draft.site.name = 'Local draft';

    await expect(
      saveSiteConfigToDirectory(vault, draft, {
        expectedRevision: loaded.revision,
        beforeCommit: async () => {
          await writeFile(configPath, source('Last-moment external edit'), 'utf8');
        },
      }),
    ).rejects.toBeInstanceOf(SiteConfigConflictError);
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      config: { site: { name: 'Last-moment external edit' } },
    });
    await expect(readdir(join(vault, '.publish'))).resolves.toEqual(['site.yml']);
  });

  it('reports a committed save as successful when post-commit cleanup fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    const configPath = join(vault, '.publish', 'site.yml');
    await writeFile(
      configPath,
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
    draft.site.name = 'Committed';

    const saved = await saveSiteConfigToDirectory(vault, draft, {
      expectedRevision: loaded.revision,
      removeFile: async () => {
        throw new Error('injected cleanup failure');
      },
    });

    expect(saved.config.site.name).toBe('Committed');
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      config: { site: { name: 'Committed' } },
    });
    const files = await readdir(join(vault, '.publish'));
    expect(files).toContain('site.yml');
    expect(files.some((file) => file.includes('.previous-'))).toBe(true);
    expect(files.some((file) => file.includes('.tmp-'))).toBe(true);
  });

  it('loads a future config read-only and refuses to overwrite it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      ['version: 2', 'site:', '  name: Future Wiki', 'future_option: enabled', ''].join(
        '\n',
      ),
      'utf8',
    );

    const loaded = await loadSiteConfigFromDirectory(vault);

    expect(loaded.status).toBe('future-version');
    if (loaded.status !== 'future-version') throw new Error('Expected future config.');
    expect(loaded.version).toBe(2);
    expect(loaded.source).toContain('future_option: enabled');
    const replacement: SiteConfigV1 = {
      version: 1,
      site: { name: 'Downgrade', homeLayout: 'sections' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'future-wiki' },
    };
    await expect(
      saveSiteConfigToDirectory(vault, replacement, {
        expectedRevision: loaded.revision,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'future-version-readonly' })],
    });
  });

  it('creates the first config atomically and freezes the system timezone', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-config-'));
    vaults.push(vault);
    const draft: SiteConfigV1 = {
      version: 1,
      site: { name: 'New Wiki', homeLayout: 'sections' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'new-wiki' },
    };

    const saved = await saveSiteConfigToDirectory(vault, draft, {
      expectedRevision: null,
      systemTimezone: 'Asia/Shanghai',
    });

    expect(saved.config.site.timezone).toBe('Asia/Shanghai');
    await expect(loadSiteConfigFromDirectory(vault)).resolves.toMatchObject({
      status: 'editable',
      config: { site: { name: 'New Wiki', timezone: 'Asia/Shanghai' } },
    });
  });
});
