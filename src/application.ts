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
  prepareLocalPreviewFromDirectory,
  type LocalPreview,
} from './core/preview';
import { LocalPreviewServer, type PreviewSession } from './preview/server';

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
    void this.requestScan('file-change').catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.scanCoordinator.dispose();
    await this.previewServer.stop();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
