import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PagesPublishApplication } from '../src/application';
import {
  activatePagesPublish,
  type PagesPublishGlobalFeedback,
  type PagesPublishHost,
} from '../src/plugin/lifecycle';
import type { GlobalUiProjection, GlobalUiRoute } from '../src/plugin/global-ui-state';

describe('plugin lifecycle', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('routes ribbon and command through the same launch target and disposes registrations', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    const application = new PagesPublishApplication(vault);
    const host = new RecordingHost();

    const activation = activatePagesPublish(application, host);
    await host.clickRibbon();
    await host.runCommand('open-publish-center');

    expect(host.openedTargets).toEqual(['setup', 'setup']);
    expect(host.ribbon).toMatchObject({
      icon: 'cloud-upload',
      label: '打开发布中心',
    });
    expect(host.command).toMatchObject({
      id: 'open-publish-center',
      name: '打开发布中心',
    });

    await activation.dispose();
    expect(host.disposedRegistrations).toBe(2);
    expect(host.vaultChange).toBeUndefined();
  });

  it('does not scan a configured vault until the user enters a plugin surface', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), 'configured', 'utf8');
    const scan = vi.fn(async () => ({
      configRevision: 'config',
      digest: 'scan',
      candidates: [],
      issues: [],
    }));
    const application = new PagesPublishApplication(vault, undefined, { scan });
    const host = new RecordingHost();

    const activation = activatePagesPublish(application, host);

    await Promise.resolve();
    expect(scan).not.toHaveBeenCalled();
    await activation.dispose();
  });

  it('does not refresh Cloudflare while the plugin only registers startup feedback', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), 'configured', 'utf8');
    const refreshStatus = vi.fn(async () => ({ state: 'connected' as const }));
    const application = new PagesPublishApplication(vault, undefined, {
      setup: {} as never,
      setupConnection: {
        refreshStatus,
        listAvailableAccounts: async () => [],
        isOAuthAvailable: () => false,
        beginOAuth: async () => ({ url: 'https://example.invalid' }),
        completeOAuth: async () => ({ state: 'disconnected' as const }),
        connectApiToken: async () => ({ state: 'disconnected' as const }),
      },
    });
    const host = new RecordingHost();

    const activation = activatePagesPublish(application, host);

    await Promise.resolve();
    expect(refreshStatus).not.toHaveBeenCalled();
    await activation.dispose();
  });

  it('does not scan vault file events before the user opens a plugin surface', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    const scan = vi.fn(async () => ({
      configRevision: 'config',
      digest: 'scan',
      candidates: [],
      issues: [],
    }));
    const application = new PagesPublishApplication(vault, undefined, {
      scan,
      scanDebounceMs: 0,
    });
    const host = new RecordingHost();
    const activation = activatePagesPublish(application, host);

    host.emitVaultChange();

    await Promise.resolve();
    expect(scan).not.toHaveBeenCalled();
    await activation.dispose();
  });

  it('keeps startup feedback lightweight until a plugin surface loads content', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), 'configured', 'utf8');
    const application = new PagesPublishApplication(vault, undefined, {
      scan: async () => ({
        configRevision: 'config',
        digest: 'scan',
        candidates: [],
        issues: [{
          severity: 'blocker' as const,
          code: 'content-root-missing',
          path: 'content_roots[0].path',
          message: 'Configured content root is missing; publishing is blocked.',
        }],
      }),
    });
    const host = new RecordingHost();
    const activation = activatePagesPublish(application, host);

    await vi.waitFor(() => {
      expect(host.globalFeedback?.presentation).toEqual({
        ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
      });
    });
    await host.clickGlobalFeedback();
    expect(host.openedTargets).toEqual(['publish-center']);

    await activation.dispose();
    expect(host.globalFeedback?.disposed).toBe(true);
  });
});

class RecordingHost implements PagesPublishHost {
  ribbon:
    | { icon: string; label: string; callback: () => Promise<void> }
    | undefined;
  command:
    | { id: string; name: string; callback: () => Promise<void> }
    | undefined;
  openedTargets: string[] = [];
  disposedRegistrations = 0;
  vaultChange: (() => void) | undefined;
  globalFeedback:
    | {
      presentation: GlobalUiProjection | undefined;
      callback: (route: GlobalUiRoute) => Promise<void>;
      disposed: boolean;
    }
    | undefined;

  registerRibbon(
    icon: string,
    label: string,
    callback: () => Promise<void>,
  ): () => void {
    this.ribbon = { icon, label, callback };
    return () => {
      this.disposedRegistrations += 1;
    };
  }

  registerCommand(
    id: string,
    name: string,
    callback: () => Promise<void>,
  ): () => void {
    this.command = { id, name, callback };
    return () => undefined;
  }

  registerVaultChanges(callback: () => void): () => void {
    this.vaultChange = callback;
    return () => {
      this.vaultChange = undefined;
      this.disposedRegistrations += 1;
    };
  }

  registerGlobalFeedback(
    callback: (route: GlobalUiRoute) => Promise<void>,
  ): PagesPublishGlobalFeedback {
    this.globalFeedback = { callback, presentation: undefined, disposed: false };
    return {
      update: (presentation) => {
        if (this.globalFeedback) this.globalFeedback.presentation = presentation;
      },
      dispose: () => {
        if (this.globalFeedback) this.globalFeedback.disposed = true;
      },
    };
  }

  async openWorkspace(target: 'setup' | 'publish-center'): Promise<void> {
    this.openedTargets.push(target);
  }

  async clickRibbon(): Promise<void> {
    await this.ribbon?.callback();
  }

  async runCommand(id: string): Promise<void> {
    if (this.command?.id === id) {
      await this.command.callback();
    }
  }

  async clickGlobalFeedback(): Promise<void> {
    const presentation = this.globalFeedback?.presentation;
    if (!presentation || !this.globalFeedback) return;
    await this.globalFeedback.callback(
      presentation.statusBar?.route ?? presentation.ribbon.route,
    );
  }

  emitVaultChange(): void {
    this.vaultChange?.();
  }
}
