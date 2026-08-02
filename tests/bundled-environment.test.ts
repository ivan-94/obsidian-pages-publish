import { describe, expect, it } from 'vitest';
import { BundledPublicationEnvironment } from '../src/plugin/bundled-environment';

describe('bundled publication environment', () => {
  it('uses the compatible Obsidian runtime and the engine already bundled with the plugin', async () => {
    const environment = new BundledPublicationEnvironment({
      runtimeVersion: '22.14.0',
      engineVersion: '0.1.0',
    });

    expect(environment.getStatus()).toEqual({ stage: 'idle' });
    await expect(environment.prepare()).resolves.toEqual({
      stage: 'ready',
      runtime: { source: 'obsidian', version: '22.14.0' },
      engine: { version: '0.1.0' },
    });
    expect(environment.getStatus()).toEqual({
      stage: 'ready',
      runtime: { source: 'obsidian', version: '22.14.0' },
      engine: { version: '0.1.0' },
    });
  });

  it.each([
    {
      input: { runtimeVersion: '18.20.0', engineVersion: '0.1.0' },
      message: 'runtime is not compatible',
      impact: 'Obsidian 的 Node.js 18.20.0 不在支持范围内',
    },
    {
      input: { runtimeVersion: '22.14.0', engineVersion: '   ' },
      message: 'engine version is unavailable',
      impact: '无法确认随插件安装的发布引擎版本',
    },
  ])('fails closed when the real bundled host $message', async ({ input, impact }) => {
    const environment = new BundledPublicationEnvironment(input);

    await expect(environment.prepare()).rejects.toThrow();
    const failed = environment.getStatus();
    expect(failed.stage).toBe('failed');
    expect(failed.impact).toContain(impact);
    expect(failed.nextAction).toBe('repair');
    expect(failed.detailsAvailable).toBe(true);
    await expect(environment.repair()).rejects.toThrow();
    expect(environment.getStatus().stage).toBe('failed');
  });
});
