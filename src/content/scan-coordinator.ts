import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from 'timers';

type TimerHandle = ReturnType<typeof nodeSetTimeout> | number;

export interface ScanTimerBoundary {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export type ImmediateScanTrigger =
  | 'plugin-load'
  | 'config-save'
  | 'manual-refresh'
  | 'preview'
  | 'publish';

export type ScanTrigger = ImmediateScanTrigger | 'file-change';

export interface ScanRequest {
  trigger: ScanTrigger;
  requestId: number;
  signal: AbortSignal;
}

export interface CoordinatedScanResult<T> {
  status: 'applied' | 'stale';
  requestId: number;
  value: T;
}

export class ContentScanCoordinator<T> {
  private requestSequence = 0;
  private activeController?: AbortController;
  private activePromise?: Promise<CoordinatedScanResult<T>>;
  private latest?: CoordinatedScanResult<T>;
  private fileChangeTimer?: TimerHandle;
  private disposed = false;
  private pendingFileChange?: {
    promise: Promise<CoordinatedScanResult<T>>;
    resolve: (result: CoordinatedScanResult<T>) => void;
    reject: (error: unknown) => void;
  };

  constructor(
    private readonly scan: (request: ScanRequest) => Promise<T>,
    private readonly options: {
      debounceMs?: number;
      timers?: ScanTimerBoundary;
    } = {},
  ) {}

  request(trigger: ScanTrigger): Promise<CoordinatedScanResult<T>> {
    if (this.disposed) {
      return Promise.reject(new Error('Content scan coordinator disposed.'));
    }
    if (trigger === 'file-change') {
      return this.requestFileChange();
    }
    const result = this.run(trigger);
    this.resolvePendingFileChangeFrom(result);
    return result;
  }

  private run(trigger: ScanTrigger): Promise<CoordinatedScanResult<T>> {
    const operation = this.performRun(trigger);
    this.activePromise = operation;
    return operation;
  }

  private async performRun(
    trigger: ScanTrigger,
  ): Promise<CoordinatedScanResult<T>> {
    const requestId = ++this.requestSequence;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const value = await this.scan({ trigger, requestId, signal: controller.signal });
    const result: CoordinatedScanResult<T> = {
      status: requestId === this.requestSequence ? 'applied' : 'stale',
      requestId,
      value,
    };
    if (result.status === 'applied') {
      this.latest = result;
    }
    return result;
  }

  private requestFileChange(): Promise<CoordinatedScanResult<T>> {
    if (!this.pendingFileChange) {
      let resolve!: (result: CoordinatedScanResult<T>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<CoordinatedScanResult<T>>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.pendingFileChange = { promise, resolve, reject };
    }

    if (this.fileChangeTimer) {
      this.timers.clear(this.fileChangeTimer);
    }
    this.fileChangeTimer = this.timers.set(() => {
      this.fileChangeTimer = undefined;
      const pending = this.pendingFileChange;
      this.pendingFileChange = undefined;
      if (!pending) return;
      this.run('file-change').then(pending.resolve, pending.reject);
    }, this.options.debounceMs ?? 250);
    return this.pendingFileChange.promise;
  }

  private resolvePendingFileChangeFrom(
    result: Promise<CoordinatedScanResult<T>>,
  ): void {
    const pending = this.pendingFileChange;
    if (!pending) return;
    if (this.fileChangeTimer) {
      this.timers.clear(this.fileChangeTimer);
    }
    this.fileChangeTimer = undefined;
    this.pendingFileChange = undefined;
    result.then(pending.resolve, pending.reject);
  }

  getLatest(): CoordinatedScanResult<T> | undefined {
    return this.latest;
  }

  waitForLatest(): Promise<CoordinatedScanResult<T>> {
    if (this.disposed) {
      return Promise.reject(new Error('Content scan coordinator disposed.'));
    }
    if (this.activePromise) return this.activePromise;
    if (this.latest) return Promise.resolve(this.latest);
    return Promise.reject(new Error('No content scan has started.'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestSequence += 1;
    this.activeController?.abort();
    if (this.fileChangeTimer) {
      this.timers.clear(this.fileChangeTimer);
    }
    this.fileChangeTimer = undefined;
    const pending = this.pendingFileChange;
    this.pendingFileChange = undefined;
    pending?.reject(new Error('Content scan coordinator disposed.'));
  }

  private get timers(): ScanTimerBoundary {
    return (
      this.options.timers ?? {
        set: (callback, delayMs) => nodeSetTimeout(callback, delayMs),
        clear: (handle) => nodeClearTimeout(handle as ReturnType<typeof nodeSetTimeout>),
      }
    );
  }
}
