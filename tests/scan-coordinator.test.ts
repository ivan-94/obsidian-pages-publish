import { describe, expect, it, vi } from 'vitest';
import {
  ContentScanCoordinator,
  type ImmediateScanTrigger,
} from '../src/content/scan-coordinator';

describe('content scan coordinator', () => {
  it('runs each explicit lifecycle and user trigger through the same scanner', async () => {
    const scan = vi.fn(async ({ trigger }: { trigger: string }) => ({ trigger }));
    const coordinator = new ContentScanCoordinator(scan);
    const triggers: ImmediateScanTrigger[] = [
      'plugin-load',
      'config-save',
      'manual-refresh',
      'preview',
      'publish',
    ];

    const results = [];
    for (const trigger of triggers) {
      results.push(await coordinator.request(trigger));
    }

    expect(results.map((result) => result.value.trigger)).toEqual(triggers);
    expect(scan).toHaveBeenCalledTimes(triggers.length);
  });

  it('debounces file changes into one scan', async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(async ({ trigger }: { trigger: string }) => ({ trigger }));
      const coordinator = new ContentScanCoordinator(scan, { debounceMs: 200 });

      const first = coordinator.request('file-change');
      const second = coordinator.request('file-change');

      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(199);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const results = await Promise.all([first, second]);

      expect(scan).toHaveBeenCalledOnce();
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.value.trigger).toBe('file-change');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks an older completion stale so it cannot replace the latest result', async () => {
    const completions = new Map<
      number,
      (value: { version: number }) => void
    >();
    const signals = new Map<number, AbortSignal>();
    const scan = vi.fn(
      ({ requestId, signal }: { requestId: number; signal: AbortSignal }) =>
        new Promise<{ version: number }>((resolve) => {
          signals.set(requestId, signal);
          completions.set(requestId, resolve);
        }),
    );
    const coordinator = new ContentScanCoordinator(scan);

    const older = coordinator.request('plugin-load');
    const newer = coordinator.request('manual-refresh');
    completions.get(2)?.({ version: 2 });
    const newerResult = await newer;
    completions.get(1)?.({ version: 1 });
    const olderResult = await older;

    expect(signals.get(1)?.aborted).toBe(true);
    expect(newerResult.status).toBe('applied');
    expect(olderResult.status).toBe('stale');
    expect(coordinator.getLatest()?.value).toEqual({ version: 2 });
  });

  it('invalidates an active non-cooperative scan and refuses new work after dispose', async () => {
    let complete: ((value: { version: number }) => void) | undefined;
    const scan = vi.fn(
      () =>
        new Promise<{ version: number }>((resolve) => {
          complete = resolve;
        }),
    );
    const coordinator = new ContentScanCoordinator(scan);
    const active = coordinator.request('plugin-load');

    coordinator.dispose();
    complete?.({ version: 1 });

    await expect(active).resolves.toMatchObject({ status: 'stale' });
    expect(coordinator.getLatest()).toBeUndefined();
    await expect(coordinator.request('manual-refresh')).rejects.toThrow(
      /disposed/,
    );
    expect(scan).toHaveBeenCalledOnce();
  });
});
