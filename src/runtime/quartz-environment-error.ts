export type QuartzEnvironmentErrorCode =
  | 'publication-environment-disk-insufficient'
  | 'node-runtime-incompatible'
  | 'quartz-engine-unavailable'
  | 'quartz-engine-download-failed'
  | 'quartz-engine-integrity-failed'
  | 'quartz-engine-install-failed'
  | 'quartz-engine-smoke-failed';

export class QuartzEnvironmentError extends Error {
  readonly name = 'QuartzEnvironmentError';

  constructor(
    readonly code: QuartzEnvironmentErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function rethrowAbort(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
    throw new DOMException('The Quartz environment operation was aborted.', 'AbortError');
  }
}
