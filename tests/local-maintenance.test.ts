import { describe, expect, it, vi } from 'vitest';
import {
  createLocalMaintenanceService,
} from '../src/maintenance/local-maintenance';
import { BoundedDiagnosticLog } from '../src/maintenance/maintenance-service';

type Node = {
  type: 'file' | 'folder';
  mtime: number;
  size: number;
};

class FakeDataAdapter {
  readonly remove = vi.fn(async (path: string) => {
    this.nodes.delete(path);
  });
  readonly rmdir = vi.fn(async (path: string, recursive: boolean) => {
    if (!recursive) throw new Error('Retention must remove build artifacts recursively.');
    for (const key of this.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    }
  });
  readonly write = vi.fn(async (path: string, data: string) => {
    this.addFile(path, data.length, Date.now());
  });
  readonly mkdir = vi.fn(async (path: string) => {
    this.addFolder(path, Date.now());
  });
  private readonly nodes = new Map<string, Node>();

  addFolder(path: string, mtime: number): void {
    this.ensureParents(path, mtime);
    this.nodes.set(path, { type: 'folder', mtime, size: 0 });
  }

  addFile(path: string, size: number, mtime: number): void {
    this.ensureParents(parentPath(path), mtime);
    this.nodes.set(path, { type: 'file', mtime, size });
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    for (const [candidate, node] of this.nodes) {
      if (parentPath(candidate) !== path) continue;
      if (node.type === 'file') files.push(candidate);
      else folders.push(candidate);
    }
    return { files, folders };
  }

  async stat(path: string): Promise<Node | null> {
    return this.nodes.get(path) ?? null;
  }

  private ensureParents(path: string, mtime: number): void {
    if (!path) return;
    this.ensureParents(parentPath(path), mtime);
    if (!this.nodes.has(path)) this.nodes.set(path, { type: 'folder', mtime, size: 0 });
  }
}

function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe('local maintenance adapter integration', () => {
  it('exposes the same host environment through maintenance and repair', async () => {
    const adapter = new FakeDataAdapter();
    const repair = vi.fn(async () => ({ stage: 'ready' }));
    const service = createLocalMaintenanceService({
      directory: 'plugin/maintenance',
      pluginVersion: '0.1.0',
      platform: 'darwin',
      adapter: adapter as unknown as import('obsidian').DataAdapter,
      environment: {
        getStatus: () => ({ stage: 'ready' }),
        repair,
      },
    });

    expect(service.getStatus()).toMatchObject({
      environment: { stage: 'ready' },
      capabilities: { repairEnvironment: true },
    });
    await service.repairEnvironment();
    expect(repair).toHaveBeenCalledOnce();
  });

  it('exposes a host-provided safe-log view and includes only structured log data in diagnostics', async () => {
    const adapter = new FakeDataAdapter();
    const log = new BoundedDiagnosticLog();
    const open = vi.fn(async () => undefined);
    log.append({
      at: '2026-08-01T12:00:00.000Z',
      stage: 'upload',
      code: 'upload-failed',
      counts: { files: 3 },
    });
    const service = createLocalMaintenanceService({
      directory: 'plugin/maintenance',
      pluginVersion: '0.1.0',
      platform: 'darwin',
      adapter: adapter as unknown as import('obsidian').DataAdapter,
      diagnosticLog: log,
      logs: { open },
    });

    expect(service.getStatus().capabilities.openLogs).toBe(true);
    await service.openLogs();
    expect(open).toHaveBeenCalledOnce();
    await service.exportDiagnostics({ confirmed: true });
    expect(adapter.write).toHaveBeenCalledWith(
      expect.stringMatching(/diagnostics\/diagnostics-/u),
      expect.stringContaining('upload-failed'),
    );
  });

  it('best-effort prunes old files and complete build directories at startup without deleting recovery', async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFile('plugin/maintenance/logs/old.log', 10, 0);
    adapter.addFile('plugin/maintenance/receipts/old-receipt.json', 10, 0);
    adapter.addFile('plugin/maintenance/receipts/deployment-recovery.json', 10, 0);
    adapter.addFile('plugin/maintenance/receipts/activation-pending.json', 10, 0);
    adapter.addFolder('plugin/maintenance/builds/old-build', 0);
    adapter.addFile('plugin/maintenance/builds/old-build/assets/data.js', 64, 0);
    adapter.addFolder('plugin/maintenance/builds/current-build', 0);
    adapter.addFile('plugin/maintenance/builds/current-build/assets/data.js', 64, Date.now());

    createLocalMaintenanceService({
      directory: 'plugin/maintenance',
      pluginVersion: '0.1.0',
      platform: 'darwin',
      adapter: adapter as unknown as import('obsidian').DataAdapter,
    });

    await waitFor(() => {
      expect(adapter.rmdir).toHaveBeenCalledWith(
        'plugin/maintenance/builds/old-build',
        true,
      );
    });
    expect(adapter.remove).toHaveBeenCalledWith('plugin/maintenance/logs/old.log');
    expect(adapter.remove).toHaveBeenCalledWith('plugin/maintenance/receipts/old-receipt.json');
    expect(adapter.remove).not.toHaveBeenCalledWith(
      'plugin/maintenance/receipts/deployment-recovery.json',
    );
    expect(adapter.remove).not.toHaveBeenCalledWith(
      'plugin/maintenance/receipts/activation-pending.json',
    );
    expect(adapter.rmdir).not.toHaveBeenCalledWith(
      'plugin/maintenance/builds/current-build',
      true,
    );
  });

  it('prunes new retained data after a confirmed export and rebuilds only the local cache', async () => {
    const adapter = new FakeDataAdapter();
    adapter.addFolder('plugin/maintenance/cache', 0);
    adapter.addFile('plugin/maintenance/cache/rebuildable.json', 10, 0);
    const service = createLocalMaintenanceService({
      directory: 'plugin/maintenance',
      pluginVersion: '0.1.0',
      platform: 'darwin',
      adapter: adapter as unknown as import('obsidian').DataAdapter,
    });
    await service.clearRebuildableCache();
    expect(adapter.rmdir).toHaveBeenCalledWith('plugin/maintenance/cache', true);
    expect(adapter.mkdir).toHaveBeenCalledWith('plugin/maintenance/cache');

    adapter.addFile('plugin/maintenance/logs/late-old.log', 10, 0);
    const exported = await service.exportDiagnostics({ confirmed: true });
    expect(exported.path).toMatch(/^plugin\/maintenance\/diagnostics\/diagnostics-/u);
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.remove).toHaveBeenCalledWith('plugin/maintenance/logs/late-old.log');
  });
});
