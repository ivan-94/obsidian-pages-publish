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

    await expect(environment.prepare()).rejects.toThrow('offline');
    expect(environment.getStatus()).toMatchObject({
      stage: 'failed',
      nextAction: 'repair',
      detailsAvailable: true,
    });
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
