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
  validateSiteConfigForDirectory,
  type EditableSiteConfig,
  type SiteConfigV1,
} from './config/site-config';
import {
  legacySiteBuilder,
  type LocalPreview,
} from './core/preview';
import type { SiteBuilder } from './site-builder/site-builder';
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
  deriveArticlePublicationState,
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
import {
  PublicationOrchestrator,
  type CloudflarePagesDeploymentBoundary,
  type PublicationDeployment,
  type PublicationRunStatus,
} from './publication/publish-orchestrator';
import {
  DeploymentFactsCoordinator,
  type ActivatedDeploymentInspector,
} from './publication/deployment-facts';
import {
  PagesPublishMaintenanceService,
  type MaintenanceStatus,
  type SafeDiagnosticLogEntry,
} from './maintenance/maintenance-service';
import {
  projectGlobalUiState,
  type GlobalUiProjection,
  type GlobalPublicationState,
} from './plugin/global-ui-state';

const CONNECTION_REFRESH_AFTER_IDLE_MS = 5 * 60 * 1000;
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
  type SetupProgressStage,
  type SetupResult,
  type SetupReview,
} from './setup/site-setup';
import type { PublicationEnvironmentStatus } from './runtime/environment-manager';
import { siteCanonicalOrigin } from './site/discovery';

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

export class PublicationUnavailableError extends Error {
  readonly name = 'PublicationUnavailableError';

  constructor() {
    super('Cloudflare deployment is unavailable until a connected Pages deployment adapter is ready.');
  }
}

export class MaintenanceUnavailableError extends Error {
  readonly name = 'MaintenanceUnavailableError';

  constructor() {
    super('Local maintenance is unavailable until the host supplies its environment and diagnostics boundaries.');
  }
}

export interface InitialSetupConnectionBoundary {
  refreshStatus(): Promise<{
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  }>;
  listAvailableAccounts(): Promise<SetupAccount[]>;
}

/** Optional connection-changing capabilities used only after an explicit UI action. */
export interface InitialSetupConnectionActions {
  isOAuthAvailable?(): boolean;
  beginOAuth?(input?: { redirectUri?: string }): Promise<{ url: string }>;
  completeOAuth?(input: { state: string; code: string }): Promise<{
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  }>;
  cancelOAuth?(state: string): Promise<boolean>;
  abandonOAuth?(): Promise<void>;
  connectApiToken?(token: string): Promise<{
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  }>;
  selectAccount?(accountId: string): Promise<{
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  }>;
}

type InitialSetupConnectionHost = InitialSetupConnectionBoundary & InitialSetupConnectionActions;

/** Host-owned listener preparation required before a desktop OAuth browser launch. */
export interface InitialSetupOAuthCallbackBoundary {
  start(): Promise<{ redirectUri: string }>;
  stop?(): Promise<void>;
}

export interface InitialSetupEnvironmentBoundary {
  getStatus(): PublicationEnvironmentStatus;
  prepare(): Promise<PublicationEnvironmentStatus>;
  repair(): Promise<PublicationEnvironmentStatus>;
}

export type InitialSetupEnvironmentStatus =
  | PublicationEnvironmentStatus
  | {
    stage: 'unavailable';
    impact: string;
    nextAction?: 'repair';
    detailsAvailable?: boolean;
  };

export type InitialSetupConnection =
  | { state: 'unavailable' }
  | {
    state: 'disconnected' | 'connected' | 'expired';
    account?: SetupAccount;
  };

export type ConfiguredCustomDomainStatus =
  | { state: 'unavailable' }
  | { state: 'not-configured' }
  | {
    state: 'pending' | 'active' | 'failed';
    hostname: string;
    message?: string;
  };

export interface ConfiguredCustomDomainStatusBoundary {
  inspect(): Promise<ConfiguredCustomDomainStatus>;
}

/** Receives only schema-constrained diagnostic events; it never accepts free text. */
export interface DiagnosticLogBoundary {
  append(entry: SafeDiagnosticLogEntry): void;
}

interface PublicationPreparation {
  scan: CoordinatedScanResult<SiteScanResult>;
}

export type PublicationServiceStatus =
  | PublicationRunStatus
  | { state: 'unavailable' };

export class PagesPublishApplication {
  private readonly previewServer = new LocalPreviewServer();
  private readonly scanCoordinator: ContentScanCoordinator<SiteScanResult>;
  private readonly currentArticleListeners = new Set<() => void>();
  private readonly setup: SiteSetupService | undefined;
  private readonly setupConnection: InitialSetupConnectionHost | undefined;
  private readonly oauthCallback: InitialSetupOAuthCallbackBoundary | undefined;
  private readonly setupEnvironment: InitialSetupEnvironmentBoundary | undefined;
  private readonly publisher:
    | PublicationOrchestrator<PublicationPreparation>
    | undefined;
  private readonly deploymentFacts: DeploymentFactsCoordinator | undefined;
  private readonly customDomainStatus: ConfiguredCustomDomainStatusBoundary | undefined;
  private readonly maintenance: PagesPublishMaintenanceService | undefined;
  private readonly diagnosticLog: DiagnosticLogBoundary | undefined;
  private readonly siteBuilder: SiteBuilder;
  private readonly globalUiListeners = new Set<() => void>();
  private unsubscribePublisherUi: (() => void) | undefined;
  private activeScans = 0;
  private latestScan: SiteScanResult | undefined;
  private pendingPublicationChanges: number | 'unknown' | undefined;
  private publishCenterCache: PublishCenterState | undefined;
  private publishCenterCacheInvalidated = true;
  private publishCenterCacheGeneration = 0;
  private initialSetupConnectionCache: InitialSetupConnection | undefined;
  private initialSetupConnectionCheckedAt = 0;
  private preparedPublishSnapshot: PublicationSnapshot | undefined;
  private initialSetupDraft: SetupDraft | undefined;

  constructor(
    private readonly vaultRoot: string,
    private readonly openExternal: (url: string) => void = () => undefined,
    options: {
      scan?: (request: ScanRequest) => Promise<SiteScanResult>;
      scanDebounceMs?: number;
      scanTimers?: ScanTimerBoundary;
      setup?: SiteSetupService;
      setupConnection?: InitialSetupConnectionHost;
      oauthCallback?: InitialSetupOAuthCallbackBoundary;
      setupEnvironment?: InitialSetupEnvironmentBoundary;
      deploymentAdapter?: CloudflarePagesDeploymentBoundary;
      deploymentFacts?: DeploymentFactsCoordinator;
      customDomainStatus?: ConfiguredCustomDomainStatusBoundary;
      maintenance?: PagesPublishMaintenanceService;
      diagnosticLog?: DiagnosticLogBoundary;
      siteBuilder?: SiteBuilder;
    } = {},
  ) {
    this.setup = options.setup;
    this.setupConnection = options.setupConnection;
    this.oauthCallback = options.oauthCallback;
    this.setupEnvironment = options.setupEnvironment;
    this.deploymentFacts = options.deploymentFacts;
    this.customDomainStatus = options.customDomainStatus;
    this.maintenance = options.maintenance;
    this.diagnosticLog = options.diagnosticLog;
    this.siteBuilder = options.siteBuilder ?? legacySiteBuilder;
    this.scanCoordinator = new ContentScanCoordinator(
      options.scan ??
        (async ({ signal }) =>
          scanSiteFromDirectory(this.vaultRoot, { signal })),
      { debounceMs: options.scanDebounceMs, timers: options.scanTimers },
    );
    if (options.deploymentAdapter) {
      this.publisher = new PublicationOrchestrator<PublicationPreparation>({
        prepare: () => this.preparePublication(),
        build: (preparation) => this.buildPublication(preparation),
        adapter: options.deploymentAdapter,
        ...(this.deploymentFacts === undefined ? {} : { facts: this.deploymentFacts }),
      });
      this.unsubscribePublisherUi = this.publisher.subscribe((status) => {
        if (status.state === 'succeeded') this.pendingPublicationChanges = 0;
        this.recordPublicationDiagnostic(status);
        this.notifyGlobalUiChange();
      });
    }
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

  async openPublishedSite(): Promise<string> {
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    const url = siteCanonicalOrigin(loaded.config);
    this.openExternal(url);
    return url;
  }

  getPreviewStatus(): PreviewServerStatus {
    return this.previewServer.getStatus();
  }

  async openArticlePreview(
    sourcePath: string,
  ): Promise<PreviewSession & { articleUrl: string }> {
    const preview = await this.siteBuilder.build({
      vaultRoot: this.vaultRoot,
      renderMode: 'local',
      focusSourcePath: sourcePath,
    });
    const articlePath = preview.articles.find(
      (article) => article.sourcePath === sourcePath,
    )?.url;
    if (!articlePath) throw new Error('Article did not produce a Quartz preview route.');
    const session = await this.previewServer.start(preview.files, preview.assets);
    const articleUrl = new URL(articlePath.slice(1), session.url).toString();
    this.openExternal(articleUrl);
    return { ...session, articleUrl };
  }

  async openArticleOnlinePage(sourcePath: string): Promise<string> {
    const state = await this.getCurrentArticlePanel({ pinnedPath: sourcePath });
    const value = state.status === 'article'
      ? state.route.onlineUrl
      : state.status === 'out-of-scope-online'
        ? state.onlineUrl
        : undefined;
    if (!value) throw new Error('This article does not have an online page.');
    const url = value.startsWith('/')
      ? new URL(value.slice(1), `${await this.publishCenterSiteUrl()}/`)
      : new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('The online article URL is not safe to open.');
    }
    this.openExternal(url.toString());
    return url.toString();
  }

  async preparePreview(): Promise<LocalPreview> {
    return (await this.prepareStablePreview('preview')).preview;
  }

  async getPublishCenter(
    options: { baseline?: PublishBaseline; forceRefresh?: boolean } = {},
  ): Promise<PublishCenterState> {
    if (
      !options.forceRefresh
      && options.baseline === undefined
      && !this.publishCenterCacheInvalidated
      && this.publishCenterCache
    ) {
      return this.publishCenterCache;
    }
    const cacheGeneration = this.publishCenterCacheGeneration;
    const initialScan = await this.requestScan('manual-refresh');
    const siteUrl = await this.publishCenterSiteUrl();
    let center: PublishCenterState;
    if (initialScan.value.issues.some((issue) => issue.severity === 'blocker')) {
      center = createPublishCenterState({
        siteName: await this.publishCenterSiteName(),
        siteUrl,
        scan: initialScan.value,
        articles: initialScan.value.candidates.map((candidate) => ({
          sourcePath: candidate.sourcePath,
          title: candidate.sourcePath,
          sourceDigest: candidate.sourceDigest,
          availability: 'unavailable' as const,
        })),
        baseline: options.baseline ?? await this.defaultPublishBaseline(),
        output: {
          status: 'unknown',
          fileCount: 0,
          assetCount: 0,
          assetBytes: 0,
        },
      });
    } else {
      const prepared = await this.prepareStablePreview('manual-refresh');
      center = createPublishCenterState({
        siteName: prepared.preview.siteName,
        siteUrl,
        scan: prepared.scan.value,
        articles: prepared.preview.articles,
        baseline: options.baseline ?? await this.defaultPublishBaseline(prepared.preview),
        output: previewOutput(prepared.preview),
      });
    }
    if (
      options.baseline === undefined
      && cacheGeneration === this.publishCenterCacheGeneration
    ) {
      this.publishCenterCache = center;
      this.publishCenterCacheInvalidated = false;
    }
    this.pendingPublicationChanges = center.summary.changes;
    this.notifyGlobalUiChange();
    return center;
  }

  async preparePublishSnapshot(): Promise<PublicationSnapshot> {
    const prepared = await this.prepareStablePreview('publish', 'published');
    const snapshot = createPublicationSnapshot(prepared.scan.value, prepared.preview);
    this.preparedPublishSnapshot = snapshot;
    return snapshot;
  }

  getPreparedPublishSnapshot(): PublicationSnapshot | undefined {
    return this.preparedPublishSnapshot;
  }

  isPublicationAvailable(): boolean {
    return this.publisher !== undefined;
  }

  getPublicationStatus(): PublicationServiceStatus {
    return this.publisher?.getStatus() ?? { state: 'unavailable' };
  }

  /**
   * A low-noise projection for global Obsidian surfaces. It deliberately uses
   * the latest publish-center result for change counts; a scan alone cannot
   * safely infer whether a candidate is a pending change.
   */
  async getGlobalUiState(): Promise<GlobalUiProjection> {
    const configured = (await this.getLaunchTarget()) === 'publish-center';
    // Startup feedback must stay local and instantaneous. Cloudflare is
    // refreshed only after the user opens a surface or requests a check.
    const connection: InitialSetupConnection['state'] = 'unavailable';
    return projectGlobalUiState({
      configured,
      connection,
      scan: this.activeScans > 0 ? 'scanning' : 'idle',
      blockers: this.latestScan?.issues.filter((issue) => issue.severity === 'blocker').length,
      pending: this.pendingPublicationChanges,
      publication: toGlobalPublicationState(this.getPublicationStatus()),
      environment: this.globalEnvironmentState(),
    });
  }

  subscribeGlobalUiState(listener: () => void): () => void {
    this.globalUiListeners.add(listener);
    return () => this.globalUiListeners.delete(listener);
  }

  publishSite(): Promise<PublicationDeployment> {
    if (!this.publisher) throw new PublicationUnavailableError();
    return this.publisher.publish();
  }

  subscribePublicationStatus(
    listener: (status: PublicationRunStatus) => void,
  ): () => void {
    return this.requirePublisher().subscribe(listener);
  }

  async recoverPublicationFacts(
    inspector: ActivatedDeploymentInspector,
  ): Promise<void> {
    if (!this.deploymentFacts) throw new PublicationUnavailableError();
    await this.deploymentFacts.recover(inspector);
    await this.publisher?.refreshPublicationFacts();
    this.invalidatePublishCenterCache();
  }

  /** Clears an upload-uncertain lock only after an explicit UI confirmation. */
  async acknowledgeUploadUncertainPublication(): Promise<void> {
    if (!this.deploymentFacts) throw new PublicationUnavailableError();
    await this.deploymentFacts.acknowledgeUploadUncertainActivation();
    await this.publisher?.refreshPublicationFacts();
    this.invalidatePublishCenterCache();
  }

  /** Invoked only by the explicit settings-page “check status” action. */
  async inspectConfiguredCustomDomain(): Promise<ConfiguredCustomDomainStatus> {
    return this.customDomainStatus?.inspect() ?? { state: 'unavailable' };
  }

  /** Refreshes durable publication recovery state when the host starts. */
  async hydratePublicationFacts(): Promise<void> {
    await this.publisher?.refreshPublicationFacts();
  }

  isMaintenanceAvailable(): boolean {
    return this.maintenance !== undefined;
  }

  getMaintenanceStatus(): MaintenanceStatus | { state: 'unavailable' } {
    return this.maintenance?.getStatus() ?? { state: 'unavailable' };
  }

  async repairEnvironment(): Promise<void> {
    const repair = this.requireMaintenance().repairEnvironment();
    this.notifyGlobalUiChange();
    try {
      await repair;
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  async clearRebuildableCache(): Promise<void> {
    await this.requireMaintenance().clearRebuildableCache();
  }

  async refreshMaintenanceConnection(): Promise<void> {
    await this.requireMaintenance().refreshConnection();
  }

  async openMaintenanceLogs(): Promise<void> {
    await this.requireMaintenance().openLogs();
  }

  describeDiagnosticExport(): { included: string[]; excluded: string[] } {
    return this.requireMaintenance().describeDiagnosticExport();
  }

  async exportDiagnostics(input: { confirmed?: boolean }): Promise<{ path: string }> {
    return this.requireMaintenance().exportDiagnostics(input);
  }

  private async prepareStablePreview(
    trigger: 'manual-refresh' | 'preview' | 'publish',
    renderMode: 'local' | 'published' = 'local',
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
      const preview = await this.siteBuilder.build({
        vaultRoot: this.vaultRoot,
        renderMode,
      });
      const after = await this.requestScan(trigger);
      if (after.value.digest === before.value.digest) return { preview, scan: after };
    }
    throw new Error('Content changed repeatedly while preparing the local preview.');
  }

  private async preparePublication(): Promise<PublicationPreparation> {
    const scan = await this.requestScan('publish');
    const blockers = scan.value.issues.filter(
      (issue) => issue.severity === 'blocker',
    );
    if (blockers.length > 0) throw new PublishingBlockedError(blockers);
    return { scan };
  }

  private async buildPublication(
    preparation: PublicationPreparation,
  ): Promise<PublicationSnapshot> {
    const preview = await this.siteBuilder.build({
      vaultRoot: this.vaultRoot,
      renderMode: 'published',
    });
    const verified = await this.requestScan('publish');
    if (verified.value.digest !== preparation.scan.value.digest) {
      throw new Error(
        'Content changed while building this site. Retry publish to rescan the current Vault.',
      );
    }
    const snapshot = createPublicationSnapshot(verified.value, preview);
    this.preparedPublishSnapshot = snapshot;
    return snapshot;
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

  getInitialSetupDraft(): SetupDraft | undefined {
    return this.initialSetupDraft === undefined
      ? undefined
      : structuredClone(this.initialSetupDraft);
  }

  preserveInitialSetupDraft(draft: SetupDraft): void {
    this.initialSetupDraft = structuredClone(draft);
  }

  getInitialSetupEnvironment(): InitialSetupEnvironmentStatus {
    return this.setupEnvironment?.getStatus() ?? {
      stage: 'unavailable',
      impact: '当前插件构建未接入本地发布环境。',
      detailsAvailable: true,
    };
  }

  async prepareInitialSetupEnvironment(): Promise<InitialSetupEnvironmentStatus> {
    if (!this.setupEnvironment) return this.getInitialSetupEnvironment();
    try {
      return await this.setupEnvironment.prepare();
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  async repairInitialSetupEnvironment(): Promise<InitialSetupEnvironmentStatus> {
    if (!this.setupEnvironment) return this.getInitialSetupEnvironment();
    try {
      return await this.setupEnvironment.repair();
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  isInitialSetupAvailable(): boolean {
    return this.setup !== undefined && this.setupConnection !== undefined;
  }

  async getInitialSetupConnection(
    options: { forceRefresh?: boolean } = {},
  ): Promise<InitialSetupConnection> {
    if (!this.setup || !this.setupConnection) return { state: 'unavailable' };
    const stale = Date.now() - this.initialSetupConnectionCheckedAt >= CONNECTION_REFRESH_AFTER_IDLE_MS;
    if (!options.forceRefresh && !stale && this.initialSetupConnectionCache) {
      return this.initialSetupConnectionCache;
    }
    const connection = await this.setupConnection.refreshStatus();
    this.cacheInitialSetupConnection(connection);
    return connection;
  }

  private cacheInitialSetupConnection(connection: InitialSetupConnection): void {
    this.initialSetupConnectionCache = connection;
    this.initialSetupConnectionCheckedAt = Date.now();
  }

  private invalidateInitialSetupConnectionCache(): void {
    this.initialSetupConnectionCache = undefined;
    this.initialSetupConnectionCheckedAt = 0;
  }

  private invalidatePublishCenterCache(): void {
    this.publishCenterCacheInvalidated = true;
    this.publishCenterCacheGeneration += 1;
  }

  async listInitialSetupAccounts(): Promise<SetupAccount[]> {
    if (!this.setupConnection) throw new InitialSetupUnavailableError();
    return this.setupConnection.listAvailableAccounts();
  }

  canConnectInitialSetupApiToken(): boolean {
    return this.setupConnection?.connectApiToken !== undefined;
  }

  canConnectInitialSetupOAuth(): boolean {
    const connection = this.setupConnection;
    return connection?.beginOAuth !== undefined &&
      connection?.completeOAuth !== undefined &&
      connection.isOAuthAvailable?.() === true;
  }

  async beginInitialSetupOAuth(): Promise<void> {
    const connection = this.setupConnection;
    if (!connection?.beginOAuth || connection.isOAuthAvailable?.() !== true) {
      throw new InitialSetupUnavailableError();
    }
    let callback: { redirectUri: string } | undefined;
    try {
      callback = await this.oauthCallback?.start();
      const authorization = await connection.beginOAuth(callback);
      this.openExternal(authorization.url);
    } catch (error) {
      await this.oauthCallback?.stop?.().catch(() => undefined);
      throw error;
    }
  }

  async completeInitialSetupOAuth(input: {
    state: string;
    code: string;
  }): Promise<InitialSetupConnection> {
    const connection = this.setupConnection;
    if (!connection?.completeOAuth || connection.isOAuthAvailable?.() !== true) {
      throw new InitialSetupUnavailableError();
    }
    try {
      const completed = await connection.completeOAuth(input);
      this.cacheInitialSetupConnection(completed);
      return completed;
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  async cancelInitialSetupOAuth(state: string): Promise<boolean> {
    const connection = this.setupConnection;
    if (!connection?.cancelOAuth) return false;
    try {
      return await connection.cancelOAuth(state);
    } finally {
      this.invalidateInitialSetupConnectionCache();
      this.notifyGlobalUiChange();
    }
  }

  async abandonInitialSetupOAuth(): Promise<void> {
    const connection = this.setupConnection;
    if (!connection?.abandonOAuth) return;
    try {
      await connection.abandonOAuth();
    } finally {
      this.invalidateInitialSetupConnectionCache();
      this.notifyGlobalUiChange();
    }
  }

  canSelectInitialSetupAccount(): boolean {
    return this.setupConnection?.selectAccount !== undefined;
  }

  async connectInitialSetupApiToken(token: string): Promise<InitialSetupConnection> {
    const connection = this.setupConnection;
    if (!connection?.connectApiToken) throw new InitialSetupUnavailableError();
    try {
      const connected = await connection.connectApiToken(token);
      this.cacheInitialSetupConnection(connected);
      return connected;
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  async selectInitialSetupAccount(accountId: string): Promise<InitialSetupConnection> {
    const connection = this.setupConnection;
    if (!connection?.selectAccount) throw new InitialSetupUnavailableError();
    try {
      const selected = await connection.selectAccount(accountId);
      this.cacheInitialSetupConnection(selected);
      return selected;
    } finally {
      this.notifyGlobalUiChange();
    }
  }

  async selectConfiguredAccount(accountId: string): Promise<InitialSetupConnection> {
    const previous = await this.connectedSetupAccount();
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    try {
      const selected = await this.selectInitialSetupAccount(accountId);
      const account = 'account' in selected ? selected.account : undefined;
      if (selected.state !== 'connected' || !account) throw new InitialSetupUnavailableError();
      await this.requireSetup().verifyConfiguredProject(
        account,
        loaded.config.cloudflare.projectName,
      );
      return selected;
    } catch (error) {
      try {
        await this.selectInitialSetupAccount(previous.id);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Cloudflare account verification failed and the previous account could not be restored.',
        );
      }
      throw error;
    }
  }

  listInitialSetupProjects(account: SetupAccount): Promise<SetupProject[]> {
    return this.requireSetup().listProjects(account);
  }

  async bindConfiguredProject(projectName: string): Promise<SetupProject> {
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    const draft = structuredClone(loaded.config);
    draft.cloudflare.projectName = projectName;
    await validateSiteConfigForDirectory(this.vaultRoot, draft);
    const account = await this.connectedSetupAccount();
    const project = await this.requireSetup().verifyConfiguredProject(account, projectName);
    await this.assertSetupAccountUnchanged(account.id);
    await saveSiteConfigToDirectory(this.vaultRoot, draft, {
      expectedRevision: loaded.revision,
    });
    await this.requestScan('config-save');
    return project;
  }

  async connectConfiguredCustomDomain(hostname: string): Promise<ConfiguredCustomDomainStatus> {
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    const draft = structuredClone(loaded.config);
    draft.cloudflare.customDomain = hostname;
    await validateSiteConfigForDirectory(this.vaultRoot, draft);
    const account = await this.connectedSetupAccount();
    const result = await this.requireSetup().connectConfiguredCustomDomain(
      account,
      draft.cloudflare.projectName,
      hostname,
    );
    await this.assertSetupAccountUnchanged(account.id);
    await saveSiteConfigToDirectory(this.vaultRoot, draft, {
      expectedRevision: loaded.revision,
    });
    await this.requestScan('config-save');
    return { state: result.status, hostname, ...(result.message ? { message: result.message } : {}) };
  }

  async confirmInitialSetup(
    draft: SetupDraft,
    onProgress?: (stage: SetupProgressStage) => void,
  ): Promise<SetupResult> {
    const result = await this.requireSetup().confirm(draft, onProgress);
    this.initialSetupDraft = undefined;
    return result;
  }

  async getCurrentArticlePanel(
    context: CurrentArticleContext,
  ): Promise<CurrentArticlePanelState> {
    const state = await resolveCurrentArticlePanelFromDirectory(this.vaultRoot, context);
    if (state.status !== 'article') return state;
    const baseline = this.deploymentFacts
      ? await this.deploymentFacts.getBaseline()
      : undefined;
    const previous = baseline?.status === 'available'
      ? baseline.articles.find((article) => article.sourcePath === state.sourcePath)
      : undefined;
    const publication = this.getPublicationStatus();
    return {
      ...state,
      ...(publication.state === 'failed' ? { sitePublicationFailed: true } : {}),
      publicationState: deriveArticlePublicationState({
        visibility: state.metadata.visibility.value,
        pendingUrl: state.route.pendingUrl,
        onlineUrl: previous?.url ?? state.route.onlineUrl,
        currentSourceDigest: state.currentSourceDigest,
        deployedSourceDigest: previous?.sourceDigest ?? state.metadata.deployment?.sourceDigest,
        deployedVisibility: previous?.visibility,
        hasBlocker: [...state.contentIssues, ...state.route.issues].some(
          (issue) => issue.severity === 'blocker' && !('dormant' in issue && issue.dormant),
        ),
      }),
    };
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
    if (trigger !== 'manual-refresh') this.invalidatePublishCenterCache();
    this.activeScans += 1;
    this.notifyGlobalUiChange();
    try {
      let pending = this.scanCoordinator.request(trigger);
      while (true) {
        try {
          const result = await pending;
          if (result.status === 'applied') {
            this.latestScan = result.value;
            this.pendingPublicationChanges = scanMayChangePublication(trigger)
              ? 'unknown'
              : undefined;
            this.recordScanDiagnostic(result.value);
            return result;
          }
        } catch (error) {
          if (!isAbortError(error)) throw error;
        }
        pending = this.scanCoordinator.waitForLatest();
      }
    } finally {
      this.activeScans = Math.max(0, this.activeScans - 1);
      this.notifyGlobalUiChange();
    }
  }

  async startScanning(): Promise<CoordinatedScanResult<SiteScanResult> | undefined> {
    if ((await this.getLaunchTarget()) === 'setup') return undefined;
    return this.requestScan('plugin-load');
  }

  notifyFileChange(): void {
    this.invalidatePublishCenterCache();
    for (const listener of this.currentArticleListeners) listener();
  }

  async shutdown(): Promise<void> {
    this.unsubscribePublisherUi?.();
    this.unsubscribePublisherUi = undefined;
    this.globalUiListeners.clear();
    this.currentArticleListeners.clear();
    this.preparedPublishSnapshot = undefined;
    this.scanCoordinator.dispose();
    await this.previewServer.stop();
  }

  private requireSetup(): SiteSetupService {
    if (!this.setup) throw new InitialSetupUnavailableError();
    return this.setup;
  }

  private async connectedSetupAccount(): Promise<SetupAccount> {
    const connection = await this.getInitialSetupConnection();
    const account = 'account' in connection ? connection.account : undefined;
    if (connection.state !== 'connected' || !account) {
      throw new InitialSetupUnavailableError();
    }
    return account;
  }

  private async assertSetupAccountUnchanged(accountId: string): Promise<void> {
    const current = await this.connectedSetupAccount();
    if (current.id !== accountId) {
      throw new Error('Cloudflare account changed while applying the remote setting.');
    }
  }

  private requirePublisher(): PublicationOrchestrator<PublicationPreparation> {
    if (!this.publisher) throw new PublicationUnavailableError();
    return this.publisher;
  }

  private requireMaintenance(): PagesPublishMaintenanceService {
    if (!this.maintenance) throw new MaintenanceUnavailableError();
    return this.maintenance;
  }

  private notifyGlobalUiChange(): void {
    for (const listener of this.globalUiListeners) listener();
  }

  private recordScanDiagnostic(scan: SiteScanResult): void {
    const blockers = scan.issues.filter((issue) => issue.severity === 'blocker').length;
    const warnings = scan.issues.filter((issue) => issue.severity === 'warning').length;
    // Diagnostics are best-effort. A host-owned sink must not change scan or
    // publication behavior, and it only receives finite aggregate counts.
    try {
      this.diagnosticLog?.append({
        at: new Date().toISOString(),
        stage: 'scan',
        code: 'scan-complete',
        counts: { candidates: scan.candidates.length, blockers, warnings },
      });
    } catch {
      // A failed diagnostics sink is intentionally not a publishing failure.
    }
  }

  private recordPublicationDiagnostic(status: PublicationRunStatus): void {
    const event = publicationDiagnostic(status);
    if (!event) return;
    try {
      this.diagnosticLog?.append({ at: new Date().toISOString(), ...event });
    } catch {
      // A failed diagnostics sink is intentionally not a publishing failure.
    }
  }

  private globalEnvironmentState(): 'preparing' | 'failed' | undefined {
    const maintenance = this.getMaintenanceStatus();
    if ('state' in maintenance) return undefined;
    if (maintenance.environment.stage === 'failed') return 'failed';
    return maintenance.environment.stage === 'idle' ||
      maintenance.environment.stage === 'ready' ||
      maintenance.environment.stage === 'unavailable'
      ? undefined
      : 'preparing';
  }

  private async defaultPublishBaseline(
    preview?: LocalPreview,
  ): Promise<PublishBaseline> {
    if (this.deploymentFacts) {
      const baseline = await this.deploymentFacts.getBaseline();
      if (
        baseline.status === 'missing' &&
        preview !== undefined &&
        !preview.articles.some((article) => article.onlineUrl)
      ) {
        return { status: 'first-publish' };
      }
      return baseline;
    }
    return preview?.articles.some((article) => article.onlineUrl)
      ? { status: 'missing' }
      : { status: 'first-publish' };
  }

  private async publishCenterSiteUrl(): Promise<string | undefined> {
    const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    return loaded.status === 'editable' ? siteCanonicalOrigin(loaded.config) : undefined;
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

function toGlobalPublicationState(
  status: PublicationServiceStatus,
): GlobalPublicationState {
  if (status.state === 'running' || status.state === 'failed') {
    return { state: status.state, stage: status.stage };
  }
  if (status.state === 'reconciliation-required') {
    return { state: status.state, reconciliation: status.reconciliation };
  }
  return { state: status.state };
}

function publicationDiagnostic(
  status: PublicationRunStatus,
): Omit<SafeDiagnosticLogEntry, 'at'> | undefined {
  if (status.state === 'idle') return undefined;
  if (status.state === 'running') {
    if (status.stage === 'prepare') {
      return { stage: 'maintenance', code: 'publication-preparing' };
    }
    return { stage: status.stage, code: `${status.stage}-started` };
  }
  if (status.state === 'succeeded') {
    return {
      stage: 'activate',
      code: 'activation-complete',
      counts: { files: status.deployment.output.fileCount },
    };
  }
  if (status.state === 'failed') {
    return {
      stage: status.stage === 'prepare' ? 'maintenance' : status.stage,
      code: `${status.stage}-failed`,
    };
  }
  return status.reconciliation === 'upload-uncertain'
    ? { stage: 'upload', code: 'upload-outcome-unknown' }
    : { stage: 'activate', code: 'activation-reconciliation-required' };
}

function scanMayChangePublication(trigger: ScanTrigger): boolean {
  return trigger === 'file-change' || trigger === 'config-save';
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
