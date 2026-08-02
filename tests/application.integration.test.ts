import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PagesPublishApplication } from '../src/application';
import { DeploymentFactsCoordinator, FileSystemDeploymentStateStore } from '../src/publication/deployment-facts';
import {
  BoundedDiagnosticLog,
  PagesPublishMaintenanceService,
} from '../src/maintenance/maintenance-service';
import { scanSiteFromDirectory, type SiteScanResult } from '../src/content/site-scanner';
import type { SiteConfigV1 } from '../src/config/site-config';
import { loadSiteConfigFromDirectory } from '../src/config/site-config';
import {
  SiteSetupService,
  type SetupDraft,
} from '../src/setup/site-setup';

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

  it('checks a configured custom-domain status only through an explicit host boundary', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const inspect = vi.fn(async () => ({
      state: 'pending' as const,
      hostname: 'docs.example.com',
    }));
    const application = new PagesPublishApplication(vault, undefined, {
      customDomainStatus: { inspect },
    });

    await expect(application.inspectConfiguredCustomDomain()).resolves.toEqual({
      state: 'pending',
      hostname: 'docs.example.com',
    });
    expect(inspect).toHaveBeenCalledOnce();
    await expect(new PagesPublishApplication(vault).inspectConfiguredCustomDomain()).resolves.toEqual({
      state: 'unavailable',
    });
  });

  it('reuses a checked Cloudflare connection until the user explicitly checks again', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const refreshStatus = vi.fn(async () => ({
      state: 'connected' as const,
      account: { id: 'account-1', name: 'Personal' },
    }));
    const application = new PagesPublishApplication(vault, undefined, {
      setup: {} as never,
      setupConnection: {
        refreshStatus,
        listAvailableAccounts: async () => [],
      },
    });

    await expect(application.getInitialSetupConnection()).resolves.toMatchObject({
      state: 'connected',
    });
    await expect(application.getInitialSetupConnection()).resolves.toMatchObject({
      state: 'connected',
    });
    expect(refreshStatus).toHaveBeenCalledOnce();

    await application.getInitialSetupConnection({ forceRefresh: true });
    expect(refreshStatus).toHaveBeenCalledTimes(2);
    await application.shutdown();
  });

  it('refreshes a cached Cloudflare connection after five minutes of inactivity', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-02T08:00:00.000Z'));
      const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
      vaults.push(vault);
      const refreshStatus = vi.fn(async () => ({ state: 'connected' as const }));
      const application = new PagesPublishApplication(vault, undefined, {
        setup: {} as never,
        setupConnection: { refreshStatus, listAvailableAccounts: async () => [] },
      });

      await application.getInitialSetupConnection();
      vi.advanceTimersByTime(5 * 60 * 1000);
      await application.getInitialSetupConnection();

      expect(refreshStatus).toHaveBeenCalledTimes(2);
      await application.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a cached connection when an explicit connect or account change succeeds', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const disconnected = { state: 'disconnected' as const };
    const personal = {
      state: 'connected' as const,
      account: { id: 'account-1', name: 'Personal' },
    };
    const work = {
      state: 'connected' as const,
      account: { id: 'account-2', name: 'Work' },
    };
    const refreshStatus = vi.fn(async () => disconnected);
    const application = new PagesPublishApplication(vault, undefined, {
      setup: {} as never,
      setupConnection: {
        refreshStatus,
        listAvailableAccounts: async () => [],
        connectApiToken: async () => personal,
        selectAccount: async () => work,
      },
    });

    await application.getInitialSetupConnection();
    await application.connectInitialSetupApiToken('token-secret');
    await expect(application.getInitialSetupConnection()).resolves.toEqual(personal);
    await application.selectInitialSetupAccount('account-2');
    await expect(application.getInitialSetupConnection()).resolves.toEqual(work);
    expect(refreshStatus).toHaveBeenCalledOnce();
    await application.shutdown();
  });

  it('projects scans into global feedback without treating idle work as a notification', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), 'configured', 'utf8');
    let completeScan!: (value: SiteScanResult) => void;
    const application = new PagesPublishApplication(vault, undefined, {
      scan: async () => new Promise<SiteScanResult>((resolve) => {
        completeScan = resolve;
      }),
    });
    const updates = vi.fn();
    const unsubscribe = application.subscribeGlobalUiState(updates);

    const scan = application.requestScan('manual-refresh');
    await expect(application.getGlobalUiState()).resolves.toEqual({
      ribbon: { route: 'publish-center', tooltip: '正在扫描发布内容' },
      statusBar: { route: 'publish-center', text: 'Pages：正在扫描…' },
    });
    completeScan({
      configRevision: 'revision',
      digest: 'digest',
      candidates: [],
      issues: [{
        severity: 'blocker',
        code: 'content-root-missing',
        path: 'content_roots[0].path',
        message: 'Configured content root is missing; publishing is blocked.',
      }],
    });
    await scan;

    await expect(application.getGlobalUiState()).resolves.toEqual({
      ribbon: { route: 'publish-center', tooltip: '打开发布中心：1 个阻塞' },
      statusBar: { route: 'publish-center', text: 'Pages：1 个阻塞' },
    });
    expect(updates).toHaveBeenCalled();
    unsubscribe();
    await application.shutdown();
  });

  it('records only structured scan outcomes for local diagnostics', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const diagnosticLog = new BoundedDiagnosticLog();
    const application = new PagesPublishApplication(vault, undefined, {
      diagnosticLog,
      scan: async () => ({
        configRevision: 'revision',
        digest: 'digest',
        candidates: [{
          sourcePath: 'private/secret.md',
          contentRootPath: 'private',
          sourceDigest: 'digest',
        }],
        issues: [
          {
            severity: 'blocker',
            code: 'content-root-missing',
            path: 'private/secret.md',
            message: 'Do not put this message in the local diagnostic log.',
          },
          {
            severity: 'warning',
            code: 'unsupported-asset',
            path: 'private/secret.png',
            message: 'Do not put this message in the local diagnostic log.',
          },
        ],
      }),
    });

    await application.requestScan('manual-refresh');

    const [entry] = diagnosticLog.entries();
    expect(entry).toMatchObject({
      stage: 'scan',
      code: 'scan-complete',
      counts: { candidates: 1, blockers: 1, warnings: 1 },
    });
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(JSON.stringify(diagnosticLog.entries())).not.toContain('private/secret');
    expect(JSON.stringify(diagnosticLog.entries())).not.toContain('Must not be logged');
    await application.shutdown();
  });

  it('continues a scan when the optional diagnostic sink fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const append = vi.fn(() => {
      throw new Error('diagnostic storage unavailable');
    });
    const application = new PagesPublishApplication(vault, undefined, {
      diagnosticLog: { append },
      scan: async () => ({
        configRevision: 'revision',
        digest: 'digest',
        candidates: [],
        issues: [],
      }),
    });

    await expect(application.requestScan('manual-refresh')).resolves.toMatchObject({
      status: 'applied',
      value: { digest: 'digest' },
    });
    expect(append).toHaveBeenCalledOnce();
    await application.shutdown();
  });

  it('exposes user-requested maintenance actions without treating them as ordinary configuration saves', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const clear = vi.fn(async () => undefined);
    const maintenance = new PagesPublishMaintenanceService({
      cache: { clear },
      diagnostics: {
        collect: async () => ({ pluginVersion: '0.1.0', platform: 'darwin', logs: [] }),
        write: async () => '/tmp/diagnostics.json',
      },
    });
    const application = new PagesPublishApplication(vault, undefined, { maintenance });

    expect(application.getMaintenanceStatus()).toMatchObject({ cache: { state: 'ready' } });
    await application.clearRebuildableCache();
    await expect(application.exportDiagnostics({ confirmed: true })).resolves.toEqual({
      path: '/tmp/diagnostics.json',
    });
    expect(clear).toHaveBeenCalledTimes(1);
    await application.shutdown();
  });

  it('exposes final setup confirmation through the application and then enters publish center', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const setup = new SiteSetupService(vault, {
      projects: {
        findProject: async () => undefined,
        createProject: async () => ({
          id: 'project-1',
          name: 'setup-wiki',
          accountId: 'account-1',
          pagesDevUrl: 'https://setup-wiki.pages.dev',
          compatible: true,
        }),
        verifyProject: async (project) => project,
        ensureCustomDomain: async () => ({ status: 'pending' as const }),
      },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });
    const application = new PagesPublishApplication(vault, undefined, { setup });
    const draft: SetupDraft = {
      config: {
        version: 1,
        site: { name: 'Setup wiki', homeLayout: 'sections', timezone: 'Asia/Shanghai' },
        contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
        assets: { exclude: [] },
        features: { search: true, graph: true },
        cloudflare: { projectName: 'setup-wiki' },
      },
      cloudflare: {
        account: { id: 'account-1', name: 'Personal' },
        action: 'create',
        projectName: 'setup-wiki',
        domain: { kind: 'pages-dev' },
      },
    };

    await expect(application.reviewInitialSetup(draft)).resolves.toMatchObject({
      candidateCount: 0,
      cloudflare: { projectName: 'setup-wiki' },
    });
    await expect(application.confirmInitialSetup(draft)).resolves.toMatchObject({
      stage: 'ready',
      project: { id: 'project-1' },
    });
    await expect(application.getLaunchTarget()).resolves.toBe('publish-center');
    await application.shutdown();
  });

  it('does not turn a completed setup into failure when a redundant coordinator refresh fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const setup = new SiteSetupService(vault, {
      projects: {
        findProject: async () => undefined,
        createProject: async () => ({
          id: 'project-1',
          name: 'setup-wiki',
          accountId: 'account-1',
          pagesDevUrl: 'https://setup-wiki.pages.dev',
          compatible: true,
        }),
        verifyProject: async (project) => project,
        ensureCustomDomain: async () => ({ status: 'pending' as const }),
      },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });
    const application = new PagesPublishApplication(vault, undefined, {
      setup,
      scan: async () => {
        throw new Error('late refresh failed');
      },
    });
    const draft: SetupDraft = {
      config: {
        version: 1,
        site: { name: 'Setup wiki', homeLayout: 'sections', timezone: 'Asia/Shanghai' },
        contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
        assets: { exclude: [] },
        features: { search: true, graph: true },
        cloudflare: { projectName: 'setup-wiki' },
      },
      cloudflare: {
        account: { id: 'account-1', name: 'Personal' },
        action: 'create',
        projectName: 'setup-wiki',
        domain: { kind: 'pages-dev' },
      },
    };

    await expect(application.confirmInitialSetup(draft)).resolves.toMatchObject({
      stage: 'ready',
    });
    await expect(application.getLaunchTarget()).resolves.toBe('publish-center');
    await application.shutdown();
  });

  it('projects a connected nonsecret Cloudflare account and existing projects for the setup wizard', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const setup = new SiteSetupService(vault, {
      projects: {
        findProject: async () => undefined,
        listProjects: async () => [{
          id: 'project-existing',
          name: 'existing-wiki',
          accountId: 'account-1',
          pagesDevUrl: 'https://existing-wiki.pages.dev',
          compatible: true,
        }],
        createProject: async () => {
          throw new Error('not expected');
        },
        verifyProject: async (project) => project,
        ensureCustomDomain: async () => ({ status: 'pending' as const }),
      },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });
    const application = new PagesPublishApplication(vault, undefined, {
      setup,
      setupConnection: {
        refreshStatus: async () => ({
          state: 'connected' as const,
          account: { id: 'account-1', name: 'Personal' },
        }),
        listAvailableAccounts: async () => [{ id: 'account-1', name: 'Personal' }],
      },
    });

    await expect(application.getInitialSetupConnection()).resolves.toEqual({
      state: 'connected',
      account: { id: 'account-1', name: 'Personal' },
    });
    await expect(application.listInitialSetupProjects({ id: 'account-1', name: 'Personal' }))
      .resolves.toEqual([expect.objectContaining({ name: 'existing-wiki' })]);
    await application.shutdown();
  });

  it('rebinds a configured site only after verifying the project in the connected account', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Rebind wiki',
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
      '  project_name: old-project',
      '',
    ].join('\n'), 'utf8');
    const createProject = vi.fn();
    const findProject = vi.fn(async ({ projectName }: { projectName: string }) => ({
      id: 'project-new',
      name: projectName,
      accountId: 'account-1',
      pagesDevUrl: `https://${projectName}.pages.dev`,
      compatible: true,
    }));
    const setup = new SiteSetupService(vault, {
      projects: {
        findProject,
        createProject,
        verifyProject: async (project) => project,
        ensureCustomDomain: async () => ({ status: 'pending' as const }),
      },
    });
    const application = new PagesPublishApplication(vault, undefined, {
      setup,
      setupConnection: {
        refreshStatus: async () => ({
          state: 'connected' as const,
          account: { id: 'account-1', name: 'Personal' },
        }),
        listAvailableAccounts: async () => [{ id: 'account-1', name: 'Personal' }],
      },
    });

    await expect(application.bindConfiguredProject('new-project')).resolves.toMatchObject({
      name: 'new-project',
      accountId: 'account-1',
    });
    const loaded = await loadSiteConfigFromDirectory(vault);
    expect(loaded).toMatchObject({
      status: 'editable',
      config: { cloudflare: { projectName: 'new-project' } },
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('exposes explicit API-token connection and account-selection actions to the setup UI', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const connectApiToken = vi.fn(async () => ({
      state: 'connected' as const,
      account: { id: 'account-1', name: 'Personal' },
    }));
    const selectAccount = vi.fn(async () => ({
      state: 'connected' as const,
      account: { id: 'account-2', name: 'Work' },
    }));
    const application = new PagesPublishApplication(vault, undefined, {
      setupConnection: {
        refreshStatus: async () => ({ state: 'disconnected' as const }),
        listAvailableAccounts: async () => [
          { id: 'account-1', name: 'Personal' },
          { id: 'account-2', name: 'Work' },
        ],
        connectApiToken,
        selectAccount,
      },
    });

    expect(application.canConnectInitialSetupApiToken()).toBe(true);
    expect(application.canSelectInitialSetupAccount()).toBe(true);
    await expect(application.connectInitialSetupApiToken('token-secret')).resolves.toEqual({
      state: 'connected',
      account: { id: 'account-1', name: 'Personal' },
    });
    await expect(application.selectInitialSetupAccount('account-2')).resolves.toEqual({
      state: 'connected',
      account: { id: 'account-2', name: 'Work' },
    });
    expect(connectApiToken).toHaveBeenCalledWith('token-secret');
    expect(selectAccount).toHaveBeenCalledWith('account-2');
    await application.shutdown();
  });

  it('opens the known online page for an article that moved outside content roots', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'guide'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Online Wiki',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'features:',
      '  search: false',
      '  graph: false',
      'cloudflare:',
      '  project_name: online-wiki',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(vault, 'guide', 'online.md'), [
      '---',
      'publication:',
      '  visibility: public',
      '  deployment:',
      '    url: https://online-wiki.pages.dev/notes/online/',
      '---',
      '# Online',
      '',
    ].join('\n'), 'utf8');
    const openExternal = vi.fn();
    const application = new PagesPublishApplication(vault, openExternal);

    await expect(application.openArticleOnlinePage('guide/online.md'))
      .resolves.toBe('https://online-wiki.pages.dev/notes/online/');
    expect(openExternal).toHaveBeenCalledWith('https://online-wiki.pages.dev/notes/online/');
  });

  it('reports a site publication failure without replacing the article deployment state', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Failed Publish Wiki',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'features:',
      '  search: false',
      '  graph: false',
      'cloudflare:',
      '  project_name: failed-publish-wiki',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(vault, 'notes', 'draft.md'),
      '---\npublication:\n  visibility: public\n---\n# Draft\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault, undefined, {
      deploymentAdapter: {
        validate: async () => undefined,
        upload: async () => {
          throw new Error('upload failed');
        },
        activate: async () => {
          throw new Error('must not activate');
        },
      },
    });

    await expect(application.publishSite()).rejects.toThrow('upload failed');
    await expect(application.getCurrentArticlePanel({ activePath: 'notes/draft.md' }))
      .resolves.toMatchObject({
        status: 'article',
        publicationState: 'pending-first-publish',
        sitePublicationFailed: true,
      });
  });

  it('opens the Cloudflare authorization URL only through an explicit OAuth setup action', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const openExternal = vi.fn();
    const prepareOAuthCallback = vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:8977/oauth/callback',
    }));
    const beginOAuth = vi.fn(async () => ({
      url: 'https://dash.cloudflare.com/oauth2/auth?state=one-time',
    }));
    const application = new PagesPublishApplication(vault, openExternal, {
      setupConnection: {
        refreshStatus: async () => ({ state: 'disconnected' }),
        listAvailableAccounts: async () => [],
        isOAuthAvailable: () => true,
        beginOAuth,
        completeOAuth: async () => ({ state: 'connected' }),
      },
      oauthCallback: { start: prepareOAuthCallback },
    });

    expect(application.canConnectInitialSetupOAuth()).toBe(true);
    await application.beginInitialSetupOAuth();

    expect(beginOAuth).toHaveBeenCalledOnce();
    expect(beginOAuth).toHaveBeenCalledWith({
      redirectUri: 'http://127.0.0.1:8977/oauth/callback',
    });
    expect(openExternal).toHaveBeenCalledWith(
      'https://dash.cloudflare.com/oauth2/auth?state=one-time',
    );
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
    expect(application.getPreviewStatus()).toEqual({
      state: 'running',
      url: session.url,
    });
    const article = await fetch(`${session.url}notes/hello/`);
    expect(await article.text()).toContain('<h1>Hello Pages</h1>');
    await application.shutdown();
    expect(application.getPreviewStatus()).toEqual({ state: 'stopped' });
  });

  it('shows a selected local article as an added change in the publish center', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Publish Center Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: publish-center-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# Release notes\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    await expect(application.getPublishCenter()).resolves.toMatchObject({
      siteName: 'Publish Center Wiki',
      baseline: 'first-publish',
      canPublish: true,
      summary: { changes: 1, added: 1, blockers: 0, warnings: 0 },
      articles: [
        expect.objectContaining({
          sourcePath: 'notes/release.md',
          title: 'Release notes',
          nextIncluded: true,
          change: 'added',
        }),
      ],
    });
    await application.shutdown();
  });

  it('reuses the publish-center snapshot until a Vault change invalidates it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Cached Center\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: cached-center\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# Cached release\n',
      'utf8',
    );
    const scan = vi.fn(({ signal }: { signal?: AbortSignal }) =>
      scanSiteFromDirectory(vault, { signal }),
    );
    const application = new PagesPublishApplication(vault, undefined, { scan });

    const first = await application.getPublishCenter();
    expect(scan).toHaveBeenCalledTimes(3);

    const cached = await application.getPublishCenter();
    expect(cached).toBe(first);
    expect(scan).toHaveBeenCalledTimes(3);

    application.notifyFileChange();
    const refreshed = await application.getPublishCenter();
    expect(refreshed).not.toBe(first);
    expect(scan).toHaveBeenCalledTimes(6);
    await application.shutdown();
  });

  it('does not cache a publish-center snapshot built across a Vault change', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Concurrent Center\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: concurrent-center\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# Concurrent release\n',
      'utf8',
    );
    let calls = 0;
    let releaseScan!: () => void;
    const scan = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      calls += 1;
      if (calls === 4) {
        await new Promise<void>((resolve) => {
          releaseScan = resolve;
        });
      }
      return scanSiteFromDirectory(vault, { signal });
    });
    const application = new PagesPublishApplication(vault, undefined, { scan });

    await application.getPublishCenter();
    const refreshing = application.getPublishCenter({ forceRefresh: true });
    await vi.waitFor(() => expect(calls).toBe(4));
    application.notifyFileChange();
    releaseScan();
    const crossedChange = await refreshing;

    const afterChange = await application.getPublishCenter();
    expect(afterChange).not.toBe(crossedChange);
    expect(calls).toBe(9);
    await application.shutdown();
  });

  it('shows an existing deployment as unknown until the complete deployment manifest is available', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Existing Deployment\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: existing-deployment\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'online.md'),
      '---\npublication:\n  visibility: public\n  deployment:\n    url: /notes/online/\n    source_digest: previous\n---\n# Existing online article\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    await expect(application.getPublishCenter()).resolves.toMatchObject({
      baseline: 'unknown',
      articles: [expect.objectContaining({ change: 'unknown' })],
    });
    await application.shutdown();
  });

  it('freezes a publish snapshot so edits made afterwards remain pending for the next version', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Snapshot Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: snapshot-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const articlePath = join(vault, 'notes', 'release.md');
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: public\n---\n# First version\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    const snapshot = await application.preparePublishSnapshot();
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: public\n---\n# Second version\n',
      'utf8',
    );

    expect(snapshot.files['/notes/release/index.html']).toContain('First version');
    expect(snapshot.files['/notes/release/index.html']).not.toContain('Second version');
    expect(snapshot.files['/notes/release/index.html']).not.toContain(
      'data-pages-preview="local"',
    );
    expect(snapshot.files['/notes/release/index.html']).not.toContain('URL 预览');
    expect(snapshot.scanDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(application.getPreparedPublishSnapshot()).toBe(snapshot);
    await application.shutdown();
  });

  it('revalidates and publishes a fresh site snapshot through the Pages deployment boundary', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Deploy Wiki\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: deploy-wiki\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# First version\n',
      'utf8',
    );
    const stages: string[] = [];
    const diagnosticEntries = new BoundedDiagnosticLog();
    const diagnosticLog = {
      append: (entry: import('../src/maintenance/maintenance-service').SafeDiagnosticLogEntry) => {
        diagnosticEntries.append(entry);
        if (entry.code === 'upload-started') {
          throw new Error('diagnostic storage unavailable');
        }
      },
    };
    const application = new PagesPublishApplication(vault, undefined, {
      diagnosticLog,
      deploymentAdapter: {
        validate: async () => {
          stages.push('prepare:validate');
        },
        upload: async (input) => {
          stages.push(`upload:${input.scanDigest}`);
          expect(input.files['/notes/release/index.html']).toContain('First version');
          expect(input.files['/notes/release/index.html']).not.toContain(
            'data-pages-preview="local"',
          );
          expect(input.files['/notes/release/index.html']).not.toContain('URL 预览');
          return { deploymentId: 'deployment-1' };
        },
        activate: async (input) => {
          stages.push(`activate:${input.deploymentId}`);
          return { deploymentId: input.deploymentId, url: 'https://deploy-wiki.pages.dev' };
        },
      },
    });

    await expect(application.publishSite()).resolves.toMatchObject({
      deploymentId: 'deployment-1',
      url: 'https://deploy-wiki.pages.dev',
    });
    expect(stages).toEqual([
      'prepare:validate',
      expect.stringMatching(/^upload:[a-f0-9]{64}$/),
      'activate:deployment-1',
    ]);
    expect(application.getPublicationStatus()).toMatchObject({
      state: 'succeeded',
      stage: 'activate',
    });
    expect(diagnosticEntries.entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'maintenance', code: 'publication-preparing' }),
      expect.objectContaining({ stage: 'build', code: 'build-started' }),
      expect.objectContaining({ stage: 'upload', code: 'upload-started' }),
      expect.objectContaining({ stage: 'activate', code: 'activate-started' }),
      expect.objectContaining({ stage: 'activate', code: 'activation-complete' }),
    ]));
    const activationLog = diagnosticEntries.entries().find((entry) =>
      entry.code === 'activation-complete',
    );
    expect(activationLog?.counts?.files).toBeTypeOf('number');
    await application.shutdown();
  });

  it('records the activated deployment as the next complete baseline so an explicit private change becomes a takedown', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    const stateDirectory = await mkdtemp(join(tmpdir(), 'pages-publish-state-'));
    vaults.push(vault, stateDirectory);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Deploy Facts Wiki\n  home_layout: sections\n  timezone: Asia/Shanghai\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: deploy-facts-wiki\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# First version\n',
      'utf8',
    );
    let deploymentNumber = 0;
    const application = new PagesPublishApplication(vault, undefined, {
      deploymentFacts: new DeploymentFactsCoordinator({
        vaultRoot: vault,
        store: new FileSystemDeploymentStateStore(stateDirectory),
        now: () => new Date('2026-08-01T02:20:30.000Z'),
      }),
      deploymentAdapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: `deployment-${++deploymentNumber}` }),
        activate: async (input) => ({
          deploymentId: input.deploymentId,
          url: 'https://deploy-facts-wiki.pages.dev',
        }),
      },
    });

    await expect(application.getPublishCenter()).resolves.toMatchObject({
      baseline: 'first-publish',
    });
    await application.publishSite();
    await expect(readFile(join(vault, 'notes', 'release.md'), 'utf8')).resolves.toContain(
      'deployment_id: deployment-1',
    );
    await expect(application.getPublishCenter()).resolves.toMatchObject({
      baseline: 'available',
      summary: { changes: 0 },
    });
    await application.setPublishCenterInclusion('notes/release.md', false, {
      confirmTakedown: true,
    });
    const beforeTakedown = await application.getPublishCenter();

    expect(beforeTakedown.baseline).toBe('available');
    expect(beforeTakedown.articles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: 'notes/release.md',
        change: 'takedown',
        onlineUrl: '/notes/release/',
      }),
    ]));
    await application.publishSite();
    const sourceAfterTakedown = await readFile(join(vault, 'notes', 'release.md'), 'utf8');
    expect(sourceAfterTakedown).toContain('first_published_at: 2026-08-01T10:20:30+08:00');
    expect(sourceAfterTakedown).not.toContain('url: /notes/release/');
    expect(sourceAfterTakedown).not.toContain('source_digest:');
    expect(sourceAfterTakedown).not.toContain('last_published_at:');
    expect(sourceAfterTakedown).not.toContain('deployment_id:');
    await expect(application.getPublishCenter()).resolves.toMatchObject({
      baseline: 'available',
      summary: { changes: 0 },
    });
    await application.shutdown();
  });

  it('hydrates a pending recovery after restart, then unlocks publication after remote verification', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    const stateDirectory = await mkdtemp(join(tmpdir(), 'pages-publish-state-'));
    vaults.push(vault, stateDirectory);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Recovery Wiki\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: recovery-wiki\n',
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'release.md'),
      '---\npublication:\n  visibility: public\n---\n# Recoverable release\n',
      'utf8',
    );
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    let allowLocalFacts = false;
    let deploymentNumber = 0;
    const createApplication = (): PagesPublishApplication => new PagesPublishApplication(vault, undefined, {
      deploymentFacts: new DeploymentFactsCoordinator({
        vaultRoot: vault,
        store,
        writeFacts: async (input) => {
          if (!allowLocalFacts) throw new Error('simulated local interruption');
          await input.defaultWrite();
        },
      }),
      deploymentAdapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: `deployment-${++deploymentNumber}` }),
        activate: async (input) => ({
          deploymentId: input.deploymentId,
          url: 'https://recovery-wiki.pages.dev',
        }),
      },
    });
    const first = createApplication();

    await expect(first.publishSite()).rejects.toThrow('local publishing facts need repair');
    await first.shutdown();
    const restarted = createApplication();
    await expect(restarted.hydratePublicationFacts()).rejects.toThrow('local publishing facts need repair');
    expect(restarted.getPublicationStatus()).toMatchObject({ state: 'reconciliation-required' });

    allowLocalFacts = true;
    await restarted.recoverPublicationFacts({
      inspect: async (deploymentId) => ({
        deploymentId,
        url: 'https://recovery-wiki.pages.dev',
        status: 'success',
      }),
    });
    expect(restarted.getPublicationStatus()).toEqual({ state: 'idle' });
    await expect(restarted.publishSite()).resolves.toMatchObject({ deploymentId: 'deployment-2' });
    await restarted.shutdown();
  });

  it('requires explicit confirmation before a publish-center checkbox schedules an online article for takedown', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Checkbox Wiki\n  home_layout: sections\ncontent_roots:\n  - path: notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: checkbox-wiki\n',
      'utf8',
    );
    const articlePath = join(vault, 'notes', 'online.md');
    await writeFile(
      articlePath,
      '---\npublication:\n  visibility: public\n  deployment:\n    url: /notes/online/\n---\n# Online article\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    await expect(
      application.setPublishCenterInclusion('notes/online.md', false),
    ).rejects.toMatchObject({ name: 'ArticleIntentConfirmationRequiredError' });
    await application.setPublishCenterInclusion('notes/online.md', false, {
      confirmTakedown: true,
    });

    await expect(readFile(articlePath, 'utf8')).resolves.toContain('visibility: private');
    await application.shutdown();
  });

  it('extracts external link candidates and checks them only through the manual application action', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: External Link Check',
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
        '  project_name: external-link-check',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'source.md'),
      '---\npublication:\n  visibility: public\n---\n# Source\n\n[Broken service](https://public.example/broken)\n',
      'utf8',
    );
    const fetchBoundary = vi.fn(async () =>
      new Response(undefined, { status: 503 }),
    );
    const application = new PagesPublishApplication(vault);

    expect(fetchBoundary).not.toHaveBeenCalled();
    const issues = await application.checkExternalLinks({
      fetch: fetchBoundary,
      resolveHost: async () => ['93.184.216.34'],
    });

    expect(fetchBoundary).toHaveBeenCalledTimes(1);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'external-link-http-error',
        url: 'https://public.example/broken',
        sourcePath: 'notes/source.md',
        line: 7,
        temporary: true,
      }),
    ]);
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

  it('keeps the publish center open with source-located Blockers while disabling publish', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      'version: 1\nsite:\n  name: Blocked Center\n  home_layout: sections\ncontent_roots:\n  - path: missing-notes\n    public_root: /notes\nfeatures:\n  search: false\n  graph: false\ncloudflare:\n  project_name: blocked-center\n',
      'utf8',
    );
    const application = new PagesPublishApplication(vault);

    await expect(application.getPublishCenter()).resolves.toMatchObject({
      siteName: 'Blocked Center',
      canPublish: false,
      summary: { blockers: 1 },
      issues: [
        expect.objectContaining({
          code: 'content-root-missing',
          path: 'content_roots[0].path',
        }),
      ],
    });
    await application.shutdown();
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
