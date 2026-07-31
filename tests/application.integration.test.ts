import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
});
