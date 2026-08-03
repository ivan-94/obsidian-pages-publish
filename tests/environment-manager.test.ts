import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  compatibleNodeVersion,
  PublicationEnvironmentManager,
} from '../src/runtime/environment-manager';

describe('publication environment manager', () => {
  it('requires Node 22 or newer for the Quartz engine', () => {
    expect(compatibleNodeVersion('20.19.1')).toBe(false);
    expect(compatibleNodeVersion('22.0.0')).toBe(true);
  });

  it('reuses a compatible system Node without downloading or changing it', async () => {
    const fetchRelease = vi.fn();
    const download = vi.fn();
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => ({
        executable: '/usr/local/bin/node',
        version: '22.14.0',
      }),
      fetchRelease,
      download,
      store: {
        read: async () => ({
          engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
        }),
        install: async () => undefined,
      },
    });

    const status = await manager.prepare();

    expect(status).toMatchObject({
      stage: 'ready',
      runtime: { source: 'system', version: '22.14.0' },
      engine: { version: '1.0.0' },
    });
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('uses a verified managed runtime when system Node is incompatible', async () => {
    const fetchRelease = vi.fn();
    const download = vi.fn();
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => ({
        executable: '/usr/local/bin/node',
        version: '18.20.4',
      }),
      fetchRelease,
      download,
      store: {
        read: async () => ({
          runtime: { version: '22.14.0', sha256: 'b'.repeat(64) },
          engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
        }),
        install: async () => undefined,
      },
    });

    await expect(manager.prepare()).resolves.toMatchObject({
      stage: 'ready',
      runtime: { source: 'managed', version: '22.14.0' },
      engine: { version: '1.0.0' },
    });
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads and verifies the trusted runtime and engine before installing them', async () => {
    const runtimeContent = new TextEncoder().encode('managed node runtime');
    const engineContent = new TextEncoder().encode('pages publication engine');
    const runtime = {
      version: '22.14.0',
      url: 'https://releases.pages-publish.dev/node-22.14.0.tar.gz',
      sha256: sha256(runtimeContent),
    };
    const engine = {
      version: '1.0.0',
      url: 'https://releases.pages-publish.dev/engine-1.0.0.tar.gz',
      sha256: sha256(engineContent),
    };
    const install = vi.fn(async () => undefined);
    const download = vi.fn(async (url: string) =>
      url === runtime.url ? runtimeContent : engineContent,
    );
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => undefined,
      fetchRelease: async () => ({ runtime, engine }),
      download,
      store: { read: async () => undefined, install },
    });

    await expect(manager.prepare()).resolves.toMatchObject({
      stage: 'ready',
      runtime: { source: 'managed', version: '22.14.0' },
      engine: { version: '1.0.0' },
    });
    expect(download).toHaveBeenCalledWith(runtime.url);
    expect(download).toHaveBeenCalledWith(engine.url);
    expect(install).toHaveBeenCalledWith(
      {
        runtime: { version: runtime.version, sha256: runtime.sha256 },
        engine: { version: engine.version, sha256: engine.sha256 },
      },
      { runtime: runtimeContent, engine: engineContent },
    );
  });

  it('keeps the last verified environment when a repair download fails checksum validation', async () => {
    const verified = {
      runtime: { version: '22.14.0', sha256: 'b'.repeat(64) },
      engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
    };
    const install = vi.fn(async () => undefined);
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => undefined,
      fetchRelease: async () => ({
        runtime: {
          version: '22.14.1',
          url: 'https://releases.pages-publish.dev/node-22.14.1.tar.gz',
          sha256: 'c'.repeat(64),
        },
        engine: {
          version: '1.0.1',
          url: 'https://releases.pages-publish.dev/engine-1.0.1.tar.gz',
          sha256: 'd'.repeat(64),
        },
      }),
      download: async () => new TextEncoder().encode('tampered download'),
      store: { read: async () => verified, install },
    });

    await expect(manager.repair()).rejects.toThrow('runtime download checksum');
    expect(install).not.toHaveBeenCalled();
    await expect(manager.prepare()).resolves.toMatchObject({
      runtime: { source: 'managed', version: '22.14.0' },
      engine: { version: '1.0.0' },
    });
  });

  it('does not install a signed release when a supplied signature fails verification', async () => {
    const runtimeContent = new TextEncoder().encode('signed runtime');
    const engineContent = new TextEncoder().encode('signed engine');
    const runtime = {
      version: '22.14.0',
      url: 'https://releases.pages-publish.dev/node-22.14.0.tar.gz',
      sha256: sha256(runtimeContent),
      signature: 'runtime-signature',
    };
    const engine = {
      version: '1.0.0',
      url: 'https://releases.pages-publish.dev/engine-1.0.0.tar.gz',
      sha256: sha256(engineContent),
      signature: 'engine-signature',
    };
    const install = vi.fn(async () => undefined);
    const verifySignature = vi.fn(async (signature: string) =>
      signature === 'runtime-signature',
    );
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => undefined,
      fetchRelease: async () => ({ runtime, engine }),
      download: async (url) => (url === runtime.url ? runtimeContent : engineContent),
      verifySignature,
      store: { read: async () => undefined, install },
    });

    await expect(manager.prepare()).rejects.toThrow('engine release signature');
    expect(verifySignature).toHaveBeenCalledTimes(2);
    expect(install).not.toHaveBeenCalled();
  });

  it('reports an actionable failure when no verified environment can be prepared', async () => {
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => undefined,
      fetchRelease: async () => {
        throw new Error('offline');
      },
      download: async () => new Uint8Array(),
      store: { read: async () => undefined, install: async () => undefined },
    });

    await expect(manager.prepare()).rejects.toThrow('offline');
    expect(manager.getStatus()).toMatchObject({
      stage: 'failed',
      impact: '本地预览和发布暂不可用。',
      nextAction: 'repair',
      detailsAvailable: true,
    });
  });

  it('coalesces concurrent prepare requests instead of running two environment transactions', async () => {
    const runtimeContent = new TextEncoder().encode('runtime');
    const engineContent = new TextEncoder().encode('engine');
    let releaseInspection: (() => void) | undefined;
    let inspections = 0;
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => {
        inspections += 1;
        if (inspections > 1) throw new Error('duplicate environment inspection');
        await new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
        return undefined;
      },
      fetchRelease: async () => ({
        runtime: {
          version: '22.14.0',
          url: 'https://releases.pages-publish.dev/node-22.14.0.tar.gz',
          sha256: sha256(runtimeContent),
        },
        engine: {
          version: '1.0.0',
          url: 'https://releases.pages-publish.dev/engine-1.0.0.tar.gz',
          sha256: sha256(engineContent),
        },
      }),
      download: async (url) => (url.includes('node-') ? runtimeContent : engineContent),
      store: { read: async () => undefined, install: async () => undefined },
    });

    const first = manager.prepare();
    await vi.waitFor(() => expect(inspections).toBe(1));
    const second = manager.prepare();
    releaseInspection?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ stage: 'ready' }),
      expect.objectContaining({ stage: 'ready' }),
    ]);
    expect(inspections).toBe(1);
  });

  it('does not overlap repair with an in-progress environment preparation', async () => {
    const runtimeContent = new TextEncoder().encode('runtime');
    const engineContent = new TextEncoder().encode('engine');
    let releaseInspection: (() => void) | undefined;
    let releaseFirstRelease: (() => void) | undefined;
    let releases = 0;
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => {
        await new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
        return undefined;
      },
      fetchRelease: async () => {
        releases += 1;
        if (releases === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstRelease = resolve;
          });
        }
        return {
          runtime: {
            version: '22.14.0',
            url: 'https://releases.pages-publish.dev/node-22.14.0.tar.gz',
            sha256: sha256(runtimeContent),
          },
          engine: {
            version: '1.0.0',
            url: 'https://releases.pages-publish.dev/engine-1.0.0.tar.gz',
            sha256: sha256(engineContent),
          },
        };
      },
      download: async (url) => (url.includes('node-') ? runtimeContent : engineContent),
      store: { read: async () => undefined, install: async () => undefined },
    });

    const prepare = manager.prepare();
    await vi.waitFor(() => expect(releaseInspection).toBeTypeOf('function'));
    const repair = manager.repair();
    releaseInspection?.();
    await vi.waitFor(() => expect(releases).toBe(1));
    expect(releases).toBe(1);
    releaseFirstRelease?.();

    await expect(Promise.all([prepare, repair])).resolves.toHaveLength(2);
    expect(releases).toBe(2);
  });

  it('queues an explicit repair behind a system-runtime preparation instead of swallowing it', async () => {
    const runtimeContent = new TextEncoder().encode('managed runtime');
    const engineContent = new TextEncoder().encode('managed engine');
    let releaseInspection: (() => void) | undefined;
    const fetchRelease = vi.fn(async () => ({
      runtime: {
        version: '22.14.0',
        url: 'https://releases.pages-publish.dev/node-22.14.0.tar.gz',
        sha256: sha256(runtimeContent),
      },
      engine: {
        version: '1.0.1',
        url: 'https://releases.pages-publish.dev/engine-1.0.1.tar.gz',
        sha256: sha256(engineContent),
      },
    }));
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => {
        await new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
        return { executable: '/usr/local/bin/node', version: '22.14.0' };
      },
      fetchRelease,
      download: async (url) => (url.includes('node-') ? runtimeContent : engineContent),
      store: {
        read: async () => ({
          engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
        }),
        install: async () => undefined,
      },
    });

    const prepare = manager.prepare();
    await vi.waitFor(() => expect(releaseInspection).toBeTypeOf('function'));
    const repair = manager.repair();
    releaseInspection?.();

    await expect(prepare).resolves.toMatchObject({
      runtime: { source: 'system', version: '22.14.0' },
      engine: { version: '1.0.0' },
    });
    await expect(repair).resolves.toMatchObject({
      runtime: { source: 'managed', version: '22.14.0' },
      engine: { version: '1.0.1' },
    });
    expect(fetchRelease).toHaveBeenCalledTimes(1);
  });
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
