export interface DecodedWebpDimensions {
  width: number;
  height: number;
}

export interface DecodedWebpBitmap extends DecodedWebpDimensions {
  close(): void;
}

export interface WebpBitmapFactory {
  (source: Blob): Promise<DecodedWebpBitmap>;
}

export interface WebpDecoderBoundary {
  (
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DecodedWebpDimensions | undefined>;
}

export async function decodeWebpImage(
  content: Uint8Array,
  signal?: AbortSignal,
  createBitmap: WebpBitmapFactory = createHostBitmap,
): Promise<DecodedWebpDimensions | undefined> {
  const exactContent = new ArrayBuffer(content.byteLength);
  new Uint8Array(exactContent).set(content);
  let bitmap: DecodedWebpBitmap | undefined;
  let decodePromise: Promise<DecodedWebpBitmap> | undefined;
  let abortFromCaller: (() => void) | undefined;
  try {
    throwIfAborted(signal);
    decodePromise = createBitmap(
      new Blob([exactContent], { type: 'image/webp' }),
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      abortFromCaller = () => reject(abortReason(signal));
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    });
    bitmap = await Promise.race([decodePromise, aborted]);
    throwIfAborted(signal);
    if (bitmap.width <= 0 || bitmap.height <= 0) return undefined;
    return { width: bitmap.width, height: bitmap.height };
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return undefined;
  } finally {
    if (abortFromCaller) {
      signal?.removeEventListener('abort', abortFromCaller);
    }
    if (bitmap) {
      bitmap.close();
    } else {
      decodePromise?.then((decoded) => decoded.close()).catch(() => undefined);
    }
  }
}

const createHostBitmap: WebpBitmapFactory = async (source) => {
  if (typeof window.createImageBitmap !== 'function') {
    throw new Error('The host does not provide an image decoder.');
  }
  return window.createImageBitmap(source);
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('WebP decode aborted.', 'AbortError');
}
