import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';
import {
  validAnimatedWebp,
  validGif,
  fixtureWebpDecoder,
  validJpeg,
  validLosslessWebp,
  validPng,
  validWebp,
} from './image-fixtures';

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
      '<a href="/notes/">notes</a>',
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

  it('copies only a directly referenced public PNG into the preview artifact', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'images'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Image Preview',
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
        '  project_name: image-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public\n\n![Public logo](images/logo.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private.md'),
      '---\npublication:\n  visibility: private\n---\n# Private\n\n![Private image](images/private.png)\n',
      'utf8',
    );
    const publicPng = validPng;
    await writeFile(join(vault, 'notes', 'images', 'logo.png'), publicPng);
    await writeFile(
      join(vault, 'notes', 'images', 'private.png'),
      Buffer.from('PRIVATE_IMAGE_BYTES'),
    );
    await writeFile(
      join(vault, 'notes', 'images', 'unused.png'),
      Buffer.from('UNUSED_IMAGE_BYTES'),
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const assetEntries = Object.entries(preview.assets);

    expect(assetEntries).toHaveLength(1);
    expect(assetEntries[0]?.[0]).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/u);
    expect(Buffer.from(assetEntries[0]?.[1].content ?? [])).toEqual(publicPng);
    expect(assetEntries[0]?.[1].contentType).toBe('image/png');
    expect(preview.files['/notes/public/index.html']).toContain(
      `<img src="${assetEntries[0]?.[0]}" alt="Public logo">`,
    );
    expect(JSON.stringify(Object.keys(preview.assets))).not.toContain('private');
    expect(JSON.stringify(Object.keys(preview.assets))).not.toContain('unused');
  });

  it('preserves supported JPEG, WebP, GIF, and safe SVG files and media types', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'media'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Image Format Preview',
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
        '  project_name: image-format-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    const formats = [
      {
        file: 'photo.jpeg',
        contentType: 'image/jpeg',
        content: validJpeg,
      },
      {
        file: 'graphic.webp',
        contentType: 'image/webp',
        content: validWebp,
      },
      {
        file: 'lossless.webp',
        contentType: 'image/webp',
        content: validLosslessWebp,
      },
      {
        file: 'animated.webp',
        contentType: 'image/webp',
        content: validAnimatedWebp,
      },
      {
        file: 'motion.gif',
        contentType: 'image/gif',
        content: validGif,
      },
      {
        file: 'mark.svg',
        contentType: 'image/svg+xml',
        content: Buffer.from(
          '<?xml version="1.0"?>\n<!-- safe author comment -->\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
        ),
      },
    ];
    await writeFile(
      join(vault, 'notes', 'source.md'),
      `---\npublication:\n  visibility: unlisted\n---\n# Source\n\n${formats
        .map(({ file }) => `![${file}](media/${file})`)
        .join('\n')}\n`,
      'utf8',
    );
    await Promise.all(
      formats.map(({ file, content }) =>
        writeFile(join(vault, 'notes', 'media', file), content),
      ),
    );

    const preview = await prepareLocalPreviewFromDirectory(vault, {
      webpDecoder: fixtureWebpDecoder,
    });
    const entries = Object.entries(preview.assets);

    expect(entries).toHaveLength(formats.length);
    for (const format of formats) {
      const entry = entries.find(
        ([path, asset]) =>
          path.endsWith(`.${format.file.split('.').at(-1)}`) &&
          Buffer.from(asset.content).equals(format.content),
      );
      expect(entry?.[1].contentType).toBe(format.contentType);
      expect(Buffer.from(entry?.[1].content ?? [])).toEqual(format.content);
      expect(preview.files['/notes/source/index.html']).toContain(
        `src="${entry?.[0]}"`,
      );
    }
  });

  it('routes Obsidian image embeds through the local asset pipeline', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'media'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Obsidian Image Preview',
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
        '  project_name: obsidian-image-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[media/diagram.png|Architecture diagram]]\n',
      'utf8',
    );
    const image = validPng;
    await writeFile(join(vault, 'notes', 'media', 'diagram.png'), image);

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const assetPath = Object.keys(preview.assets)[0];

    expect(assetPath).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/u);
    expect(preview.files['/notes/source/index.html']).toContain(
      `<img src="${assetPath}" alt="Architecture diagram">`,
    );
    expect(preview.files['/notes/source/index.html']).not.toContain(
      '不可用链接',
    );
  });

  it('includes a public publication.cover but excludes a private cover', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await mkdir(join(vault, 'assets'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Cover Preview',
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
        '  project_name: cover-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n  cover: assets/public-cover.png\n---\n# Public\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private.md'),
      '---\npublication:\n  visibility: private\n  cover: assets/private-cover.png\n---\n# Private\n',
      'utf8',
    );
    const publicCover = validPng;
    await writeFile(join(vault, 'assets', 'public-cover.png'), publicCover);
    await writeFile(
      join(vault, 'assets', 'private-cover.png'),
      Buffer.from('PRIVATE_COVER_BYTES'),
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(Object.values(preview.assets)).toHaveLength(1);
    expect(
      Buffer.from(Object.values(preview.assets)[0]?.content ?? []),
    ).toEqual(publicCover);
    expect(JSON.stringify(preview.assets)).not.toContain('PRIVATE_COVER_BYTES');
  });

  it('does not collect assets from a public index page suppressed by routing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Index Asset Preview',
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
        '  project_name: index-asset-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', '_index.md'),
      '---\npublication:\n  visibility: public\n---\n# Winning Index\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'index.md'),
      '---\npublication:\n  visibility: public\n---\n# Suppressed Index\n\n![loser asset](loser.png)\n',
      'utf8',
    );
    const secretImage = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ROUTE_LOSER_SECRET'),
    ]);
    await writeFile(join(vault, 'notes', 'loser.png'), secretImage);

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.routePlan.articles.map((article) => article.sourcePath)).toEqual([
      'notes/_index.md',
    ]);
    expect(preview.assets).toEqual({});
    expect(JSON.stringify(preview)).not.toContain('ROUTE_LOSER_SECRET');
  });

  it('keeps trusted public note-embed HTML including a local image', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Embedded Image Preview',
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
        '  project_name: embedded-image-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[target|embedded target]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'target.md'),
      '---\npublication:\n  visibility: public\n---\n# Target\n\nTarget body. ![target image](target.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'target.png'),
      validPng,
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const assetPath = Object.keys(preview.assets)[0];
    const html = preview.files['/notes/source/index.html']!;

    expect(html).toContain('Target body.');
    expect(html).toContain(`<img src="${assetPath}" alt="target image">`);
  });

  it('publishes and rewrites ordinary links to supported local images', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'images'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Linked Image Preview',
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
        '  project_name: linked-image-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[View original](images/photo.png)\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'images', 'photo.png'),
      validPng,
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const [assetPath] = Object.keys(preview.assets);
    const html = preview.files['/notes/source/index.html']!;

    expect(assetPath).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/u);
    expect(html).toContain(`<a href="${assetPath}">View original</a>`);
    expect(html).not.toContain('href="images/photo.png"');
  });

  it('treats a dotted Obsidian target as a note when that note exists', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Dotted Note Preview',
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
        '  project_name: dotted-note-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[foo.v2|Dotted note]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'foo.v2.md'),
      '---\npublication:\n  visibility: public\n---\n# Foo v2\n\nDOTTED_NOTE_BODY\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/source/index.html']!;

    expect(html).toContain('DOTTED_NOTE_BODY');
    expect(html).not.toContain('Dotted note');
    expect(preview.assets).toEqual({});
    expect(
      scan.issues.filter((issue) =>
        ['unsupported-local-attachment', 'missing-note-reference'].includes(
          issue.code,
        ),
      ),
    ).toEqual([]);
  });

  it('resolves Obsidian images by Vault path and unique suffix without guessing ambiguity', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'deep'), { recursive: true });
    await mkdir(join(vault, 'assets'), { recursive: true });
    await mkdir(join(vault, 'media'), { recursive: true });
    await mkdir(join(vault, 'left'), { recursive: true });
    await mkdir(join(vault, 'right'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Obsidian Resolution Preview',
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
        '  project_name: obsidian-resolution-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'deep', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n![[assets/root.png|Root]]\n\n![[unique.png|Unique]]\n\n![[dupe.png|Ambiguous]]\n',
      'utf8',
    );
    const png = validPng;
    await writeFile(join(vault, 'assets', 'root.png'), png);
    await writeFile(join(vault, 'media', 'unique.png'), png);
    await writeFile(join(vault, 'left', 'dupe.png'), png);
    await writeFile(join(vault, 'right', 'dupe.png'), png);

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const html = preview.files['/notes/deep/source/index.html']!;

    expect(Object.keys(preview.assets)).toHaveLength(1);
    expect(html.match(/<img /gu)).toHaveLength(2);
    expect(html).toContain('alt="Root"');
    expect(html).toContain('alt="Unique"');
    expect(html).toContain('<p>Ambiguous</p>');
    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'local-image-ambiguous',
        path: 'notes/deep/source.md',
        line: 11,
      }),
    );
  });
});
