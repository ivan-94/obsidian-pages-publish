import { describe, expect, it, vi } from 'vitest';
import {
  BoundedDiagnosticLog,
  MaintenanceActionUnavailableError,
  MaintenanceConfirmationRequiredError,
  MaintenanceRetentionCoordinator,
  PagesPublishMaintenanceService,
} from '../src/maintenance/maintenance-service';

describe('Pages Publish maintenance service', () => {
  it('bounds retained logs by entry count and bytes using structured non-content entries', () => {
    const log = new BoundedDiagnosticLog(2);

    log.append({ at: '2026-08-01T10:00:00Z', stage: 'scan', code: 'scan-complete' });
    log.append({ at: '2026-08-01T10:01:00Z', stage: 'upload', code: 'upload-failed' });
    log.append({ at: '2026-08-01T10:02:00Z', stage: 'activate', code: 'activation-failed' });

    expect(log.entries()).toEqual([
      { at: '2026-08-01T10:01:00Z', stage: 'upload', code: 'upload-failed' },
      { at: '2026-08-01T10:02:00Z', stage: 'activate', code: 'activation-failed' },
    ]);
  });

  it('prunes old, oversized logs/builds/receipts but never an in-progress recovery receipt', async () => {
    const remove = vi.fn(async () => undefined);
    const coordinator = new MaintenanceRetentionCoordinator({
      now: () => new Date('2026-08-10T00:00:00.000Z'),
      policy: { maxAgeMs: 7 * 24 * 60 * 60 * 1_000, maxEntries: 2, maxBytes: 100 },
      targets: {
        logs: {
          list: async () => [
            { id: 'old-log', createdAt: '2026-07-01T00:00:00.000Z', bytes: 20 },
            { id: 'fresh-log', createdAt: '2026-08-09T00:00:00.000Z', bytes: 20 },
            { id: 'oldest-fresh-log', createdAt: '2026-08-07T00:00:00.000Z', bytes: 20 },
            { id: 'middle-fresh-log', createdAt: '2026-08-08T00:00:00.000Z', bytes: 20 },
          ],
          remove,
        },
        builds: {
          list: async () => [
            { id: 'large-build', createdAt: '2026-08-09T00:00:00.000Z', bytes: 90 },
            { id: 'older-build', createdAt: '2026-08-08T00:00:00.000Z', bytes: 90 },
          ],
          remove,
        },
        receipts: {
          list: async () => [
            { id: 'in-progress', createdAt: '2026-07-01T00:00:00.000Z', bytes: 20, inProgress: true },
            { id: 'stale-receipt', createdAt: '2026-07-01T00:00:00.000Z', bytes: 20 },
          ],
          remove,
        },
      },
    });

    await expect(coordinator.prune()).resolves.toEqual({
      logs: ['old-log', 'oldest-fresh-log'],
      builds: ['older-build'],
      receipts: ['stale-receipt'],
    });
    expect(remove).toHaveBeenCalledWith('old-log');
    expect(remove).toHaveBeenCalledWith('oldest-fresh-log');
    expect(remove).toHaveBeenCalledWith('older-build');
    expect(remove).toHaveBeenCalledWith('stale-receipt');
    expect(remove).not.toHaveBeenCalledWith('in-progress');
  });

  it('keeps ordinary settings saves separate from remote maintenance actions', async () => {
    const repair = vi.fn(async () => ({ stage: 'ready' as const }));
    const clear = vi.fn(async () => undefined);
    const service = new PagesPublishMaintenanceService({
      environment: { getStatus: () => ({ stage: 'ready' as const }), repair },
      cache: { clear },
      connection: { refreshStatus: vi.fn(async () => ({ state: 'connected' as const })) },
      diagnostics: {
        collect: async () => ({ pluginVersion: '0.1.0', platform: 'darwin', logs: [] }),
        write: async () => '/tmp/diagnostics.json',
      },
    });

    expect(service.getStatus()).toEqual({
      environment: { stage: 'ready' },
      cache: { state: 'ready' },
      connection: { state: 'unchecked' },
      capabilities: { repairEnvironment: true, refreshConnection: true, openLogs: false },
    });
    expect(repair).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('exports a confirmation-gated diagnostic file with credentials, private paths, and content redacted', async () => {
    const write = vi.fn(async (source: string) => {
      expect(source).not.toContain('Bearer private-token');
      expect(source).not.toContain('Authorization');
      expect(source).not.toContain('private/secret.md');
      expect(source).not.toContain('Private article body');
      expect(source).not.toContain('token=private-token');
      return '/tmp/pages-publish-diagnostics.json';
    });
    const service = new PagesPublishMaintenanceService({
      cache: { clear: async () => undefined },
      diagnostics: {
        collect: async () => ({
          pluginVersion: '0.1.0',
          platform: 'darwin-arm64',
          config: {
            cloudflare: { projectName: 'safe-project', authorization: 'Basic base64-secret' },
            privatePath: 'notes/private/foo.md',
            body: 'Arbitrary article body must never enter diagnostics',
          },
          logs: [
            { at: '2026-08-01T10:00:00Z', stage: 'upload', code: 'upload-failed' },
          ],
          error: { stage: 'upload', code: 'upload-failed' },
        }),
        write,
      },
    });

    expect(service.describeDiagnosticExport()).toEqual({
      included: ['plugin-version', 'platform', 'redacted-config', 'redacted-status', 'safe-logs'],
      excluded: ['credentials', 'authorization-headers', 'article-content', 'private-paths', 'build-output'],
    });
    await expect(service.exportDiagnostics()).rejects.toBeInstanceOf(
      MaintenanceConfirmationRequiredError,
    );
    await expect(service.exportDiagnostics({ confirmed: true })).resolves.toEqual({
      path: '/tmp/pages-publish-diagnostics.json',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses diagnostics whose runtime boundary tries to smuggle credentials through typed fields', async () => {
    const write = vi.fn(async () => '/tmp/should-not-exist.json');
    const service = new PagesPublishMaintenanceService({
      cache: { clear: async () => undefined },
      diagnostics: {
        collect: async () => ({
          pluginVersion: '0.1.0',
          platform: 'darwin',
          logs: [{
            at: 'Authorization: Basic secret',
            stage: 'private-path',
            code: 'upload-failed',
          } as unknown as { at: string; stage: 'upload'; code: string }],
        }),
        write,
      },
    });

    await expect(service.exportDiagnostics({ confirmed: true })).rejects.toThrow('safe timestamps');
    expect(write).not.toHaveBeenCalled();
  });

  it('runs repair, cache cleanup, and connection refresh only when the user requests each action', async () => {
    const repair = vi.fn(async () => ({ stage: 'ready' as const }));
    const clear = vi.fn(async () => undefined);
    const refreshStatus = vi.fn(async () => ({ state: 'expired' as const }));
    const service = new PagesPublishMaintenanceService({
      environment: { getStatus: () => ({ stage: 'failed' as const }), repair },
      cache: { clear },
      connection: { refreshStatus },
      diagnostics: {
        collect: async () => ({ pluginVersion: '0.1.0', platform: 'darwin', logs: [] }),
        write: async () => '/tmp/diagnostics.json',
      },
    });

    await service.repairEnvironment();
    await service.clearRebuildableCache();
    await service.refreshConnection();

    expect(repair).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toEqual({
      environment: { stage: 'ready' },
      cache: { state: 'cleared' },
      connection: { state: 'expired' },
      capabilities: { repairEnvironment: true, refreshConnection: true, openLogs: false },
    });
  });

  it('projects a user-requested environment repair while the host operation is still in flight', async () => {
    let finishRepair!: () => void;
    const service = new PagesPublishMaintenanceService({
      environment: {
        getStatus: () => ({ stage: 'ready' }),
        repair: async () => new Promise<{ stage: string }>((resolve) => {
          finishRepair = () => resolve({ stage: 'ready' });
        }),
      },
      cache: { clear: async () => undefined },
      diagnostics: {
        collect: async () => ({ pluginVersion: '0.1.0', platform: 'darwin', logs: [] }),
        write: async () => '/tmp/diagnostics.json',
      },
    });

    const repair = service.repairEnvironment();
    expect(service.getStatus().environment).toEqual({ stage: 'repairing' });
    finishRepair();
    await repair;
    expect(service.getStatus().environment).toEqual({ stage: 'ready' });
  });

  it('rejects unavailable optional host actions instead of reporting a false success', async () => {
    const service = new PagesPublishMaintenanceService({
      cache: { clear: async () => undefined },
      diagnostics: {
        collect: async () => ({ pluginVersion: '0.1.0', platform: 'darwin', logs: [] }),
        write: async () => '/tmp/diagnostics.json',
      },
    });

    expect(service.getStatus().capabilities).toEqual({
      repairEnvironment: false,
      refreshConnection: false,
      openLogs: false,
    });
    await expect(service.repairEnvironment()).rejects.toBeInstanceOf(MaintenanceActionUnavailableError);
    await expect(service.refreshConnection()).rejects.toBeInstanceOf(MaintenanceActionUnavailableError);
    await expect(service.openLogs()).rejects.toBeInstanceOf(MaintenanceActionUnavailableError);
  });
});
