import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';

describe('local site preview', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('prepares one public note from a real vault as previewable site files', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
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
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'hello.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Hello Pages',
        '',
        'This came from a real vault.',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.siteName).toBe('LLM Wiki');
    expect(preview.pages).toEqual([
      {
        sourcePath: 'notes/hello.md',
        title: 'Hello Pages',
        url: '/notes/hello/',
      },
    ]);
    expect(preview.files['/index.html']).toContain(
      '<a href="/notes/hello/">Hello Pages</a>',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      '<h1>Hello Pages</h1>',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      'This came from a real vault.',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      'data-pages-preview="local"',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      '本地预览 · 尚未发布',
    );
    expect(preview.files['/notes/index.html']).toContain('<h1>notes</h1>');
    expect(preview.files['/notes/index.html']).toContain(
      '<a href="/notes/hello/">Hello Pages</a>',
    );
  });

  it('rejects a site config that omits required product schema fields', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Incomplete site',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(prepareLocalPreviewFromDirectory(vault)).rejects.toThrow(
      /site\.home_layout/,
    );
  });

  it('uses the route plan and displays pending, online, and redirect URLs in preview', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Route Preview',
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
        '  project_name: route-preview',
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
        '  slug: new',
        '  redirects: [/notes/old/]',
        '  deployment:',
        '    url: /notes/old/',
        '---',
        '# Route guide',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.routePlan.redirects).toEqual([
      { from: '/notes/old/', to: '/notes/new/' },
    ]);
    const html = preview.files['/notes/new/index.html'];
    expect(html).toContain('待发布 URL');
    expect(html).toContain('/notes/new/');
    expect(html).toContain('当前线上 URL');
    expect(html).toContain('/notes/old/');
    expect(html).toContain('/notes/old/ → /notes/new/');
  });

  it('renders an unlisted route without exposing it on the preview index', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Unlisted Preview',
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
        '  project_name: unlisted-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'secret-link.md'),
      '---\npublication:\n  visibility: unlisted\n---\n# By URL only\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.pages).toEqual([]);
    expect(preview.files['/notes/secret-link/index.html']).toContain(
      '<h1>By URL only</h1>',
    );
    expect(preview.files['/index.html']).not.toContain('secret-link');
  });

  it('degrades a public-to-private Wiki link without leaking private target facts', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'private'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Private Link Preview',
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
        '  project_name: private-link-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public\n\nSee [[private/secret-plan|the internal plan]], [[../outside-secret|the outside note]], and [[does-not-exist|the missing note]].\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private', 'secret-plan.md'),
      '---\npublication:\n  title: Confidential Roadmap\n---\n# Confidential Roadmap\n\nProject Nightingale details.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'outside-secret.md'),
      '# Outside Vault Secret\n\nOperation Starlight.\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const output = JSON.stringify(preview.files);

    expect(preview.files['/notes/public/index.html']).toContain(
      'See the internal plan, the outside note, and the missing note.',
    );
    expect(output).not.toContain('private/secret-plan');
    expect(output).not.toContain('outside-secret');
    expect(output).not.toContain('does-not-exist');
    expect(output).not.toContain('Confidential Roadmap');
    expect(output).not.toContain('Project Nightingale');
    expect(output).not.toContain('Outside Vault Secret');
    expect(output).not.toContain('Operation Starlight');
  });

  it('links public and unlisted Wiki targets to their planned online URLs', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Linked Preview',
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
        '  project_name: linked-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[[public-target|Public target]] and [[unlisted-target|Unlisted target]].\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public-target.md'),
      '---\npublication:\n  visibility: public\n---\n# Public Target\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'unlisted-target.md'),
      '---\npublication:\n  visibility: unlisted\n---\n# Unlisted Target\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html'];

    expect(html).toContain('<a href="/notes/public-target/">Public target</a>');
    expect(html).toContain(
      '<a href="/notes/unlisted-target/">Unlisted target</a>',
    );
  });

  it('bounds high-fanout public embeds with author-visible fallback text', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Bounded Embed Preview',
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
        '  project_name: bounded-embed-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: public\n---\n# Source\n\n${'![[target|embed truncated]]\n'.repeat(300)}`,
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'target.md'),
      '---\npublication:\n  visibility: public\n---\n# Target\n\nEMBED_PAYLOAD\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;
    const embeddedPayloads = html.match(/EMBED_PAYLOAD/gu) ?? [];

    expect(embeddedPayloads.length).toBeLessThanOrEqual(256);
    expect(html).toContain('embed truncated');
  });
});
