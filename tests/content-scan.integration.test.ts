import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';

describe('site content scanner', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('warns when the whole vault is selected as a content root', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Whole Vault',
        '  home_layout: sections',
        'content_roots:',
        '  - path: .',
        '    public_root: /',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: whole-vault',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(vault, 'hello.md'), '# Hello\n', 'utf8');

    const result = await scanSiteFromDirectory(vault);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'vault-root-exposure',
        path: 'content_roots[0].path',
      }),
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourcePath: 'hello.md' }),
    ]);
  });

  it('blocks publishing when an entire configured content root is missing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Synced Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: synced-notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: synced-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await scanSiteFromDirectory(vault);

    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        code: 'content-root-missing',
        path: 'content_roots[0].path',
      }),
    ]);
  });

  it('produces a deterministic content digest without network, writes, or scope leakage', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Scoped Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: scoped-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const insidePath = join(vault, 'notes', 'inside.md');
    const outsidePath = join(vault, 'outside-secret.md');
    await writeFile(insidePath, '# Inside\n', 'utf8');
    await writeFile(outsidePath, '# Never leak this title\n', 'utf8');
    const fetchBoundary = vi.fn();
    vi.stubGlobal('fetch', fetchBoundary);

    const first = await scanSiteFromDirectory(vault);
    const second = await scanSiteFromDirectory(vault);

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('outside-secret');
    expect(JSON.stringify(first)).not.toContain('Never leak this title');
    expect(fetchBoundary).not.toHaveBeenCalled();
    await expect(readFile(insidePath, 'utf8')).resolves.toBe('# Inside\n');
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
      '# Never leak this title\n',
    );
  });

  it('honors an already-aborted scan signal', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanSiteFromDirectory(vault, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('turns an unreadable content root into a publishing blocker', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Unreadable Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: unreadable-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const unreadable = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });

    const result = await scanSiteFromDirectory(vault, {
      fileSystem: {
        readDirectory: async () => Promise.reject(unreadable),
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        code: 'content-root-unreadable',
        path: 'content_roots[0].path',
      }),
    ]);
  });

  it('surfaces route conflicts as locatable publishing blockers', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Conflicting Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: conflicting-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const source =
      '---\npublication:\n  visibility: public\n  slug: same\n---\n# Page\n';
    await writeFile(join(vault, 'notes', 'one.md'), source, 'utf8');
    await writeFile(join(vault, 'notes', 'two.md'), source, 'utf8');

    const result = await scanSiteFromDirectory(vault);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'route-conflict',
        path: 'notes/one.md',
      }),
    );
    expect(result.routePlan?.articles).toHaveLength(2);
  });

  it('warns at the exact source line while safely degrading a missing Wiki target', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Missing Link Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: missing-link-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\nRead [[does-not-exist|the unavailable note]].\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const output = JSON.stringify(preview.files);

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'missing-note-reference',
        path: 'notes/source.md',
        line: 7,
        impact: 'The published page will show text instead of a link.',
        location: { path: 'notes/source.md', line: 7 },
      }),
    );
    expect(preview.files['/notes/source/index.html']).toContain(
      'Read the unavailable note.',
    );
    expect(output).not.toContain('does-not-exist');
  });

  it('warns and renders only author text for a private Markdown embed', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'private'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Private Embed Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: private-embed-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[private/secret|restricted excerpt]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private', 'secret.md'),
      '---\npublication:\n  title: Hidden Strategy\n---\n# Hidden Strategy\n\nOperation Firefly.\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const output = JSON.stringify(preview.files);

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'private-note-embed',
        path: 'notes/source.md',
        line: 7,
        impact: 'Private note content will not be embedded in the published page.',
        location: { path: 'notes/source.md', line: 7 },
      }),
    );
    expect(preview.files['/notes/source/index.html']).toContain(
      '<p>restricted excerpt</p>',
    );
    expect(output).not.toContain('private/secret');
    expect(output).not.toContain('Hidden Strategy');
    expect(output).not.toContain('Operation Firefly');
  });

  it('allows cyclic links while warning and bounding cyclic public embeds', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Cyclic Embed Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: cyclic-embed-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'a.md'),
      '---\npublication:\n  visibility: public\n---\n# A\n\nA body. [[b|ordinary B]] ![[b|embedded B]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'b.md'),
      '---\npublication:\n  visibility: public\n---\n# B\n\nB body. [[a|ordinary A]] ![[a|embedded A]]\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/a/index.html']!;

    expect(
      scan.issues.some(
        (issue) =>
          issue.severity === 'warning' &&
          issue.code === 'cyclic-note-embed' &&
          /^notes\/[ab]\.md$/u.test(issue.path) &&
          issue.line === 7 &&
          issue.impact ===
            'The recursive embed will stop at the cycle boundary.',
      ),
    ).toBe(true);
    expect(scan.issues).not.toContainEqual(
      expect.objectContaining({ code: 'cyclic-note-link' }),
    );
    expect(html).toContain('<a href="/notes/b/">ordinary B</a>');
    expect(html).toContain('A body.');
    expect(html).toContain('B body.');
    expect(html.length).toBeLessThan(20_000);
  });

  it('keeps private-note issues dormant until the note enters the next version', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Dormant Issue Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: dormant-issue-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const articlePath = join(vault, 'notes', 'draft.md');
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: private\n---\n# Draft\n\n[[missing|unfinished reference]]\n',
      'utf8',
    );

    const dormant = await scanSiteFromDirectory(vault);
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: unlisted\n---\n# Draft\n\n[[missing|unfinished reference]]\n',
      'utf8',
    );
    const active = await scanSiteFromDirectory(vault);

    expect(dormant.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'missing-note-reference',
        path: 'notes/draft.md',
        line: 7,
        dormant: true,
      }),
    );
    expect(active.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'missing-note-reference',
        path: 'notes/draft.md',
        line: 7,
        dormant: false,
      }),
    );
  });

  it('ignores Wiki syntax inside inline and fenced code when inspecting dependencies', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Code Sample Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: code-sample-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Source',
        '',
        '`[[missing-inline]]`',
        '\\[[missing-escaped]]',
        '',
        '    [[missing-indented]]',
        '```md',
        '[[missing-fenced]]',
        '```',
        '> ```md',
        '> [[missing-quoted-fence]]',
        '> ```',
        '`multi-line code',
        '[[missing-multiline]]',
        'still code`',
        '',
        '[[missing-real|real missing link]]',
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const missingIssues = scan.issues.filter(
      (issue) => issue.code === 'missing-note-reference',
    );

    expect(missingIssues).toEqual([
      expect.objectContaining({ path: 'notes/source.md', line: 21 }),
    ]);
    expect(preview.files['/notes/source/index.html']).toContain(
      '[[missing-escaped]]',
    );
  });

  it('warns instead of guessing when a Wiki target is ambiguous', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'one'), { recursive: true });
    await mkdir(join(vault, 'notes', 'two'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Ambiguous Link Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: ambiguous-link-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[[shared|shared page]]\n',
      'utf8',
    );
    for (const directory of ['one', 'two']) {
      await writeFile(
        join(vault, 'notes', directory, 'shared.md'),
        `---\npublication:\n  visibility: public\n---\n# ${directory} shared\n`,
        'utf8',
      );
    }

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html'];

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'ambiguous-note-reference',
        path: 'notes/source.md',
        line: 7,
        impact: 'The published page will show text instead of a guessed link.',
      }),
    );
    expect(html).toContain('<p>shared page</p>');
    expect(html).not.toContain('href=');
  });

  it('degrades unsupported heading and block references until S07 handles them', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Anchored Link Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: anchored-link-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[[target#Details|heading label]] and [[target^block-id|block label]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'target.md'),
      '---\npublication:\n  visibility: public\n---\n# Target\n\n## Details\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(
      scan.issues.filter((issue) => issue.code === 'unsupported-note-anchor'),
    ).toEqual([
      expect.objectContaining({ path: 'notes/source.md', line: 7, column: 1 }),
      expect.objectContaining({ path: 'notes/source.md', line: 7, column: 38 }),
    ]);
    expect(html).toContain('heading label and block label');
    expect(html).not.toContain('href="/notes/target/');
  });

  it('warns at the embed that exceeds the shared source-character budget', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Large Embed Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: large-embed-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[target|TRUNCATED_BY_BUDGET]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'target.md'),
      `---\npublication:\n  visibility: public\n---\n# Target\n\n${'X'.repeat(1_000_100)}\n`,
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'embed-expansion-limit',
        path: 'notes/source.md',
        line: 7,
        column: 1,
        impact: 'Nested note content will stop at the safe expansion limit.',
      }),
    );
    expect(html).toContain('TRUNCATED_BY_BUDGET');
    expect(html).not.toContain('X'.repeat(1_000_100));
  });
});
