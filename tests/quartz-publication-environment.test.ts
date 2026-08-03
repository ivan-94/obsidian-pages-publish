import { describe, expect, it, vi } from 'vitest';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import { QuartzPublicationEnvironment } from '../src/plugin/quartz-publication-environment';

describe('Quartz publication environment', () => {
  it('prepares the managed runtime and verified Quartz engine once', async () => {
    const runtime = {
      nodeExecutable: '/runtime/node',
      nodeVersion: '22.23.1',
      npmCliPath: '/runtime/npm-cli.js',
      npmVersion: '10.9.8',
    };
    const engine = readyEngine();
    const ensureRuntime = vi.fn(async () => runtime);
    const ensureEngine = vi.fn(async () => engine);
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime,
      ensureEngine,
    });

    await expect(environment.ensureReady()).resolves.toEqual(engine);
    await expect(environment.prepare()).resolves.toMatchObject({
      stage: 'ready',
      runtime: { source: 'managed', version: '22.23.1' },
      engine: { version: 'pages-publish-quartz-5.0.0.1' },
    });
    expect(ensureRuntime).toHaveBeenCalledOnce();
    expect(ensureEngine).toHaveBeenCalledOnce();
  });

  it('reports an actionable failure without discarding a store-level fallback', async () => {
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime: async () => {
        throw new Error('offline');
      },
      ensureEngine: async () => readyEngine(),
    });

    await expect(environment.prepare()).rejects.toMatchObject({
      code: 'quartz-engine-unavailable',
    });
    expect(environment.getStatus()).toMatchObject({
      stage: 'failed',
      nextAction: 'repair',
      detailsAvailable: true,
    });
  });

  it('queues Repair behind preparation and forces both managed stores to repair', async () => {
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const runtime = {
      nodeExecutable: '/runtime/node',
      nodeVersion: '22.23.1',
      npmCliPath: '/runtime/npm-cli.js',
      npmVersion: '10.9.8',
    };
    const ensureRuntime = vi.fn(async () => {
      await preparationGate;
      return runtime;
    });
    const repairRuntime = vi.fn(async () => runtime);
    const repairEngine = vi.fn(async () => readyEngine());
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime,
      ensureEngine: async () => readyEngine(),
      repairRuntime,
      repairEngine,
    });

    const preparation = environment.prepare();
    const repair = environment.repair();
    expect(repairRuntime).not.toHaveBeenCalled();
    releasePreparation();

    await expect(preparation).resolves.toMatchObject({ stage: 'ready' });
    await expect(repair).resolves.toMatchObject({ stage: 'ready' });
    expect(repairRuntime).toHaveBeenCalledOnce();
    expect(repairEngine).toHaveBeenCalledOnce();
  });

  it('publishes observable install stages and returns to idle when preparation is cancelled', async () => {
    const observed: string[] = [];
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime: async (signal, reportProgress) => {
        reportProgress?.('downloading-runtime');
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        });
        throw new Error('unreachable');
      },
      ensureEngine: async () => readyEngine(),
    });
    environment.subscribe(() => observed.push(environment.getStatus().stage));

    const preparation = environment.prepare();
    await vi.waitFor(() => {
      expect(environment.getStatus().stage).toBe('downloading-runtime');
    });
    expect(environment.cancel()).toBe(true);

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(environment.getStatus().stage).toBe('idle');
    expect(environment.getStatus().impact).toContain('已取消');
    expect(environment.getStatus()).toMatchObject({
      nextAction: 'repair',
      detailsAvailable: true,
    });
    expect(observed).toContain('checking-system');
    expect(observed).toContain('downloading-runtime');
    expect(observed.at(-1)).toBe('idle');
  });

  it('reports runtime, install, and smoke phases before ready', async () => {
    const observed: string[] = [];
    const runtime = {
      nodeExecutable: '/runtime/node',
      nodeVersion: '22.23.1',
      npmCliPath: '/runtime/npm-cli.js',
      npmVersion: '10.9.8',
    };
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime: async (_signal, reportProgress) => {
        reportProgress?.('downloading-runtime');
        reportProgress?.('installing-runtime');
        return runtime;
      },
      ensureEngine: async (_runtime, _signal, reportProgress) => {
        reportProgress?.('downloading-engine');
        reportProgress?.('installing-engine');
        reportProgress?.('smoke-testing');
        return readyEngine();
      },
    });
    environment.subscribe(() => observed.push(environment.getStatus().stage));

    await environment.prepare();

    expect(observed).toEqual([
      'checking-system',
      'downloading-runtime',
      'installing-runtime',
      'verifying-engine',
      'downloading-engine',
      'installing-engine',
      'smoke-testing',
      'ready',
    ]);
  });

  it('does not let a failing status observer break environment preparation', async () => {
    const environment = new QuartzPublicationEnvironment({
      platform: 'darwin-arm64',
      ensureRuntime: async () => ({
        nodeExecutable: '/runtime/node',
        nodeVersion: '22.23.1',
        npmCliPath: '/runtime/npm-cli.js',
        npmVersion: '10.9.8',
      }),
      ensureEngine: async () => readyEngine(),
    });
    environment.subscribe(() => {
      throw new Error('broken UI observer');
    });

    await expect(environment.prepare()).resolves.toMatchObject({ stage: 'ready' });
  });
});

function readyEngine(): ReadyQuartzEngine {
  return {
    engineDirectory: '/engine',
    engineVersion: 'pages-publish-quartz-5.0.0.1',
    quartzVersion: '5.0.0',
    platform: 'darwin-arm64',
    nodeExecutable: '/runtime/node',
    nodeVersion: '22.23.1',
    npmCliPath: '/runtime/npm-cli.js',
    npmVersion: '10.9.8',
    usingFallback: false,
  };
}
