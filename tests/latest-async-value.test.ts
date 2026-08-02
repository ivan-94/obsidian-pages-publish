import { describe, expect, it } from 'vitest';
import { LatestAsyncValue } from '../src/plugin/latest-async-value';

describe('latest async value', () => {
  it('lets a caller restore its loading UI after an older request resolves as stale', async () => {
    let resolveOlder!: (value: 'older') => void;
    const values = new LatestAsyncValue<'older' | 'newer'>();
    const older = values.resolve(() => new Promise<'older'>((resolve) => {
      resolveOlder = resolve;
    }));

    values.invalidate();
    resolveOlder('older');

    await expect(older).resolves.toBeUndefined();
  });
});
