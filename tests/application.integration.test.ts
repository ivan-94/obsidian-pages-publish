import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PagesPublishApplication } from '../src/application';
import type { SiteScanResult } from '../src/content/site-scanner';
import type { SiteConfigV1 } from '../src/config/site-config';

describe('Pages Publish application', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('routes an unconfigured vault to setup and a configured vault to publish center', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const application = new PagesPublishApplication(vault);

    await expect(application.getLaunchTarget()).resolves.toBe('setup');

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
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(application.getLaunchTarget()).resolves.toBe('publish-center');
  });

  it('opens a real local preview through the external browser boundary', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
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
      ].join('\n'),
      'utf8',
    );
    const openedUrls: string[] = [];
    const application = new PagesPublishApplication(vault, (url) => {
      openedUrls.push(url);
    });

    const session = await application.openPreview();

    expect(openedUrls).toEqual([session.url]);
    const article = await fetch(`${session.url}notes/hello/`);
    expect(await article.text()).toContain('<h1>Hello Pages</h1>');
    await application.shutdown();
  });

  it('blocks preview when the latest scan reports a missing content root', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
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
        '  - path: missing-notes',
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
    const application = new PagesPublishApplication(vault);

    await expect(application.preparePreview()).rejects.toMatchObject({
      name: 'PublishingBlockedError',
      issues: [expect.objectContaining({ code: 'content-root-missing' })],
    });
  });

  it('creates the first local config and scans without opening a preview', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const openedUrls: string[] = [];
    const scanCalls: string[] = [];
    const application = new PagesPublishApplication(
      vault,
      (url) => openedUrls.push(url),
      {
        scan: async ({ trigger }) => {
          scanCalls.push(trigger);
          return {
            configRevision: 'config',
            digest: 'scan',
            candidates: [],
            issues: [],
          };
        },
      },
    );
    const draft: SiteConfigV1 = {
      version: 1,
      site: { name: 'New Wiki', homeLayout: 'sections' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'new-wiki' },
    };

    const created = await application.createInitialSiteConfig(draft, {
      systemTimezone: 'Asia/Shanghai',
    });

    expect(created.saved.config.site.timezone).toBe('Asia/Shanghai');
    await expect(application.getLaunchTarget()).resolves.toBe('publish-center');
    expect(scanCalls).toEqual(['config-save']);
    expect(openedUrls).toEqual([]);
  });

  it('never returns a stale scan result to an application caller', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const completions = new Map<number, (value: {
      configRevision: string;
      digest: string;
      candidates: [];
      issues: [];
    }) => void>();
    const scan = vi.fn(({ requestId }: { requestId: number }) => {
        if (requestId > 2) {
          return Promise.resolve({
            configRevision: `unexpected-${requestId}`,
            digest: `unexpected-${requestId}`,
            candidates: [] as [],
            issues: [] as [],
          });
        }
        return new Promise<SiteScanResult>((resolve) => {
          completions.set(requestId, resolve);
        });
      });
    const application = new PagesPublishApplication(vault, undefined, { scan });

    const older = application.requestScan('plugin-load');
    const newer = application.requestScan('manual-refresh');
    completions.get(2)?.({
      configRevision: 'two',
      digest: 'two',
      candidates: [],
      issues: [],
    });
    await expect(newer).resolves.toMatchObject({ status: 'applied' });
    completions.get(1)?.({
      configRevision: 'one',
      digest: 'one',
      candidates: [],
      issues: [],
    });
    await expect(older).resolves.toMatchObject({
      status: 'applied',
      value: { digest: 'two' },
    });
    expect(scan).toHaveBeenCalledTimes(2);
    await application.shutdown();
  });

  it('renders preview only between two matching fresh scan digests', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Stable Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: stable-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'hello.md'),
      '---\npublication:\n  visibility: public\n---\n# Hello\n',
      'utf8',
    );
    const digests = ['a', 'b', 'b', 'b'];
    const scan = vi.fn(async () => ({
      configRevision: 'config',
      digest: digests.shift() ?? 'b',
      candidates: [],
      issues: [],
    }));
    const application = new PagesPublishApplication(vault, undefined, { scan });

    const preview = await application.preparePreview();

    expect(preview.siteName).toBe('Stable Wiki');
    expect(scan).toHaveBeenCalledTimes(4);
    await application.shutdown();
  });

  it('reports a scan failure separately after an article intent was saved', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Save Then Scan',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: save-then-scan',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(vault, 'notes', 'draft.md'), '# Draft\n', 'utf8');
    const application = new PagesPublishApplication(vault, undefined, {
      scan: async () => {
        throw new Error('scan unavailable');
      },
    });
    const prepared = await application.prepareArticleIntentEdit(
      'notes/draft.md',
      { visibility: 'public' },
    );

    const result = await application.commitArticleIntentEdit(prepared);

    expect(result.saved.visibility.value).toBe('public');
    expect(result.scan).toBeUndefined();
    expect(result.scanError?.message).toBe('scan unavailable');
    await expect(
      application.getCurrentArticlePanel({ activePath: 'notes/draft.md' }),
    ).resolves.toMatchObject({
      status: 'article',
      metadata: { visibility: { value: 'public' } },
    });
    await application.shutdown();
  });

  it('preserves the known online URL when the article panel edits a deployed slug', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Redirect Wiki',
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
        '  project_name: redirect-wiki',
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
        '  slug: old',
        '  deployment:',
        '    url: /notes/old/',
        '---',
        '# Guide',
        '',
      ].join('\n'),
      'utf8',
    );
    const application = new PagesPublishApplication(vault, undefined, {
      scan: async () => ({
        configRevision: 'config',
        digest: 'scan',
        candidates: [],
        issues: [],
      }),
    });

    const prepared = await application.prepareArticleUrlIntentEdit(
      'notes/guide.md',
      'new',
    );

    expect(prepared.next.slug.value).toBe('new');
    expect(prepared.next.redirects.value).toEqual(['/notes/old/']);
    expect(prepared.current.deployment?.url).toBe('/notes/old/');
    await application.shutdown();
  });

  it('canonicalizes and deduplicates the deployed URL when preserving slug history', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Canonical Redirect Wiki',
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
        '  project_name: canonical-redirect-wiki',
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
        '  slug: old',
        '  redirects: [/notes/old/, /notes/%6Fld/]',
        '  deployment:',
        '    url: /notes/old',
        '---',
        '# Guide',
        '',
      ].join('\n'),
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    const prepared = await application.prepareArticleUrlIntentEdit(
      'notes/guide.md',
      'new',
    );

    expect(prepared.next.redirects.value).toEqual(['/notes/old/']);
    await application.shutdown();
  });

  it('canonicalizes redirect edits and rejects a system-route collision before writing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Redirect Editor Wiki',
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
        '  project_name: redirect-editor-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const source =
      '---\npublication:\n  visibility: public\n---\n# Guide\n';
    await writeFile(join(vault, 'notes', 'guide.md'), source, 'utf8');
    const application = new PagesPublishApplication(vault);

    const prepared = await application.prepareArticleRouteIntentEdit(
      'notes/guide.md',
      { kind: undefined, redirects: ['/notes/old', '/notes/%6Fld/'] },
    );

    expect(prepared.next.redirects.value).toEqual(['/notes/old/']);
    await expect(
      application.prepareArticleRouteIntentEdit('notes/guide.md', {
        redirects: ['/privacy/'],
      }),
    ).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'redirect-route-conflict' })],
    });
    await expect(readFile(join(vault, 'notes', 'guide.md'), 'utf8')).resolves.toBe(
      source,
    );
    await writeFile(
      join(vault, 'notes', 'private.md'),
      '---\npublication:\n  slug: guide\n---\n# Private\n',
      'utf8',
    );
    await expect(
      application.prepareArticleRouteIntentEdit('notes/private.md', {
        visibility: 'public',
      }),
    ).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'route-conflict' })],
    });
    await application.shutdown();
  });

  it('prepares a route edit despite unrelated malformed content and a missing root', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Resilient Route Edit',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        '  - path: absent',
        '    public_root: /absent',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: resilient-route-edit',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'current.md'),
      '---\npublication:\n  visibility: public\n  slug: old\n---\n# Current\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'broken.md'),
      '---\npublication: [\n---\n# Broken\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    const prepared = await application.prepareArticleUrlIntentEdit(
      'notes/current.md',
      'new',
    );

    expect(prepared.next.slug.value).toBe('new');
    await application.shutdown();
  });

  it('rejects a panel slug edit that conflicts with another article before writing Frontmatter', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Collision Wiki',
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
        '  project_name: collision-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const currentSource =
      '---\npublication:\n  visibility: public\n  slug: current\n---\n# Current\n';
    await writeFile(join(vault, 'notes', 'current.md'), currentSource, 'utf8');
    await writeFile(
      join(vault, 'notes', 'occupied.md'),
      '---\npublication:\n  visibility: public\n  slug: occupied\n---\n# Occupied\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    await expect(
      application.prepareArticleUrlIntentEdit('notes/current.md', 'occupied'),
    ).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'route-conflict' })],
    });
    await expect(readFile(join(vault, 'notes', 'current.md'), 'utf8')).resolves.toBe(
      currentSource,
    );
    await application.shutdown();
  });

  it('allows one route conflict group to be repaired while another existing group remains', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Repairable Collision Wiki',
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
        '  project_name: repairable-collision-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    for (const [filename, slug] of [
      ['a.md', 'first-conflict'],
      ['b.md', 'first-conflict'],
      ['c.md', 'second-conflict'],
      ['d.md', 'second-conflict'],
    ] as const) {
      await writeFile(
        join(vault, 'notes', filename),
        `---\npublication:\n  visibility: public\n  slug: ${slug}\n---\n# ${filename}\n`,
        'utf8',
      );
    }
    const application = new PagesPublishApplication(vault);

    const prepared = await application.prepareArticleUrlIntentEdit(
      'notes/a.md',
      'repaired',
    );

    expect(prepared.next.slug.value).toBe('repaired');
    await application.shutdown();
  });

  it('allows independent blockers on one article to be repaired one field at a time', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Incremental Repair Wiki',
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
        '  project_name: incremental-repair-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'a.md'),
      '---\npublication:\n  visibility: public\n  slug: collision\n  redirects: [/privacy/]\n---\n# A\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'b.md'),
      '---\npublication:\n  visibility: public\n  slug: collision\n---\n# B\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    const repairedSlug = await application.prepareArticleUrlIntentEdit(
      'notes/a.md',
      'unique',
    );
    const repairedRedirect = await application.prepareArticleRouteIntentEdit(
      'notes/a.md',
      { redirects: [] },
    );

    expect(repairedSlug.next.slug.value).toBe('unique');
    expect(repairedSlug.next.redirects.value).toEqual(['/privacy/']);
    expect(repairedRedirect.next.slug.value).toBe('collision');
    expect(repairedRedirect.next.redirects.value).toEqual([]);
    await application.shutdown();
  });

  it('preserves the known online URL when the panel changes article kind to an index', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes', 'guides'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Kind Wiki',
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
        '  project_name: kind-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'guides', 'page.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '  deployment:',
        '    url: /notes/guides/page/',
        '---',
        '# Page',
        '',
      ].join('\n'),
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    const prepared = await application.prepareArticleRouteIntentEdit(
      'notes/guides/page.md',
      { kind: 'index', redirects: undefined },
    );

    expect(prepared.next.kind.value).toBe('index');
    expect(prepared.next.redirects.value).toEqual(['/notes/guides/page/']);
    await application.shutdown();
  });

  it('invalidates current-article subscribers on Vault or config changes until unsubscribed', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const application = new PagesPublishApplication(vault, undefined, {
      scan: async () => ({
        configRevision: 'config',
        digest: 'scan',
        candidates: [],
        issues: [],
      }),
      scanDebounceMs: 0,
    });
    const invalidated = vi.fn();
    const unsubscribe = application.subscribeCurrentArticleChanges(invalidated);

    application.notifyFileChange();
    expect(invalidated).toHaveBeenCalledTimes(1);
    unsubscribe();
    application.notifyFileChange();
    expect(invalidated).toHaveBeenCalledTimes(1);
    await application.shutdown();
  });

  it('opens the selected private Unicode-slug article without an unrelated whole-site scan', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Article Preview',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: article-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'private-draft.md'),
      '\uFEFF---\r\nowner: Ivan\r\npublication:\r\n  slug: 中文 空格\r\n  deployment:\r\n    deployment_id: must-not-render\r\n---\r\n# Private preview only\r\n',
      'utf8',
    );
    const openedUrls: string[] = [];
    const scan = vi.fn(async () => {
      throw new Error('unrelated article blocker');
    });
    const application = new PagesPublishApplication(
      vault,
      (url) => openedUrls.push(url),
      { scan },
    );

    const session = await application.openArticlePreview(
      'notes/private-draft.md',
    );

    expect(openedUrls).toEqual([session.articleUrl]);
    expect(session.articleUrl).toMatch(
      /\/notes\/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC\/$/,
    );
    const response = await fetch(session.articleUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<h1>Private preview only</h1>');
    expect(html).not.toContain('deployment_id');
    expect(html).not.toContain('owner: Ivan');
    expect(scan).not.toHaveBeenCalled();
    await application.shutdown();
  });

  it('uses the global route plan for a single-article preview', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Global Route Preview',
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
        '  project_name: global-route-preview',
        '',
      ].join('\n'),
      'utf8',
    );
    const source =
      '---\npublication:\n  visibility: public\n  slug: collision\n---\n# Page\n';
    await writeFile(join(vault, 'notes', 'one.md'), source, 'utf8');
    await writeFile(join(vault, 'notes', 'two.md'), source, 'utf8');
    const application = new PagesPublishApplication(vault);

    await expect(
      application.openArticlePreview('notes/one.md'),
    ).rejects.toMatchObject({
      name: 'RoutePlanningError',
      issues: [expect.objectContaining({ code: 'route-conflict' })],
    });
    await application.shutdown();
  });
});
