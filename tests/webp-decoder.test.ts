import { describe, expect, it, vi } from 'vitest';
import { decodeWebpImage } from '../src/content/webp-decoder';
import { validLosslessWebp } from './image-fixtures';

describe('host WebP decoder boundary', () => {
  it('uses the host image decoder and closes the decoded bitmap', async () => {
    const close = vi.fn();
    const createBitmap = vi.fn(async (_source: Blob) => ({
      width: 1,
      height: 1,
      close,
    }));

    await expect(
      decodeWebpImage(validLosslessWebp, undefined, createBitmap),
    ).resolves.toEqual({ width: 1, height: 1 });

    expect(createBitmap).toHaveBeenCalledOnce();
    expect(createBitmap.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns caller cancellation without waiting for an in-flight host decode', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancel WebP decode');
    const createBitmap = vi.fn(
      async () => new Promise<never>(() => undefined),
    );
    const decoding = decodeWebpImage(
      validLosslessWebp,
      controller.signal,
      createBitmap,
    );

    controller.abort(cancellation);

    await expect(decoding).rejects.toBe(cancellation);
  });
});
