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
  saveSiteConfigToDirectory,
  type EditableSiteConfig,
  type SiteConfigV1,
} from './config/site-config';
import {
  prepareArticlePreviewFromDirectory,
  prepareLocalPreviewFromDirectory,
  type LocalPreview,
} from './core/preview';
import { LocalPreviewServer, type PreviewSession } from './preview/server';
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

export type LaunchTarget = 'setup' | 'publish-center';

export class PublishingBlockedError extends Error {
  readonly name = 'PublishingBlockedError';

  constructor(readonly issues: ScanIssue[]) {
    super('Publishing is blocked by the latest content scan.');
  }
}

export class PagesPublishApplication {
  private readonly previewServer = new LocalPreviewServer();
  private readonly scanCoordinator: ContentScanCoordinator<SiteScanResult>;
  private readonly currentArticleListeners = new Set<() => void>();

  constructor(
    private readonly vaultRoot: string,
    private readonly openExternal: (url: string) => void = () => undefined,
    options: {
      scan?: (request: ScanRequest) => Promise<SiteScanResult>;
      scanDebounceMs?: number;
      scanTimers?: ScanTimerBoundary;
    } = {},
  ) {
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
    const session = await this.previewServer.start(preview.files);
    this.openExternal(session.url);
    return session;
  }

  async openArticlePreview(
    sourcePath: string,
  ): Promise<PreviewSession & { articleUrl: string }> {
    const preview = await prepareArticlePreviewFromDirectory(
      this.vaultRoot,
      sourcePath,
    );
    const session = await this.previewServer.start(preview.files);
    const articleUrl = new URL(preview.articlePath.slice(1), session.url).toString();
    this.openExternal(articleUrl);
    return { ...session, articleUrl };
  }

  async preparePreview(): Promise<LocalPreview> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.requestScan('preview');
      const blockers = before.value.issues.filter(
        (issue) => issue.severity === 'blocker',
      );
      if (blockers.length > 0) throw new PublishingBlockedError(blockers);
      const preview = await prepareLocalPreviewFromDirectory(this.vaultRoot);
      const after = await this.requestScan('preview');
      if (after.value.digest === before.value.digest) return preview;
    }
    throw new Error('Content changed repeatedly while preparing the local preview.');
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
    this.scanCoordinator.dispose();
    await this.previewServer.stop();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
