import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicationEnvironmentManager } from '../src/runtime/environment-manager';

describe('publication environment manager', () => {
  it('reuses a compatible system Node without downloading or changing it', async () => {
    const fetchRelease = vi.fn();
    const download = vi.fn();
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => ({
        executable: '/usr/local/bin/node',
        version: '20.19.1',
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
      runtime: { source: 'system', version: '20.19.1' },
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
          runtime: { version: '20.19.1', sha256: 'b'.repeat(64) },
          engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
        }),
        install: async () => undefined,
      },
    });

    await expect(manager.prepare()).resolves.toMatchObject({
      stage: 'ready',
      runtime: { source: 'managed', version: '20.19.1' },
      engine: { version: '1.0.0' },
    });
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads and verifies the trusted runtime and engine before installing them', async () => {
    const runtimeContent = new TextEncoder().encode('managed node runtime');
    const engineContent = new TextEncoder().encode('pages publication engine');
    const runtime = {
      version: '20.19.1',
      url: 'https://releases.pages-publish.dev/node-20.19.1.tar.gz',
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
      runtime: { source: 'managed', version: '20.19.1' },
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
      runtime: { version: '20.19.1', sha256: 'b'.repeat(64) },
      engine: { version: '1.0.0', sha256: 'a'.repeat(64) },
    };
    const install = vi.fn(async () => undefined);
    const manager = new PublicationEnvironmentManager({
      inspectSystemNode: async () => undefined,
      fetchRelease: async () => ({
        runtime: {
          version: '20.19.2',
          url: 'https://releases.pages-publish.dev/node-20.19.2.tar.gz',
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
      runtime: { source: 'managed', version: '20.19.1' },
      engine: { version: '1.0.0' },
    });
  });

  it('does not install a signed release when a supplied signature fails verification', async () => {
    const runtimeContent = new TextEncoder().encode('signed runtime');
    const engineContent = new TextEncoder().encode('signed engine');
    const runtime = {
      version: '20.19.1',
      url: 'https://releases.pages-publish.dev/node-20.19.1.tar.gz',
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
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
