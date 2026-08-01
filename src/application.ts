import { access } from 'fs/promises';
import { join } from 'path';
import {
  ContentScanCoordinator,
  type CoordinatedScanResult,
  type ScanRequest,
  type ScanTimerBoundary,
  type ScanTrigger,
} from './content/scan-coordinator';
import {
  scanSiteFromDirectory,
  type ScanIssue,
  type SiteScanResult,
} from './content/site-scanner';
import {
  checkExternalLinks as runExternalLinkCheck,
  type ExternalLinkFetchBoundary,
  type ExternalLinkHostResolver,
  type TemporaryExternalLinkIssue,
} from './content/external-link-checker';
import {
  loadSiteConfigFromDirectory,
  saveSiteConfigToDirectory,
  type EditableSiteConfig,
  type SiteConfigV1,
} from './config/site-config';
import {
  prepareArticlePreviewFromDirectory,
  prepareLocalPreviewFromDirectory,
  type LocalPreview,
} from './core/preview';
import {
  LocalPreviewServer,
  type PreviewServerStatus,
  type PreviewSession,
} from './preview/server';
import {
  commitArticleIntentEditToDirectory,
  prepareArticleIntentEditFromDirectory,
  type ArticleIntentPatch,
  type ArticlePublicationMetadata,
  type PreparedArticleIntentEdit,
} from './publication/article-metadata';
import {
  resolveCurrentArticlePanelFromDirectory,
  type CurrentArticleContext,
  type CurrentArticlePanelState,
} from './publication/current-article-panel';
import {
  createPublicationSnapshot,
  createPublishCenterState,
  previewOutput,
  type PublishBaseline,
  type PublishCenterState,
  type PublicationSnapshot,
} from './publication/publish-center';
import { collectDirectoryRouteSources } from './routing/directory-route-sources';
import {
  normalizeRouteUrlPath,
  planSiteRoutes,
  RoutePlanningError,
  type RouteArticleInput,
  type RouteIssue,
  type SiteRoutePlan,
} from './routing/route-planner';
import {
  SiteSetupService,
  type SetupAccount,
  type SetupDraft,
  type SetupProject,
  type SetupResult,
  type SetupReview,
} from './setup/site-setup';

export type LaunchTarget = 'setup' | 'publish-center';

export class PublishingBlockedError extends Error {
  readonly name = 'PublishingBlockedError';

  constructor(readonly issues: ScanIssue[]) {
    super('Publishing is blocked by the latest content scan.');
  }
}

export class InitialSetupUnavailableError extends Error {
  readonly name = 'InitialSetupUnavailableError';

  constructor() {
    super('Cloudflare setup is unavailable until a connected account and Pages adapter are ready.');
  }
}

export interface InitialSetupConnectionBoundary {
  refreshStatus(): Promise<{
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  }>;
  listAvailableAccounts(): Promise<SetupAccount[]>;
}

export type InitialSetupConnection =
  | { state: 'unavailable' }
  | {
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  };

export class PagesPublishApplication {
  private readonly previewServer = new LocalPreviewServer();
  private readonly scanCoordinator: ContentScanCoordinator<SiteScanResult>;
  private readonly currentArticleListeners = new Set<() => void>();
  private readonly setup: SiteSetupService | undefined;
  private readonly setupConnection: InitialSetupConnectionBoundary | undefined;
  private preparedPublishSnapshot: PublicationSnapshot | undefined;

  constructor(
    private readonly vaultRoot: string,
    private readonly openExternal: (url: string) => void = () => undefined,
    options: {
      scan?: (request: ScanRequest) => Promise<SiteScanResult>;
      scanDebounceMs?: number;
      scanTimers?: ScanTimerBoundary;
      setup?: SiteSetupService;
      setupConnection?: InitialSetupConnectionBoundary;
    } = {},
  ) {
    this.setup = options.setup;
    this.setupConnection = options.setupConnection;
    this.scanCoordinator = new ContentScanCoordinator(
      options.scan ??
        (async ({ signal }) =>
          scanSiteFromDirectory(this.vaultRoot, { signal })),
      { debounceMs: options.scanDebounceMs, timers: options.scanTimers },
    );
  }

  async getLaunchTarget(): Promise<LaunchTarget> {
    try {
      await access(join(this.vaultRoot, '.publish', 'site.yml'));
      return 'publish-center';
    } catch {
      return 'setup';
    }
  }

  async openPreview(): Promise<PreviewSession> {
    const preview = await this.preparePreview();
    const session = await this.previewServer.start(preview.files, preview.assets);
    this.openExternal(session.url);
    return session;
  }

  getPreviewStatus(): PreviewServerStatus {
    return this.previewServer.getStatus();
  }

  async openArticlePreview(
    sourcePath: string,
  ): Promise<PreviewSession & { articleUrl: string }> {
    const preview = await prepareArticlePreviewFromDirectory(
      this.vaultRoot,
      sourcePath,
    );
    const session = await this.previewServer.start(preview.files, preview.assets);
    const articleUrl = new URL(preview.articlePath.slice(1), session.url).toString();
    this.openExternal(articleUrl);
    return { ...session, articleUrl };
  }

  async preparePreview(): Promise<LocalPreview> {
    return (await this.prepareStablePreview('preview')).preview;
  }

  async getPublishCenter(
    options: { baseline?: PublishBaseline } = {},
  ): Promise<PublishCenterState> {
    const initialScan = await this.requestScan('manual-refresh');
    if (initialScan.value.issues.some((issue) => issue.severity === 'blocker')) {
      return createPublishCenterState({
        siteName: await this.publishCenterSiteName(),
        scan: initialScan.value,
        articles: initialScan.value.candidates.map((candidate) => ({
          sourcePath: candidate.sourcePath,
          title: candidate.sourcePath,
          sourceDigest: candidate.sourceDigest,
          availability: 'unavailable' as const,
        })),
        baseline: options.baseline ?? { status: 'first-publish' },
        output: {
          status: 'unknown',
          fileCount: 0,
          assetCount: 0,
          assetBytes: 0,
        },
      });
    }
    const prepared = await this.prepareStablePreview('manual-refresh');
    return createPublishCenterState({
      siteName: prepared.preview.siteName,
      scan: prepared.scan.value,
      articles: prepared.preview.articles,
      baseline: options.baseline ?? (
        prepared.preview.articles.some((article) => article.onlineUrl)
          ? { status: 'missing' }
          : { status: 'first-publish' }
      ),
      output: previewOutput(prepared.preview),
    });
  }

  async preparePublishSnapshot(): Promise<PublicationSnapshot> {
    const prepared = await this.prepareStablePreview('publish');
    const snapshot = createPublicationSnapshot(prepared.scan.value, prepared.preview);
    this.preparedPublishSnapshot = snapshot;
    return snapshot;
  }

  getPreparedPublishSnapshot(): PublicationSnapshot | undefined {
    return this.preparedPublishSnapshot;
  }

  private async prepareStablePreview(
    trigger: 'manual-refresh' | 'preview' | 'publish',
  ): Promise<{
    preview: LocalPreview;
    scan: CoordinatedScanResult<SiteScanResult>;
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.requestScan(trigger);
      const blockers = before.value.issues.filter(
        (issue) => issue.severity === 'blocker',
      );
      if (blockers.length > 0) throw new PublishingBlockedError(blockers);
      const preview = await prepareLocalPreviewFromDirectory(this.vaultRoot);
      const after = await this.requestScan(trigger);
      if (after.value.digest === before.value.digest) return { preview, scan: after };
    }
    throw new Error('Content changed repeatedly while preparing the local preview.');
  }

  private async publishCenterSiteName(): Promise<string> {
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    return loaded.status === 'editable' ? loaded.config.site.name : '发布中心';
  }

  async checkExternalLinks(
    options: {
      fetch?: ExternalLinkFetchBoundary;
      resolveHost?: ExternalLinkHostResolver;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<TemporaryExternalLinkIssue[]> {
    const scan = await this.requestScan('manual-refresh');
    return runExternalLinkCheck(scan.value.externalLinks ?? [], {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  }

  async createInitialSiteConfig(
    draft: SiteConfigV1,
    options: { systemTimezone?: string } = {},
  ): Promise<{
    saved: EditableSiteConfig;
    scan: CoordinatedScanResult<SiteScanResult>;
  }> {
    const saved = await saveSiteConfigToDirectory(this.vaultRoot, draft, {
      expectedRevision: null,
      systemTimezone: options.systemTimezone,
    });
    const scan = await this.requestScan('config-save');
    return { saved, scan };
  }

  reviewInitialSetup(draft: SetupDraft): Promise<SetupReview> {
    return this.requireSetup().review(draft);
  }

  isInitialSetupAvailable(): boolean {
    return this.setup !== undefined && this.setupConnection !== undefined;
  }

  async getInitialSetupConnection(): Promise<InitialSetupConnection> {
    if (!this.setup || !this.setupConnection) return { state: 'unavailable' };
    return this.setupConnection.refreshStatus();
  }

  async listInitialSetupAccounts(): Promise<SetupAccount[]> {
    if (!this.setupConnection) throw new InitialSetupUnavailableError();
    return this.setupConnection.listAvailableAccounts();
  }

  listInitialSetupProjects(account: SetupAccount): Promise<SetupProject[]> {
    return this.requireSetup().listProjects(account);
  }

  async confirmInitialSetup(draft: SetupDraft): Promise<SetupResult> {
    return this.requireSetup().confirm(draft);
  }

  getCurrentArticlePanel(
    context: CurrentArticleContext,
  ): Promise<CurrentArticlePanelState> {
    return resolveCurrentArticlePanelFromDirectory(this.vaultRoot, context);
  }

  prepareArticleIntentEdit(
    sourcePath: string,
    patch: ArticleIntentPatch,
  ): Promise<PreparedArticleIntentEdit> {
    return prepareArticleIntentEditFromDirectory(
      this.vaultRoot,
      sourcePath,
      patch,
    );
  }

  async prepareArticleUrlIntentEdit(
    sourcePath: string,
    slug: string | null,
  ): Promise<PreparedArticleIntentEdit> {
    return this.prepareArticleRouteIntentEdit(sourcePath, { slug });
  }

  async prepareArticleRouteIntentEdit(
    sourcePath: string,
    patch: Pick<
      ArticleIntentPatch,
      'slug' | 'kind' | 'redirects' | 'visibility'
    >,
  ): Promise<PreparedArticleIntentEdit> {
    const routePatch = normalizeRouteIntentPatch(sourcePath, patch);
    const initial = await prepareArticleIntentEditFromDirectory(
      this.vaultRoot,
      sourcePath,
      routePatch,
    );
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    const { inputs } = await collectDirectoryRouteSources(
      this.vaultRoot,
      loaded.config,
    );
    const baselinePlan = planSiteRoutes(loaded.config, inputs);
    const planInitial = planSiteRoutes(
      loaded.config,
      replaceRouteInput(inputs, sourcePath, initial.next),
    );
    throwRouteEditBlockers(baselinePlan, planInitial);
    const nextUrl = planInitial.articles.find(
      (article) => article.sourcePath === sourcePath,
    )?.url;
    const onlineUrl = deploymentUrlPath(initial.current.deployment?.url);
    if (!onlineUrl || !nextUrl || onlineUrl === nextUrl) return initial;
    const prepared = await prepareArticleIntentEditFromDirectory(
      this.vaultRoot,
      sourcePath,
      {
        ...routePatch,
        redirects: [
          ...new Set([
            ...initial.next.redirects.value
              .map((redirect) => normalizeRouteUrlPath(redirect))
              .filter((redirect): redirect is string => redirect !== undefined),
            onlineUrl,
          ]),
        ],
      },
    );
    const planFinal = planSiteRoutes(
      loaded.config,
      replaceRouteInput(inputs, sourcePath, prepared.next),
    );
    throwRouteEditBlockers(baselinePlan, planFinal);
    return prepared;
  }

  async commitArticleIntentEdit(
    prepared: PreparedArticleIntentEdit,
    options: { confirmTakedown?: boolean } = {},
  ): Promise<{
    saved: ArticlePublicationMetadata;
    scan?: CoordinatedScanResult<SiteScanResult>;
    scanError?: Error;
  }> {
    const saved = await commitArticleIntentEditToDirectory(
      this.vaultRoot,
      prepared,
      options,
    );
    try {
      const scan = await this.requestScan('file-change');
      return { saved, scan };
    } catch (error) {
      return {
        saved,
        scanError: error instanceof Error ? error : new Error('Scan failed.'),
      };
    }
  }

  async setPublishCenterInclusion(
    sourcePath: string,
    included: boolean,
    options: { confirmTakedown?: boolean } = {},
  ): Promise<{
    saved: ArticlePublicationMetadata;
    scan?: CoordinatedScanResult<SiteScanResult>;
    scanError?: Error;
  }> {
    const prepared = await this.prepareArticleIntentEdit(sourcePath, {
      visibility: included ? 'public' : 'private',
    });
    return this.commitArticleIntentEdit(prepared, options);
  }

  subscribeCurrentArticleChanges(listener: () => void): () => void {
    this.currentArticleListeners.add(listener);
    return () => this.currentArticleListeners.delete(listener);
  }

  async requestScan(
    trigger: ScanTrigger,
  ): Promise<CoordinatedScanResult<SiteScanResult>> {
    let pending = this.scanCoordinator.request(trigger);
    while (true) {
      try {
        const result = await pending;
        if (result.status === 'applied') return result;
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
      pending = this.scanCoordinator.waitForLatest();
    }
  }

  async startScanning(): Promise<CoordinatedScanResult<SiteScanResult> | undefined> {
    if ((await this.getLaunchTarget()) === 'setup') return undefined;
    return this.requestScan('plugin-load');
  }

  notifyFileChange(): void {
    for (const listener of this.currentArticleListeners) listener();
    void this.requestScan('file-change').catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.currentArticleListeners.clear();
    this.preparedPublishSnapshot = undefined;
    this.scanCoordinator.dispose();
    await this.previewServer.stop();
  }

  private requireSetup(): SiteSetupService {
    if (!this.setup) throw new InitialSetupUnavailableError();
    return this.setup;
  }
}

function deploymentUrlPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/')) return normalizeRouteUrlPath(value);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return normalizeRouteUrlPath(parsed.pathname);
  } catch {
    return undefined;
  }
}

function normalizeRouteIntentPatch(
  sourcePath: string,
  patch: Pick<
    ArticleIntentPatch,
    'slug' | 'kind' | 'redirects' | 'visibility'
  >,
): Pick<
  ArticleIntentPatch,
  'slug' | 'kind' | 'redirects' | 'visibility'
> {
  const normalized: Pick<
    ArticleIntentPatch,
    'slug' | 'kind' | 'redirects' | 'visibility'
  > = {};
  if (patch.slug !== undefined) normalized.slug = patch.slug;
  if (patch.kind !== undefined) normalized.kind = patch.kind;
  if (patch.visibility !== undefined) normalized.visibility = patch.visibility;
  if (patch.redirects === undefined) return normalized;
  if (patch.redirects === null) return { ...normalized, redirects: null };
  const redirects: string[] = [];
  const issues: RouteIssue[] = [];
  for (const rawRedirect of patch.redirects) {
    const redirect = normalizeRouteUrlPath(rawRedirect);
    if (!redirect) {
      issues.push({
        severity: 'blocker',
        code: 'invalid-redirect',
        sourcePath,
        route: rawRedirect,
        message: 'Redirect must be a safe absolute URL path.',
      });
      continue;
    }
    if (!redirects.includes(redirect)) redirects.push(redirect);
  }
  if (issues.length > 0) throw new RoutePlanningError(issues);
  return { ...normalized, redirects };
}

function replaceRouteInput(
  inputs: RouteArticleInput[],
  sourcePath: string,
  metadata: ArticlePublicationMetadata,
): RouteArticleInput[] {
  const replacement: RouteArticleInput = {
    sourcePath,
    visibility: metadata.visibility.value,
    slug: metadata.slug.value,
    kind: metadata.kind.value,
    redirects: metadata.redirects.value,
    onlineUrl: metadata.deployment?.url,
  };
  const remaining = inputs.filter((input) => input.sourcePath !== sourcePath);
  return [...remaining, replacement];
}

function throwRouteEditBlockers(
  baseline: SiteRoutePlan,
  proposed: SiteRoutePlan,
): void {
  const baselineBlockers = baseline.issues.filter(
    (issue) => issue.severity === 'blocker',
  );
  const blockers = proposed.issues.filter(
    (issue) =>
      issue.severity === 'blocker' &&
      !baselineBlockers.some((baselineIssue) =>
        routeBlockerCovers(baselineIssue, issue),
      ),
  );
  if (blockers.length > 0) throw new RoutePlanningError(blockers);
}

function routeBlockerCovers(
  baseline: RouteIssue,
  proposed: RouteIssue,
): boolean {
  return (
    baseline.code === proposed.code &&
    baseline.route === proposed.route &&
    baseline.sourcePath === proposed.sourcePath &&
    baseline.directoryPath === proposed.directoryPath &&
    valuesAreSubset(
      proposed.relatedSourcePaths,
      baseline.relatedSourcePaths,
    ) &&
    valuesAreSubset(
      proposed.relatedDirectoryPaths,
      baseline.relatedDirectoryPaths,
    )
  );
}

function valuesAreSubset(
  proposed: string[] | undefined,
  baseline: string[] | undefined,
): boolean {
  return (proposed ?? []).every((value) => (baseline ?? []).includes(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
