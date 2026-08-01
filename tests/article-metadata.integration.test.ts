import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitArticleIntentEditToDirectory,
  prepareArticleIntentEditFromDirectory,
  prepareLegacyPublicationMigrationFromDirectory,
  readArticleMetadataFromDirectory,
} from '../src/publication/article-metadata';

describe('article publication metadata', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('treats an article without explicit visibility as private without writing Frontmatter', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'draft.md');
    const source = '# Draft title\n\nThis is a private draft.\n';
    await writeFile(articlePath, source, 'utf8');

    const metadata = await readArticleMetadataFromDirectory(
      vault,
      'notes/draft.md',
    );

    expect(metadata.visibility).toEqual({ value: 'private', source: 'default' });
    expect(metadata.deployment).toBeUndefined();
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);
  });

  it('keeps explicit local intent separate from read-only deployment facts', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'published.md'),
      [
        '---',
        'publication:',
        '  visibility: private',
        '  deployment:',
        '    url: /notes/published/',
        '    first_published_at: 2026-07-01T10:00:00+08:00',
        '    last_published_at: 2026-07-30T12:00:00+08:00',
        '    source_digest: abc123',
        '    deployment_id: deployment-42',
        '---',
        '# Published before',
        '',
      ].join('\n'),
      'utf8',
    );

    const metadata = await readArticleMetadataFromDirectory(
      vault,
      'notes/published.md',
    );

    expect(metadata.visibility).toEqual({
      value: 'private',
      source: 'publication.visibility',
    });
    expect(metadata.deployment).toEqual({
      url: '/notes/published/',
      firstPublishedAt: '2026-07-01T10:00:00+08:00',
      lastPublishedAt: '2026-07-30T12:00:00+08:00',
      sourceDigest: 'abc123',
      deploymentId: 'deployment-42',
    });
  });

  it('projects title, summary, slug, date, tags, kind, and redirects from documented fallbacks', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'fallback-name.md'),
      [
        '---',
        'date: 2026-07-31 09:30',
        'tags:',
        '  - agent',
        '  - workflow',
        '---',
        '# Heading fallback',
        '',
        'First useful paragraph becomes the summary.',
        '',
        'Second paragraph is not needed.',
        '',
      ].join('\n'),
      'utf8',
    );

    const metadata = await readArticleMetadataFromDirectory(
      vault,
      'notes/fallback-name.md',
    );

    expect(metadata.title).toEqual({
      value: 'Heading fallback',
      source: 'first-h1',
    });
    expect(metadata.summary).toEqual({
      value: 'First useful paragraph becomes the summary.',
      source: 'body-summary',
    });
    expect(metadata.slug).toEqual({
      value: 'fallback-name',
      source: 'filename',
    });
    expect(metadata.date).toEqual({
      value: '2026-07-31 09:30',
      source: 'frontmatter.date',
    });
    expect(metadata.tags).toEqual({
      value: ['agent', 'workflow'],
      source: 'frontmatter.tags',
    });
    expect(metadata.cover).toBeUndefined();
    expect(metadata.kind).toEqual({ value: 'article', source: 'default' });
    expect(metadata.order).toBeUndefined();
    expect(metadata.redirects).toEqual({ value: [], source: 'default' });
  });

  it('reads every supported explicit publication intent field with its source', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'explicit.md'),
      [
        '---',
        'date: fallback-date',
        'tags: [fallback]',
        'publication:',
        '  visibility: unlisted',
        '  title: Explicit title',
        '  summary: Explicit summary',
        '  slug: 显式-slug',
        '  date: 2026-07-20 08:00',
        '  updated: 2026-07-31 18:00',
        '  tags: [agent, publish]',
        '  cover: assets/cover.png',
        '  kind: index',
        '  order: 7',
        '  redirects: [/old-one/, /old-two/]',
        '---',
        '# Ignored heading',
        '',
        'Ignored fallback summary.',
        '',
      ].join('\n'),
      'utf8',
    );

    const metadata = await readArticleMetadataFromDirectory(
      vault,
      'notes/explicit.md',
    );

    expect(metadata).toMatchObject({
      visibility: { value: 'unlisted', source: 'publication.visibility' },
      title: { value: 'Explicit title', source: 'publication.title' },
      summary: { value: 'Explicit summary', source: 'publication.summary' },
      slug: { value: '显式-slug', source: 'publication.slug' },
      date: { value: '2026-07-20 08:00', source: 'publication.date' },
      updated: { value: '2026-07-31 18:00', source: 'publication.updated' },
      tags: { value: ['agent', 'publish'], source: 'publication.tags' },
      cover: { value: 'assets/cover.png', source: 'publication.cover' },
      kind: { value: 'index', source: 'publication.kind' },
      order: { value: 7, source: 'publication.order' },
      redirects: {
        value: ['/old-one/', '/old-two/'],
        source: 'publication.redirects',
      },
    });
  });

  it('rejects an invalid explicit visibility instead of silently using private', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'invalid.md'),
      '---\npublication:\n  visibility: secret\n---\n# Invalid\n',
      'utf8',
    );

    await expect(
      readArticleMetadataFromDirectory(vault, 'notes/invalid.md'),
    ).rejects.toMatchObject({
      issues: [
        {
          code: 'invalid-publication-field',
          path: 'publication.visibility',
        },
      ],
    });
  });

  it('prepares an initial visibility suggestion without writing Frontmatter', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'candidate.md');
    const source = '# Candidate\n\nSuggested, but not yet confirmed.\n';
    await writeFile(articlePath, source, 'utf8');

    const suggestion = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/candidate.md',
      { visibility: 'public' },
    );

    expect(suggestion.current.visibility).toEqual({
      value: 'private',
      source: 'default',
    });
    expect(suggestion.next.visibility).toEqual({
      value: 'public',
      source: 'publication.visibility',
    });
    expect(suggestion.sourcePreview).toContain(
      'publication:\n  visibility: public',
    );
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);
  });

  it('commits explicit visibility without changing the body or deployment facts', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'online.md');
    const source = [
      '---',
      'owner: Ivan',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    url: /notes/online/',
      '    source_digest: immutable-digest',
      '---',
      '# Existing body',
      '',
      'Keep this body byte-for-byte.',
      '',
    ].join('\n');
    await writeFile(articlePath, source, 'utf8');
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/online.md',
      { visibility: 'unlisted' },
    );

    const saved = await commitArticleIntentEditToDirectory(vault, edit);

    expect(saved.visibility).toEqual({
      value: 'unlisted',
      source: 'publication.visibility',
    });
    expect(saved.deployment).toEqual({
      url: '/notes/online/',
      sourceDigest: 'immutable-digest',
    });
    const written = await readFile(articlePath, 'utf8');
    expect(written).toContain('owner: Ivan');
    expect(written).toContain(
      '# Existing body\n\nKeep this body byte-for-byte.\n',
    );
  });

  it('rejects a late external edit without overwriting either version', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'racing.md');
    const source = '# Original\n';
    const externalSource = '# External edit wins\n';
    await writeFile(articlePath, source, 'utf8');
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/racing.md',
      { visibility: 'public' },
    );

    await expect(
      commitArticleIntentEditToDirectory(vault, edit, {
        beforeClaim: async () => writeFile(articlePath, externalSource, 'utf8'),
      }),
    ).rejects.toMatchObject({
      name: 'ArticleIntentConflictError',
      currentSource: externalSource,
      prepared: { sourcePreview: edit.sourcePreview },
    });
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(externalSource);
  });

  it('writes every explicit v1 intent override while preserving deployment facts', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'overrides.md');
    await writeFile(
      articlePath,
      [
        '---',
        'publication:',
        '  visibility: public',
        '  deployment:',
        '    deployment_id: keep-me',
        '---',
        '# Fallback title',
        '',
        'Fallback summary.',
        '',
      ].join('\n'),
      'utf8',
    );
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/overrides.md',
      {
        visibility: 'unlisted',
        title: 'Edited title',
        summary: 'Edited summary',
        slug: 'edited-slug',
        date: '2026-07-01 08:00',
        updated: '2026-07-31 20:00',
        tags: ['edited', 'intent'],
        cover: 'assets/edited.png',
        kind: 'index',
        order: 3,
        redirects: ['/before/'],
      },
    );

    const saved = await commitArticleIntentEditToDirectory(vault, edit);

    expect(saved).toMatchObject({
      visibility: { value: 'unlisted', source: 'publication.visibility' },
      title: { value: 'Edited title', source: 'publication.title' },
      summary: { value: 'Edited summary', source: 'publication.summary' },
      slug: { value: 'edited-slug', source: 'publication.slug' },
      date: { value: '2026-07-01 08:00', source: 'publication.date' },
      updated: { value: '2026-07-31 20:00', source: 'publication.updated' },
      tags: { value: ['edited', 'intent'], source: 'publication.tags' },
      cover: { value: 'assets/edited.png', source: 'publication.cover' },
      kind: { value: 'index', source: 'publication.kind' },
      order: { value: 3, source: 'publication.order' },
      redirects: { value: ['/before/'], source: 'publication.redirects' },
      deployment: { deploymentId: 'keep-me' },
    });
  });

  it('requires confirmation before a deployed article becomes pending takedown', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'deployed.md');
    const source = [
      '---',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    url: https://example.com/deployed/',
      '    deployment_id: deployment-7',
      '---',
      '# Deployed',
      '',
    ].join('\n');
    await writeFile(articlePath, source, 'utf8');
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/deployed.md',
      { visibility: 'private' },
    );

    expect(edit.confirmation).toEqual({
      kind: 'takedown',
      onlineUrl: 'https://example.com/deployed/',
    });
    await expect(
      commitArticleIntentEditToDirectory(vault, edit),
    ).rejects.toMatchObject({ name: 'ArticleIntentConfirmationRequiredError' });
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);

    const saved = await commitArticleIntentEditToDirectory(vault, edit, {
      confirmTakedown: true,
    });
    expect(saved.visibility.value).toBe('private');
    expect(saved.deployment).toEqual({
      url: 'https://example.com/deployed/',
      deploymentId: 'deployment-7',
    });
  });

  it('does not request another takedown confirmation for an offline article retaining only its first publication date', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'historical.md'),
      '---\npublication:\n  visibility: public\n  deployment:\n    first_published_at: 2026-08-01T10:20:30+08:00\n---\n# Historical\n',
      'utf8',
    );

    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/historical.md',
      { visibility: 'private' },
    );

    expect(edit.confirmation).toBeUndefined();
    await expect(commitArticleIntentEditToDirectory(vault, edit)).resolves.toMatchObject({
      visibility: { value: 'private' },
      deployment: { firstPublishedAt: '2026-08-01T10:20:30+08:00' },
    });
  });

  it('previews legacy publish booleans losslessly and migrates only to the new schema', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'legacy.md');
    const source = [
      '---',
      'publish: true',
      'published: true',
      'owner: Ivan',
      '---',
      '# Legacy',
      '',
    ].join('\n');
    await writeFile(articlePath, source, 'utf8');

    const migration = await prepareLegacyPublicationMigrationFromDirectory(
      vault,
      'notes/legacy.md',
    );

    expect(migration).toMatchObject({
      legacyFields: [
        { path: 'publish', value: true },
        { path: 'published', value: true },
      ],
      next: {
        visibility: { value: 'public', source: 'publication.visibility' },
      },
    });
    expect(migration?.sourcePreview).toContain('publish: true');
    expect(migration?.sourcePreview).toContain('published: true');
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);

    await commitArticleIntentEditToDirectory(vault, migration!);
    const written = await readFile(articlePath, 'utf8');
    expect(written).toContain('publish: true');
    expect(written).toContain('published: true');
    expect(written).toContain('publication:\n  visibility: public');
  });

  it('reports malformed Frontmatter as a structured error without changing the file', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'malformed.md');
    const source = '---\npublication: [\n---\n# Malformed\n';
    await writeFile(articlePath, source, 'utf8');

    await expect(
      readArticleMetadataFromDirectory(vault, 'notes/malformed.md'),
    ).rejects.toMatchObject({
      issues: [
        {
          code: 'invalid-frontmatter',
          path: 'frontmatter',
        },
      ],
    });
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);
  });

  it('rejects an article symlink that escapes the Vault before reading metadata', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    const outside = await mkdtemp(join(tmpdir(), 'pages-publish-outside-'));
    vaults.push(vault, outside);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const outsidePath = join(outside, 'secret.md');
    await writeFile(outsidePath, '# Outside secret\n', 'utf8');
    await symlink(outsidePath, join(vault, 'notes', 'linked.md'));

    await expect(
      readArticleMetadataFromDirectory(vault, 'notes/linked.md'),
    ).rejects.toThrow('regular Markdown file');
  });

  it('rejects an unclosed Frontmatter boundary instead of treating it as article body', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'unclosed.md'),
      '---\npublication:\n  visibility: public\n# Missing boundary\n',
      'utf8',
    );

    await expect(
      prepareArticleIntentEditFromDirectory(vault, 'notes/unclosed.md', {
        visibility: 'private',
      }),
    ).rejects.toMatchObject({
      issues: [
        {
          code: 'invalid-frontmatter',
          path: 'frontmatter',
        },
      ],
    });
  });

  it('preserves CRLF Frontmatter, unrelated fields, and deployment facts during an edit', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'crlf.md');
    const source = [
      '---',
      'owner: Ivan',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    deployment_id: crlf-deployment',
      '---',
      '# CRLF body',
      '',
    ].join('\r\n');
    await writeFile(articlePath, source, 'utf8');

    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/crlf.md',
      { title: 'CRLF override' },
    );
    expect(edit.current.visibility.value).toBe('public');
    expect(edit.current.deployment?.deploymentId).toBe('crlf-deployment');
    await commitArticleIntentEditToDirectory(vault, edit);

    const written = await readFile(articlePath, 'utf8');
    expect(written).toContain('owner: Ivan\r\n');
    expect(written).toContain('deployment_id: crlf-deployment\r\n');
    expect(written).toContain('---\r\n# CRLF body\r\n');
    expect(written).not.toContain('---\n---\r\n');
  });

  it('rebuilds a commit from the allowed patch instead of trusting a mutated source preview', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'tampered-preview.md');
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: public\n  deployment:\n    deployment_id: immutable\n---\n# Original\n',
      'utf8',
    );
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/tampered-preview.md',
      { title: 'Allowed title' },
    );
    edit.sourcePreview =
      '---\npublication:\n  visibility: public\n---\n# Tampered body\n';

    const saved = await commitArticleIntentEditToDirectory(vault, edit);

    expect(saved.title.value).toBe('Allowed title');
    expect(saved.deployment?.deploymentId).toBe('immutable');
    const written = await readFile(articlePath, 'utf8');
    expect(written).toContain('# Original');
    expect(written).not.toContain('Tampered body');
  });

  it('recomputes takedown confirmation even when a caller removes it from the prepared draft', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'tampered-confirmation.md');
    const source =
      '---\npublication:\n  visibility: public\n  deployment:\n    url: /online/\n    deployment_id: online\n---\n# Online\n';
    await writeFile(articlePath, source, 'utf8');
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/tampered-confirmation.md',
      { visibility: 'private' },
    );
    delete edit.confirmation;

    await expect(
      commitArticleIntentEditToDirectory(vault, edit),
    ).rejects.toMatchObject({ name: 'ArticleIntentConfirmationRequiredError' });
    await expect(readFile(articlePath, 'utf8')).resolves.toBe(source);
  });

  it('rejects an ancestor directory symlink that aliases content from elsewhere in the Vault', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await mkdir(join(vault, 'private'), { recursive: true });
    await writeFile(join(vault, 'private', 'secret.md'), '# Secret\n', 'utf8');
    await symlink('../private', join(vault, 'notes', 'alias'));

    await expect(
      prepareArticleIntentEditFromDirectory(
        vault,
        'notes/alias/secret.md',
        { visibility: 'public' },
      ),
    ).rejects.toThrow('cannot contain symbolic links');
    await expect(
      readFile(join(vault, 'private', 'secret.md'), 'utf8'),
    ).resolves.toBe('# Secret\n');
  });

  it('rejects a non-mapping YAML Frontmatter root as a structured error', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'list-root.md'),
      '---\n- not\n- a mapping\n---\n# Invalid root\n',
      'utf8',
    );

    await expect(
      readArticleMetadataFromDirectory(vault, 'notes/list-root.md'),
    ).rejects.toMatchObject({
      issues: [{ code: 'invalid-frontmatter', path: 'frontmatter' }],
    });
  });

  it('uses a single-string general tag as the existing tags fallback', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, 'notes', 'single-tag.md'),
      '---\ntags: agent\n---\n# Single tag\n',
      'utf8',
    );

    const metadata = await readArticleMetadataFromDirectory(
      vault,
      'notes/single-tag.md',
    );

    expect(metadata.tags).toEqual({
      value: ['agent'],
      source: 'frontmatter.tags',
    });
  });

  it('rejects a parent-directory symlink swap during the commit window', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    const outside = await mkdtemp(join(tmpdir(), 'pages-publish-outside-'));
    vaults.push(vault, outside);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'raced.md');
    const outsidePath = join(outside, 'raced.md');
    const original = '# Same original revision\n';
    await writeFile(articlePath, original, 'utf8');
    await writeFile(outsidePath, original, 'utf8');
    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/raced.md',
      { visibility: 'public' },
    );

    await expect(
      commitArticleIntentEditToDirectory(vault, edit, {
        beforeClaim: async () => {
          const entries = await readdir(join(vault, 'notes'));
          const temporaryName = entries.find((name) => name.includes('.tmp-'));
          if (!temporaryName) throw new Error('Prepared temp file was not found.');
          await rename(join(vault, 'notes'), join(vault, 'notes-original'));
          await symlink(outside, join(vault, 'notes'));
          await link(
            join(vault, 'notes-original', temporaryName),
            join(outside, temporaryName),
          );
        },
      }),
    ).rejects.toThrow('cannot contain symbolic links');
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(original);
  });

  it('preserves a UTF-8 BOM before CRLF Frontmatter without nesting a second header', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-article-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const articlePath = join(vault, 'notes', 'bom.md');
    const source =
      '\uFEFF---\r\npublication:\r\n  visibility: public\r\n  deployment:\r\n    deployment_id: bom-online\r\n---\r\n# BOM article\r\n';
    await writeFile(articlePath, source, 'utf8');

    const edit = await prepareArticleIntentEditFromDirectory(
      vault,
      'notes/bom.md',
      { title: 'BOM override' },
    );
    expect(edit.current.visibility.value).toBe('public');
    expect(edit.current.deployment?.deploymentId).toBe('bom-online');
    await commitArticleIntentEditToDirectory(vault, edit);

    const written = await readFile(articlePath, 'utf8');
    expect(written.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(written.match(/publication:/g)).toHaveLength(1);
    expect(written).toContain('deployment_id: bom-online\r\n');
  });
});
