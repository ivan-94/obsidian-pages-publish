import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { prepareLocalPreviewFromDirectory } from './support/legacy-preview';

describe('built-in default site', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('builds a semantic home, automatic section, article, 404, and privacy page', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-default-site-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: 中文知识站',
        '  description: 可靠发布我的 Obsidian 笔记',
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
        '  project_name: default-site',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', 'start.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '  title: 开始使用',
        '---',
        '# 开始使用',
        '',
        '这是第一篇指南。',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(Object.keys(preview.files)).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/assets/default-theme.css',
        '/notes/guides/index.html',
        '/notes/guides/start/index.html',
        '/404/index.html',
        '/privacy/index.html',
      ]),
    );
    expect(preview.files['/index.html']).toContain('<header');
    expect(preview.files['/index.html']).toContain('<nav');
    expect(preview.files['/index.html']).toContain(
      '可靠发布我的 Obsidian 笔记',
    );
    expect(preview.files['/notes/guides/index.html']).toContain(
      '<h1>guides</h1>',
    );
    expect(preview.files['/notes/guides/index.html']).toContain(
      'href="/notes/guides/start/"',
    );
    expect(preview.files['/404/index.html']).toContain('<h1>页面未找到</h1>');
    expect(preview.files['/privacy/index.html']).toContain('<h1>隐私说明</h1>');
  });

  it('keeps long Chinese content, code, media, and navigation usable on narrow screens', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-responsive-site-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: 很长的中文知识库站点名称\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: responsive-site\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'long.md'),
      '---\npublication:\n  visibility: public\n  title: 这是一篇包含中英文MixedContentAndAnUnbrokenIdentifier的长标题\n---\n没有手写一级标题的正文。\n\n```text\nreally-long-code-line-without-breaks-abcdefghijklmnopqrstuvwxyz0123456789\n```\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/long/index.html']!;
    const theme = preview.files['/assets/default-theme.css']!;

    expect(article).toContain(
      '<link rel="stylesheet" href="/assets/default-theme.css">',
    );
    expect(article).toContain('<a class="skip-link" href="#content">跳到正文</a>');
    expect(article).toContain('<nav aria-label="主要导航">');
    expect(article).toContain(
      '<h1>这是一篇包含中英文MixedContentAndAnUnbrokenIdentifier的长标题</h1>',
    );
    expect(article.indexOf('<h1>')).toBeLessThan(article.indexOf('URL 预览'));
    expect(theme).toMatch(/color-scheme:\s*light dark/u);
    expect(theme).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(theme).toMatch(/pre[^}]*overflow-x:\s*auto/su);
    expect(theme).toMatch(/(?:img|svg)[^}]*max-width:\s*100%/su);
    expect(theme).toMatch(/@media\s*\(max-width:\s*40rem\)/u);
    expect(theme).toContain(':focus-visible');
  });

  it('combines a custom directory index with its public article list', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-custom-section-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Guides',
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
        '  project_name: custom-section',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', '_index.md'),
      '---\npublication:\n  visibility: public\n  kind: index\n  title: Guides overview\n---\n# Guides overview\n\nA hand-written section introduction.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', 'install.md'),
      '---\npublication:\n  visibility: public\n---\n# Install\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const section = preview.files['/notes/guides/index.html']!;

    expect(section).toContain('A hand-written section introduction.');
    expect(section).toContain('href="/notes/guides/install/"');
    expect(section).toContain('Install');
  });

  it('keeps an unlisted custom section out of home navigation while preserving its direct route', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-unlisted-section-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Hidden section\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: hidden-section\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', '_index.md'),
      '---\npublication:\n  visibility: unlisted\n  kind: index\n  title: Hidden guide landing\n---\n# Hidden guide landing\n\nDirect-link introduction.\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', 'public.md'),
      '---\npublication:\n  visibility: public\n---\n# Public child\n',
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const home = preview.files['/index.html']!;
    const directSection = preview.files['/notes/guides/index.html']!;

    expect(home).not.toContain('Hidden guide landing');
    expect(home).not.toContain('href="/notes/guides/"');
    expect(directSection).toContain('Direct-link introduction.');
    expect(directSection).toContain('href="/notes/guides/public/"');
  });

  it('projects sections or newest articles on home and orders section members', async () => {
    const createLayoutVault = async (layout: 'sections' | 'latest') => {
      const vault = await mkdtemp(join(tmpdir(), `pages-publish-${layout}-`));
      vaults.push(vault);
      await mkdir(join(vault, '.publish'), { recursive: true });
      await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
      await mkdir(join(vault, 'notes', 'journal'), { recursive: true });
      await writeFile(
        join(vault, '.publish', 'site.yml'),
        [
          'version: 1',
          'site:',
          `  name: ${layout} site`,
          `  home_layout: ${layout}`,
          'content_roots:',
          '  - path: notes',
          '    public_root: /notes',
          'assets:',
          '  exclude: []',
          'features:',
          '  search: false',
          '  graph: false',
          'cloudflare:',
          `  project_name: ${layout}-site`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(vault, 'notes', 'guides', 'a-old.md'),
        '---\npublication:\n  visibility: public\n  title: Older guide\n  date: 2025-01-01\n---\n# Older guide\n',
        'utf8',
      );
      await writeFile(
        join(vault, 'notes', 'guides', 'z-new.md'),
        '---\npublication:\n  visibility: public\n  title: Newer guide\n  date: 2026-01-01\n---\n# Newer guide\n',
        'utf8',
      );
      await writeFile(
        join(vault, 'notes', 'guides', 'pinned.md'),
        '---\npublication:\n  visibility: public\n  title: Pinned guide\n  date: 2024-01-01\n  order: 1\n---\n# Pinned guide\n',
        'utf8',
      );
      await writeFile(
        join(vault, 'notes', 'journal', 'entry.md'),
        '---\npublication:\n  visibility: public\n  title: Journal entry\n  date: 2025-06-01\n---\n# Journal entry\n',
        'utf8',
      );
      return vault;
    };

    const sectionsPreview = await prepareLocalPreviewFromDirectory(
      await createLayoutVault('sections'),
    );
    const latestPreview = await prepareLocalPreviewFromDirectory(
      await createLayoutVault('latest'),
    );
    const sectionsHome = sectionsPreview.files['/index.html']!;
    const latestHome = latestPreview.files['/index.html']!;
    const guides = sectionsPreview.files['/notes/guides/index.html']!;

    expect(sectionsHome).toContain('href="/notes/guides/"');
    expect(sectionsHome).toContain('href="/notes/journal/"');
    expect(sectionsHome).not.toContain('href="/notes/guides/z-new/"');
    expect(latestHome.indexOf('Newer guide')).toBeLessThan(
      latestHome.indexOf('Journal entry'),
    );
    expect(latestHome.indexOf('Journal entry')).toBeLessThan(
      latestHome.indexOf('Older guide'),
    );
    expect(guides.indexOf('Pinned guide')).toBeLessThan(
      guides.indexOf('Newer guide'),
    );
    expect(guides.indexOf('Newer guide')).toBeLessThan(
      guides.indexOf('Older guide'),
    );
  });

  it('renders the supported GFM, task, code, Callout, and Mermaid vocabulary', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-markdown-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Markdown\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: markdown\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'syntax.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Syntax',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| GFM | yes |',
        '',
        '- [x] Published safely',
        '- [ ] Review later',
        '',
        '```ts',
        'const answer = 42;',
        '```',
        '',
        '> [!NOTE] Publishing note',
        '> Callouts remain semantic.',
        '',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/syntax/index.html']!;

    expect(article).toContain('<table>');
    expect(article).toContain('type="checkbox"');
    expect(article).toContain('checked');
    expect(article).toContain('<code class="language-ts">');
    expect(article).toContain('data-callout="note"');
    expect(article).toContain('Publishing note');
    expect(article).toContain('data-pages-mermaid="true"');
    expect(article).toContain('<rect width="100%" height="100%" fill="#f8f4eb"/>');
    expect(article).toContain('<svg');
  });

  it('renders safe Mermaid to SVG and degrades active directives without active URLs', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-mermaid-safe-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Mermaid\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: mermaid-safe\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'diagram.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Diagram',
        '',
        '```mermaid',
        'flowchart LR',
        '  Write --> Preview --> Publish',
        '```',
        '',
        '```mermaid',
        '%%{init: {"securityLevel": "loose"}}%%',
        'flowchart LR',
        '  A --> B',
        '  click A "javascript:alert(1)"',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/diagram/index.html']!;

    expect(article).toContain('<svg');
    expect(article).toContain('data-pages-mermaid="true"');
    expect(article).toContain('<rect width="100%" height="100%" fill="#f8f4eb"/>');
    expect(article).toContain('data-pages-mermaid-fallback');
    expect(article).not.toMatch(/href=["']javascript:/iu);
    expect(article).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(article).not.toContain('<script');
    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'unsafe-mermaid-directive',
        path: 'notes/diagram.md',
        line: 13,
      }),
    );
  });

  it('reports a located Warning when Mermaid syntax falls back to source text', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-broken-mermaid-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Broken diagram\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: broken-diagram\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'broken.md'),
      '---\npublication:\n  visibility: public\n---\n# Broken\n\n```mermaid\nthis is not a supported diagram\n```\n',
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/broken/index.html']!;

    expect(article).toContain('data-pages-mermaid-fallback');
    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'mermaid-render-fallback',
        path: 'notes/broken.md',
        line: 7,
        column: 1,
      }),
    );
  });

  it('reports and visibly degrades unsupported Obsidian comments without leaking them', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-unsupported-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Unsupported\n  home_layout: latest\ncontent_roots:\n  - path: notes\n    public_root: /notes\nassets:\n  exclude: []\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: unsupported\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'comments.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Comments',
        '',
        'Before %%PRIVATE AUTHOR COMMENT',
        '',
        'STILL PRIVATE%% after.',
        '',
        '`%% syntax example %%`',
        '',
        '```text',
        '%% fenced syntax example %%',
        '```',
        '',
        'An unmatched ` marker in one paragraph.',
        '',
        '%%SECOND PRIVATE COMMENT%%',
        '',
        'Another unmatched ` marker in a different paragraph.',
        '',
        '> ~~~text',
        '> %% blockquote fenced example %%',
        '> ~~~',
        '',
        '>     %% blockquote indented example %%',
        '',
        '\\%% literal %% and trailing text remains.',
        '',
        'An unmatched ` before a heading.',
        '# Separate heading',
        '%%THIRD PRIVATE COMMENT%%',
        'Later unmatched ` after the heading.',
        '',
        '\\%% escaped opener without a closing pair',
        '# Escaped boundary',
        '%%FOURTH PRIVATE COMMENT%%',
        '',
        '| First | Second | Third |',
        '| --- | --- | --- |',
        '| unmatched ` | %%FIFTH PRIVATE COMMENT%% | later ` |',
        '| \\%% escaped opener | %%SIXTH PRIVATE COMMENT%% | tail |',
        '',
      ].join('\n'),
      'utf8',
    );

    const scan = await scanSiteFromDirectory(vault);
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const article = preview.files['/notes/comments/index.html']!;

    expect(scan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'unsupported-obsidian-comment',
        path: 'notes/comments.md',
        line: 7,
        column: 8,
      }),
    );
    expect(article).toContain('data-pages-unsupported-syntax');
    expect(article).toContain('Obsidian 注释已移除');
    expect(article).not.toContain('PRIVATE AUTHOR COMMENT');
    expect(article).not.toContain('STILL PRIVATE');
    expect(article).not.toContain('SECOND PRIVATE COMMENT');
    expect(article).not.toContain('THIRD PRIVATE COMMENT');
    expect(article).not.toContain('FOURTH PRIVATE COMMENT');
    expect(article).not.toContain('FIFTH PRIVATE COMMENT');
    expect(article).not.toContain('SIXTH PRIVATE COMMENT');
    expect(article).toContain('<code>%% syntax example %%</code>');
    expect(article).toContain('%% fenced syntax example %%');
    expect(article).toContain('%% blockquote fenced example %%');
    expect(article).toContain('%% blockquote indented example %%');
    expect(article).toContain('%% literal %% and trailing text remains.');
    expect(
      scan.issues.filter(
        (issue) => issue.code === 'unsupported-obsidian-comment',
      ),
    ).toHaveLength(6);
  });
});
