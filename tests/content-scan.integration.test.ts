import {
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';
import { fixtureWebpDecoder, pngChunk, validPng } from './image-fixtures';

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

  it('keeps asset issue order and digest stable across directory enumeration order', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Stable Asset Issues',
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
        '  project_name: stable-asset-issues',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'a.md'),
      '---\npublication:\n  visibility: public\n---\n# A\n\n![A](missing-a.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'b.md'),
      '---\npublication:\n  visibility: public\n---\n# B\n\n![B](missing-b.png)\n',
      'utf8',
    );
    const ordered = await scanSiteFromDirectory(vault, {
      fileSystem: {
        readDirectory: async (directory) =>
          readdir(directory, { withFileTypes: true }),
      },
    });
    const reversed = await scanSiteFromDirectory(vault, {
      fileSystem: {
        readDirectory: async (directory) =>
          (await readdir(directory, { withFileTypes: true })).reverse(),
      },
    });

    expect(reversed.issues).toEqual(ordered.issues);
    expect(reversed.digest).toBe(ordered.digest);
    expect(ordered.issues.filter((issue) => issue.code === 'local-image-missing'))
      .toEqual([
        expect.objectContaining({ path: 'notes/a.md' }),
        expect.objectContaining({ path: 'notes/b.md' }),
      ]);
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
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[does-not-exist.v2|the unavailable note]]\n',
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
      '<p>the unavailable note</p>',
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
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[private/secret.v2|restricted excerpt]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private', 'secret.v2.md'),
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
    expect(output).not.toContain('private/secret.v2');
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
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[shared.v2|shared page]]\n',
      'utf8',
    );
    for (const directory of ['one', 'two']) {
      await writeFile(
        join(vault, 'notes', directory, 'shared.v2.md'),
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
    expect(html).not.toContain('href="/notes/one/shared.v2/"');
    expect(html).not.toContain('href="/notes/two/shared.v2/"');
    expect(
      scan.issues.some(
        (issue) => issue.code === 'unsupported-local-attachment',
      ),
    ).toBe(false);
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

  it('blocks a missing local image and previews only its author alt text', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Missing Image Wiki',
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
        '  project_name: missing-image-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\nBefore ![author fallback](images/missing.png) after.\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-missing',
        path: 'notes/source.md',
        line: 7,
        column: 8,
        impact: 'The image cannot be included in the next site version.',
        location: { path: 'notes/source.md', line: 7 },
      }),
    );
    expect(html).toContain('Before author fallback after.');
    expect(html).not.toContain('images/missing.png');
    expect(preview.assets).toEqual({});
  });

  it('blocks an image matched by assets.exclude even when the file exists', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'private-assets'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Excluded Image Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude:',
        '    - "notes/private-assets/**"',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: excluded-image-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![private artwork](private-assets/secret.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private-assets', 'secret.png'),
      Buffer.from('DO_NOT_PUBLISH'),
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-excluded',
        path: 'notes/source.md',
        line: 7,
      }),
    );
    expect(preview.files['/notes/source/index.html']).toContain(
      '<p>private artwork</p>',
    );
    expect(preview.assets).toEqual({});
    expect(JSON.stringify(preview)).not.toContain('DO_NOT_PUBLISH');
  });

  it('applies standard glob classes, braces, and Unicode normalization to exclusions', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'assets'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Standard Glob Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude:',
        '    - "notes/assets/[ab].png"',
        '    - "notes/assets/{c,d}.png"',
        '    - "notes/assets/café.png"',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: standard-glob-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const decomposedCafe = 'cafe\u0301.png';
    const files = ['a.png', 'b.png', 'c.png', 'd.png', decomposedCafe];
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${files
        .map((file) => `![excluded](assets/${file})`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      files.map((file) =>
        writeFile(join(vault, 'notes', 'assets', file), validPng),
      ),
    );

    const scan = await scanSiteFromDirectory(vault);

    expect(
      scan.issues.filter((issue) => issue.code === 'local-image-excluded'),
    ).toHaveLength(files.length);
  });

  it('matches assets.exclude double-star across zero directory levels', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Glob Exclusion Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude:',
        '    - "notes/**/secret.png"',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: glob-exclusion-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![secret](secret.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'secret.png'),
      validPng,
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-excluded',
        path: 'notes/source.md',
      }),
    );
    expect(preview.assets).toEqual({});
  });

  it('blocks outside, symlinked, and non-file local image targets', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    const outsidePath = join(tmpdir(), `${basename(vault)}-outside.png`);
    vaults.push(outsidePath);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'unreadable.png'), { recursive: true });
    await writeFile(outsidePath, 'OUTSIDE_SECRET_BYTES', 'utf8');
    await symlink(outsidePath, join(vault, 'notes', 'linked.png'));
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Unsafe Image Wiki',
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
        '  project_name: unsafe-image-wiki',
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
        `![outside fallback](../../${basename(outsidePath)})`,
        '![linked fallback](linked.png)',
        '![unreadable fallback](unreadable.png)',
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(scan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'local-image-unsafe-path',
          path: 'notes/source.md',
          line: 7,
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'local-image-unsafe-path',
          path: 'notes/source.md',
          line: 8,
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'local-image-unreadable',
          path: 'notes/source.md',
          line: 9,
        }),
      ]),
    );
    expect(html).toContain('outside fallback');
    expect(html).toContain('linked fallback');
    expect(html).toContain('unreadable fallback');
    expect(html).not.toContain(basename(outsidePath));
    expect(html).not.toContain('linked.png');
    expect(html).not.toContain('unreadable.png');
    expect(JSON.stringify(preview)).not.toContain('OUTSIDE_SECRET_BYTES');
    expect(preview.assets).toEqual({});
  });

  it('blocks an asset swapped after path validation instead of reading it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Asset Swap Wiki',
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
        '  project_name: asset-swap-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![swap](swap.png)\n',
      'utf8',
    );
    const assetPath = join(vault, 'notes', 'swap.png');
    const originalPath = join(vault, 'notes', 'swap-original.png');
    const outsidePath = join(vault, '..', `${basename(vault)}-outside.png`);
    await writeFile(
      assetPath,
      validPng,
    );
    await writeFile(outsidePath, Buffer.from('OUTSIDE_SECRET'));
    let swapped = false;
    const options = {
      localAssetFileSystem: {
        openFile: async (path: string, flags: number) => {
          expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
          if (!swapped && path.endsWith('/notes/swap.png')) {
            swapped = true;
            await rename(assetPath, originalPath);
            await symlink(outsidePath, assetPath);
          }
          return open(path, flags);
        },
      },
    } as Parameters<typeof scanSiteFromDirectory>[1];

    try {
      const scan = await scanSiteFromDirectory(vault, options);

      expect(scan.issues).toContainEqual(
        expect.objectContaining({
          severity: 'blocker',
          code: 'local-image-unsafe-path',
          path: 'notes/source.md',
        }),
      );
      expect(swapped).toBe(true);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('propagates cancellation that happens while opening a local asset', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Cancel Asset Scan',
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
        '  project_name: cancel-asset-scan',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![cancel](cancel.png)\n',
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'cancel.png'), validPng);
    const controller = new AbortController();

    await expect(
      scanSiteFromDirectory(vault, {
        signal: controller.signal,
        localAssetFileSystem: {
          openFile: async (path, flags) => {
            controller.abort();
            return open(path, flags);
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('blocks an oversized local asset before opening it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Bounded Asset Scan',
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
        '  project_name: bounded-asset-scan',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![huge](huge.png)\n',
      'utf8',
    );
    const hugePath = join(vault, 'notes', 'huge.png');
    const hugeHandle = await open(hugePath, 'w');
    await hugeHandle.write(validPng, 0, validPng.length, 0);
    await hugeHandle.truncate(26 * 1024 * 1024);
    await hugeHandle.close();
    const openFile = vi.fn(async (path: string, flags: number) =>
      open(path, flags),
    );

    const scan = await scanSiteFromDirectory(vault, {
      localAssetFileSystem: { openFile },
    });

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-resource-limit',
        path: 'notes/source.md',
      }),
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  it('rechecks size when the same asset inode expands after validation', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Expanded Asset Scan\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: expanded-asset-scan\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![expanded](expanded.png)\n',
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'expanded.png'), validPng);
    let expanded = false;

    const scan = await scanSiteFromDirectory(vault, {
      localAssetFileSystem: {
        openFile: async (path, flags) => {
          if (!expanded && path.endsWith('/notes/expanded.png')) {
            expanded = true;
            const writable = await open(path, 'r+');
            await writable.truncate(26 * 1024 * 1024);
            await writable.close();
          }
          return open(path, flags);
        },
      },
    });

    expect(expanded).toBe(true);
    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-resource-limit',
        path: 'notes/source.md',
      }),
    );
  });

  it('reads a repeatedly referenced asset once and caps reference work', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Repeated Asset Scan\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: repeated-asset-scan\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${Array.from(
        { length: 1_001 },
        (_value, index) => `![repeat ${index}](repeat.png)`,
      ).join('\n')}\n`,
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'repeat.png'), validPng);
    const openFile = vi.fn(async (path: string, flags: number) =>
      open(path, flags),
    );

    const scan = await scanSiteFromDirectory(vault, {
      localAssetFileSystem: { openFile },
    });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(
      scan.issues.filter((issue) => issue.code === 'local-image-resource-limit'),
    ).toHaveLength(1);
  });

  it('blocks SVG active content and external loading without copying payloads', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'svg'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: SVG Safety Wiki',
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
        '  project_name: svg-safety-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const attacks = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>SVG_SCRIPT_PAYLOAD</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="SVG_EVENT_PAYLOAD"><path/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.invalid/payload"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="//attacker.invalid/a.svg#x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>SVG_FOREIGN_PAYLOAD</foreignObject></svg>',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://attacker.invalid/x.css)</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(javascript:SVG_STYLE_PAYLOAD)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:u\\72l(\\68ttps://attacker.invalid/CSS_ESCAPE_PAYLOAD)}</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:red"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://attacker.invalid/"><image href="#payload"/></svg>',
    ];
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${attacks
        .map((_attack, index) => `![blocked svg ${index}](svg/attack-${index}.svg)`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      attacks.map((attack, index) =>
        writeFile(join(vault, 'notes', 'svg', `attack-${index}.svg`), attack),
      ),
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const svgIssues = scan.issues.filter(
      (issue) => issue.code === 'unsafe-svg-active-content',
    );

    expect(svgIssues).toHaveLength(attacks.length);
    expect(svgIssues.map((issue) => issue.line)).toEqual(
      attacks.map((_attack, index) => 7 + index),
    );
    expect(svgIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          impact: 'The SVG cannot be included in the next site version.',
        }),
      ]),
    );
    expect(preview.assets).toEqual({});
    const output = JSON.stringify(preview);
    for (const secret of [
      'SVG_SCRIPT_PAYLOAD',
      'SVG_EVENT_PAYLOAD',
      'attacker.invalid',
      'SVG_FOREIGN_PAYLOAD',
      'file:///etc/passwd',
      'SVG_STYLE_PAYLOAD',
      'CSS_ESCAPE_PAYLOAD',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('blocks files whose bytes do not match their supported image extension', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'spoofed'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Spoofed Image Wiki',
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
        '  project_name: spoofed-image-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const files = ['fake.png', 'fake.jpg', 'fake.gif', 'fake.webp', 'fake.svg'];
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${files
        .map((file) => `![spoofed](spoofed/${file})`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      files.map((file) =>
        writeFile(
          join(vault, 'notes', 'spoofed', file),
          `NOT_A_REAL_IMAGE:${file}`,
        ),
      ),
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const issues = scan.issues.filter(
      (issue) => issue.code === 'local-image-format-mismatch',
    );

    expect(issues).toHaveLength(files.length);
    expect(issues.map((issue) => issue.line)).toEqual([7, 8, 9, 10, 11]);
    expect(issues[0]).toMatchObject({
      severity: 'blocker',
      impact: 'The file cannot be included as a supported image.',
    });
    expect(preview.assets).toEqual({});
    expect(JSON.stringify(preview)).not.toContain('NOT_A_REAL_IMAGE');
  });

  it('blocks truncated files that contain only a supported image header', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'truncated'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Truncated Image Wiki',
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
        '  project_name: truncated-image-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const files = [
      ['short.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['short.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
      ['short.gif', Buffer.from('GIF89a')],
      ['short.webp', Buffer.from('RIFF0000WEBP')],
      [
        'bad-crc.png',
        (() => {
          const corrupted = Buffer.from(validPng);
          corrupted[29] = corrupted[29]! ^ 0xff;
          return corrupted;
        })(),
      ],
      [
        'empty-vp8.webp',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([12, 0, 0, 0]),
          Buffer.from('WEBPVP8 '),
          Buffer.alloc(4),
        ]),
      ],
      [
        'header-only-vp8l.webp',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([18, 0, 0, 0]),
          Buffer.from('WEBPVP8L'),
          Buffer.from([5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0]),
        ]),
      ],
      [
        'plausible-header-only-vp8l.webp',
        Buffer.from('UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAE=', 'base64'),
      ],
      [
        'plausible-header-only-vp8.webp',
        Buffer.from('UklGRhYAAABXRUJQVlA4IAoAAAAAAACdASoBAAEA', 'base64'),
      ],
      [
        'fake-frame.jpg',
        Buffer.from([
          0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00,
          0x01, 0x01, 0xff, 0xda, 0xff, 0xd9,
        ]),
      ],
    ] as const;
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${files
        .map(([file]) => `![truncated](truncated/${file})`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      files.map(([file, content]) =>
        writeFile(join(vault, 'notes', 'truncated', file), content),
      ),
    );

    const scan = await scanSiteFromDirectory(vault, {
      localAssetWebpDecoder: fixtureWebpDecoder,
    });
    const preview = await prepareLocalPreviewFromDirectory(vault, {
      webpDecoder: fixtureWebpDecoder,
    });

    expect(
      scan.issues.filter((issue) => issue.code === 'local-image-format-mismatch'),
    ).toHaveLength(files.length);
    expect(preview.assets).toEqual({});
  });

  it('warns but preserves a supported image larger than 5 MiB', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Large Image Wiki',
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
        '  project_name: large-image-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![large image](large.png)\n',
      'utf8',
    );
    const ancillaryPayload = Buffer.alloc(5 * 1024 * 1024, 0x2a);
    const ancillaryChunk = pngChunk('tEXt', ancillaryPayload);
    const image = Buffer.concat([
      validPng.subarray(0, validPng.length - 12),
      ancillaryChunk,
      validPng.subarray(validPng.length - 12),
    ]);
    await writeFile(join(vault, 'notes', 'large.png'), image);

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const asset = Object.values(preview.assets)[0];

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'large-local-image',
        path: 'notes/source.md',
        line: 7,
        impact: 'The image may make preview and deployment slower.',
      }),
    );
    expect(Buffer.from(asset?.content ?? []).equals(image)).toBe(true);
    expect(preview.files['/notes/source/index.html']).toContain('/assets/');
  });

  it('degrades local PDF, audio, video, and other attachments to author text', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'attachments'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Attachment Wiki',
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
        '  project_name: attachment-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const attachments = [
      ['manual.pdf', 'PDF manual'],
      ['interview.mp3', 'Audio interview'],
      ['demo.mp4', 'Video demo'],
      ['archive.zip', 'Download archive'],
    ] as const;
    await writeFile(
      join(vault, 'notes', 'source.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Source',
        '',
        `![${attachments[0][1]}](attachments/${attachments[0][0]})`,
        `[${attachments[1][1]}](attachments/${attachments[1][0]})`,
        `![${attachments[2][1]}](attachments/${attachments[2][0]})`,
        `[${attachments[3][1]}](attachments/${attachments[3][0]})`,
        '',
      ].join('\n'),
      'utf8',
    );
    await Promise.all(
      attachments.map(([file]) =>
        writeFile(join(vault, 'notes', 'attachments', file), `BYTES:${file}`),
      ),
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const warnings = scan.issues.filter(
      (issue) => issue.code === 'unsupported-local-attachment',
    );
    const html = preview.files['/notes/source/index.html']!;

    expect(warnings).toHaveLength(attachments.length);
    expect(warnings.map((issue) => issue.line)).toEqual([7, 8, 9, 10]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          impact: 'The attachment will not be uploaded in the next site version.',
        }),
      ]),
    );
    for (const [file, label] of attachments) {
      expect(html).toContain(label);
      expect(html).not.toContain(file);
    }
    expect(preview.assets).toEqual({});
  });

  it('degrades Obsidian attachment embeds with their author labels', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'attachments'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Obsidian Attachment Wiki',
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
        '  project_name: obsidian-attachment-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const attachments = [
      ['manual.pdf', 'PDF manual'],
      ['audio.mp3', 'Audio sample'],
      ['video.mp4', 'Video sample'],
      ['archive.zip', 'Archive download'],
    ] as const;
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${attachments
        .map(([file, label]) => `![[attachments/${file}|${label}]]`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      attachments.map(([file]) =>
        writeFile(join(vault, 'notes', 'attachments', file), `BYTES:${file}`),
      ),
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(
      scan.issues.filter(
        (issue) => issue.code === 'unsupported-local-attachment',
      ),
    ).toHaveLength(attachments.length);
    expect(scan.issues).not.toContainEqual(
      expect.objectContaining({ code: 'missing-note-reference' }),
    );
    for (const [file, label] of attachments) {
      expect(html).toContain(label);
      expect(html).not.toContain(file);
    }
    expect(preview.assets).toEqual({});
  });

  it('degrades arbitrary existing non-Markdown files as local attachments', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'files'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Arbitrary Attachment Wiki',
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
        '  project_name: arbitrary-attachment-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[ebook](files/book.epub)\n![[files/data.csv|data table]]\n[missing manual](files/missing.pdf)\n',
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'files', 'book.epub'), 'EPUB_BYTES');
    await writeFile(join(vault, 'notes', 'files', 'data.csv'), 'CSV_BYTES');

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(
      scan.issues.filter(
        (issue) => issue.code === 'unsupported-local-attachment',
      ),
    ).toHaveLength(3);
    expect(html).toContain('ebook');
    expect(html).toContain('data table');
    expect(html).not.toContain('book.epub');
    expect(html).not.toContain('data.csv');
    expect(html).toContain('missing manual');
    expect(html).not.toContain('missing.pdf');
    expect(preview.assets).toEqual({});
  });

  it('leaves fragment, mailto, and Markdown-relative non-attachment links alone', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Ordinary Link Wiki',
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
        '  project_name: ordinary-link-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[section](#details) [email](mailto:author@example.test) [guide](guide.md)\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(scan.issues).not.toContainEqual(
      expect.objectContaining({ code: 'unsupported-local-attachment' }),
    );
    expect(html).toContain('href="#details"');
    expect(html).toContain('href="mailto:author@example.test"');
    expect(html).toContain('href="guide.md"');
  });

  it('keeps valid HTTP(S) images and links external without probing the network', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: External Resource Wiki',
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
        '  project_name: external-resource-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![Remote image](https://cdn.example.test/image.png) [Remote page](http://example.test/page)\nPrefix <https://example.test/autolink>\nPrefix [Reference page][external-ref]\nPrefix [external-ref]\n\n[external-ref]: https://reference.example.test/page\n',
      'utf8',
    );
    const fetchBoundary = vi.fn();
    vi.stubGlobal('fetch', fetchBoundary);

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(html).toContain('src="https://cdn.example.test/image.png"');
    expect(html).toContain('href="http://example.test/page"');
    expect(scan.externalLinks).toContainEqual(
      expect.objectContaining({
        url: 'https://example.test/autolink',
        line: 8,
        column: 8,
      }),
    );
    expect(scan.externalLinks).toContainEqual(
      expect.objectContaining({
        url: 'https://reference.example.test/page',
        line: 9,
        column: 8,
      }),
    );
    expect(scan.externalLinks).toContainEqual(
      expect.objectContaining({
        url: 'https://reference.example.test/page',
        line: 10,
        column: 8,
      }),
    );
    expect(preview.assets).toEqual({});
    expect(
      scan.issues.some((issue) => /(?:image|attachment)/u.test(issue.code)),
    ).toBe(false);
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it('removes scripts, event handlers, dangerous URLs, and active HTML bodies', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Raw HTML Safety Wiki',
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
        '  project_name: raw-html-safety-wiki',
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
        '<script>SCRIPT_SECRET</script>',
        '<img src="javascript:URL_SECRET" onerror="EVENT_SECRET">',
        '<a href="data:text/html,DATA_SECRET">safe label</a>',
        '<iframe src="https://attacker.invalid">FRAME_SECRET</iframe>',
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;
    const rawHtmlWarnings = scan.issues.filter(
      (issue) => issue.code === 'unsafe-raw-html',
    );

    expect(rawHtmlWarnings.map((issue) => issue.line)).toEqual([7, 8, 9, 10]);
    expect(rawHtmlWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          impact: 'Unsafe HTML will be removed from the rendered page.',
        }),
      ]),
    );
    expect(html).toContain('safe label');
    for (const secret of [
      'SCRIPT_SECRET',
      'URL_SECRET',
      'EVENT_SECRET',
      'DATA_SECRET',
      'attacker.invalid',
      'FRAME_SECRET',
      '<script',
      'onerror',
      'javascript:',
      'data:text/html',
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it('warns and degrades malformed external URLs without a network request', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Invalid External URL Wiki',
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
        '  project_name: invalid-external-url-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![invalid remote](https://example.test:99999/image.png)\n',
      'utf8',
    );
    const fetchBoundary = vi.fn();
    vi.stubGlobal('fetch', fetchBoundary);

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'invalid-external-url',
        path: 'notes/source.md',
        line: 7,
        impact: 'The external resource will be shown as text.',
      }),
    );
    expect(html).toContain('invalid remote');
    expect(html).not.toContain('example.test:99999');
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it('keeps private resource problems dormant until the article is selected', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Dormant Resource Wiki',
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
        '  project_name: dormant-resource-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const articlePath = join(vault, 'notes', 'draft.md');
    const source = (visibility: 'private' | 'public') =>
      `---\npublication:\n  visibility: ${visibility}\n---\n# Draft\n\n![missing draft image](missing.png)\n<script>DORMANT_HTML_SECRET</script>\n`;
    await writeFile(articlePath, source('private'), 'utf8');

    const dormant = await scanSiteFromDirectory(vault);
    await writeFile(articlePath, source('public'), 'utf8');
    const active = await scanSiteFromDirectory(vault);

    expect(dormant.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'local-image-missing',
          path: 'notes/draft.md',
          dormant: true,
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'unsafe-raw-html',
          path: 'notes/draft.md',
          dormant: true,
        }),
      ]),
    );
    expect(active.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'local-image-missing',
          path: 'notes/draft.md',
          dormant: false,
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'unsafe-raw-html',
          path: 'notes/draft.md',
          dormant: false,
        }),
      ]),
    );
  });

  it('blocks external and unsupported publication.cover values', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Invalid Cover Wiki',
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
        '  project_name: invalid-cover-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'external.md'),
      '---\npublication:\n  visibility: public\n  cover: https://attacker.invalid/cover.png\n---\n# External Cover\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'attachment.md'),
      '---\npublication:\n  visibility: public\n  cover: manual.pdf\n---\n# Attachment Cover\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const coverIssues = scan.issues.filter(
      (issue) => issue.code === 'invalid-publication-cover',
    );

    expect(coverIssues).toHaveLength(2);
    expect(coverIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          path: 'notes/external.md',
          line: 4,
        }),
        expect.objectContaining({
          severity: 'blocker',
          path: 'notes/attachment.md',
          line: 4,
        }),
      ]),
    );
  });

  it('locates the real image when code examples contain the same reference first', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Image Location Wiki',
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
        '  project_name: image-location-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const realImageLine = 'Prefix ![real image](missing.png) suffix';
    await writeFile(
      join(vault, 'notes', 'source.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Source',
        '',
        '`![code image](missing.png)`',
        '',
        '```md',
        '![fenced image](missing.png)',
        '```',
        '',
        realImageLine,
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const issues = scan.issues.filter(
      (issue) => issue.code === 'local-image-missing',
    );

    expect(issues).toEqual([
      expect.objectContaining({
        path: 'notes/source.md',
        line: 13,
        column: realImageLine.indexOf('![') + 1,
      }),
    ]);
  });

  it('locates escaped and entity-decoded Markdown image destinations', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Escaped Image Location',
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
        '  project_name: escaped-image-location',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\nPrefix ![escaped](foo\\(bar\\).png)\nPrefix ![entity](foo&amp;.png)\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);

    expect(
      scan.issues
        .filter((issue) => issue.code === 'local-image-missing')
        .map((issue) => ({ line: issue.line, column: issue.column })),
    ).toEqual([
      { line: 7, column: 8 },
      { line: 8, column: 8 },
    ]);
  });

  it('warns at the opening marker of a multiline raw HTML tag', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Multiline HTML Location',
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
        '  project_name: multiline-html-location',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\nBefore <span\n data-secret="x">visible</span> after.\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);

    expect(
      scan.issues.filter((issue) => issue.code === 'unsafe-raw-html'),
    ).toContainEqual(
      expect.objectContaining({
        path: 'notes/source.md',
        line: 7,
        column: 8,
      }),
    );
  });

  it('does not mistake an autolink for the raw HTML location', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Autolink HTML Location\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: autolink-html-location\n',
      'utf8',
    );
    const line = 'Visit <https://example.test> then <span>raw</span>.';
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${line}\n`,
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);

    expect(
      scan.issues.find((issue) => issue.code === 'unsafe-raw-html'),
    ).toMatchObject({ line: 7, column: line.indexOf('<span>') + 1 });
  });
});
