import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareLocalPreviewFromDirectory } from './support/legacy-preview';

describe('public site discovery output', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('publishes a public article into the downloadable search index and sitemap', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-discovery-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Discovery\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: true\n  graph: true\ncloudflare:\n  project_name: discovery-demo\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n  title: Public search title\n---\n# Public search title\n\nFindable public body text.\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const search = preview.files['/search/index.html']!;
    const sitemap = preview.files['/sitemap.xml']!;

    expect(search).toContain('Public search title');
    expect(search).toContain('Findable public body text.');
    expect(sitemap).toContain('https://discovery-demo.pages.dev/notes/public/');
  });

  it('keeps unlisted and private facts out of every public discovery artifact', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-discovery-privacy-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Private discovery\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: true\n  graph: true\ncloudflare:\n  project_name: private-discovery\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public-a.md'),
      '---\npublication:\n  visibility: public\n  title: Public A\n---\n# Public A\n\n[[public-b]] [[unlisted-secret|hidden alias]] [[private-secret|private alias]] ![[unlisted-secret|embedded unlisted alias]]\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public-b.md'),
      '---\npublication:\n  visibility: public\n  title: Public B\n---\n# Public B\n\nPublic graph target.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'unlisted-secret.md'),
      '---\npublication:\n  visibility: unlisted\n  title: Unlisted Strategy\n---\n# Unlisted Strategy\n\nUnlisted body details.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private-secret.md'),
      '---\npublication:\n  title: Private Roadmap\n---\n# Private Roadmap\n\nPrivate body details.\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const publicArtifacts = [
      preview.files['/index.html'],
      preview.files['/search/index.html'],
      preview.files['/graph/index.html'],
      preview.files['/sitemap.xml'],
    ].join('\n');
    const allBuildArtifacts = JSON.stringify(preview.files);
    const unlisted = preview.files['/notes/unlisted-secret/index.html']!;

    expect(unlisted).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(unlisted).toContain(
      '<link rel="canonical" href="https://private-discovery.pages.dev/notes/unlisted-secret/">',
    );
    expect(preview.files['/notes/private-secret/index.html']).toBeUndefined();
    expect(publicArtifacts).toContain('Public A');
    expect(publicArtifacts).toContain('Public B');
    expect(publicArtifacts).toContain('/notes/public-a/');
    expect(publicArtifacts).toContain('/notes/public-b/');
    expect(publicArtifacts).not.toContain('Unlisted Strategy');
    expect(publicArtifacts).not.toContain('Unlisted body details.');
    expect(publicArtifacts).not.toContain('embedded unlisted alias');
    expect(publicArtifacts).not.toContain('Private Roadmap');
    expect(publicArtifacts).not.toContain('Private body details.');
    expect(publicArtifacts).not.toContain('/notes/unlisted-secret/');
    expect(publicArtifacts).not.toContain('/notes/private-secret/');
    expect(allBuildArtifacts).not.toContain('Private Roadmap');
    expect(allBuildArtifacts).not.toContain('Private body details.');
    expect(allBuildArtifacts).not.toContain('/notes/private-secret/');
  });

  it('omits disabled discovery pages, navigation entries, and indexes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-discovery-disabled-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Disabled discovery\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: disabled-discovery\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public\n\nSearchable only when enabled.\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const output = JSON.stringify(preview.files);

    expect(preview.files['/search/index.html']).toBeUndefined();
    expect(preview.files['/graph/index.html']).toBeUndefined();
    expect(preview.files['/index.html']).not.toContain('href="/search/"');
    expect(preview.files['/index.html']).not.toContain('href="/graph/"');
    expect(output).not.toContain('data-pages-search-index');
    expect(output).not.toContain('data-pages-graph');
    expect(preview.files['/sitemap.xml']).toContain(
      'https://disabled-discovery.pages.dev/notes/public/',
    );
  });

  it('uses the configured custom domain for public canonical and descriptive metadata', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-canonical-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Canonical\n  description: Site description\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: canonical-project\n  custom_domain: wiki.example.com\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'entry.md'),
      '---\npublication:\n  visibility: public\n  title: Canonical entry\n  summary: Article description\n---\n# Canonical entry\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/entry/index.html']!;

    expect(article).toContain(
      '<link rel="canonical" href="https://wiki.example.com/notes/entry/">',
    );
    expect(article).toContain(
      '<meta name="description" content="Article description">',
    );
    expect(article).not.toContain('<meta name="robots"');
  });

  it('includes every indexable canonical page and excludes unlisted pages from the sitemap', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-sitemap-routes-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
    await mkdir(join(vault, 'notes', 'hidden'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Sitemap routes\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: true\n  graph: true\ncloudflare:\n  project_name: sitemap-routes\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', 'entry.md'),
      '---\npublication:\n  visibility: public\n---\n# Entry\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'hidden', '_index.md'),
      '---\npublication:\n  visibility: unlisted\n---\n# Hidden section\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const sitemap = preview.files['/sitemap.xml']!;

    for (const path of [
      '/',
      '/privacy/',
      '/search/',
      '/graph/',
      '/notes/',
      '/notes/guides/',
      '/notes/guides/entry/',
    ]) {
      expect(sitemap).toContain(`https://sitemap-routes.pages.dev${path}`);
    }
    expect(sitemap).not.toContain('/notes/hidden/');
    expect(sitemap).not.toContain('/404/');
  });

  it('does not add an unlisted root index to the sitemap', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-unlisted-root-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Unlisted root\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: unlisted-root\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', '_index.md'),
      '---\npublication:\n  visibility: unlisted\n---\n# Unlisted home\n\nUnlisted root body.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public child\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.files['/index.html']).toContain(
      '<meta name="robots" content="noindex, nofollow">',
    );
    expect(preview.files['/sitemap.xml']).not.toContain(
      'https://unlisted-root.pages.dev/</loc>',
    );
    expect(preview.files['/sitemap.xml']).toContain(
      'https://unlisted-root.pages.dev/public/',
    );
  });
});
