import type { SupportedPlatformIdentity } from './platform';
import type { PublicationEnvironmentStatus } from '../runtime/environment-manager';
import type {
  QuartzEngineRuntimeTools,
  ReadyQuartzEngine,
} from '../runtime/quartz-engine-store';
import { errorCode, QuartzEnvironmentError } from '../runtime/quartz-environment-error';
import type {
  QuartzEnvironmentProgressReporter,
  QuartzEnvironmentProgressStage,
} from '../runtime/quartz-environment-progress';

export interface QuartzPublicationEnvironmentDependencies {
  platform: SupportedPlatformIdentity;
  ensureRuntime(
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools>;
  ensureEngine(
    runtime: QuartzEngineRuntimeTools,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<ReadyQuartzEngine>;
  repairRuntime?(
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools>;
  repairEngine?(
    runtime: QuartzEngineRuntimeTools,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<ReadyQuartzEngine>;
}

export class QuartzPublicationEnvironment {
  private status: PublicationEnvironmentStatus = { stage: 'idle' };
  private ready: ReadyQuartzEngine | undefined;
  private active: Promise<ReadyQuartzEngine> | undefined;
  private activeController: AbortController | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dependencies: QuartzPublicationEnvironmentDependencies) {}

  getStatus(): PublicationEnvironmentStatus {
    return {
      ...this.status,
      ...(this.status.runtime === undefined ? {} : { runtime: { ...this.status.runtime } }),
      ...(this.status.engine === undefined ? {} : { engine: { ...this.status.engine } }),
    };
  }

  async prepare(): Promise<PublicationEnvironmentStatus> {
    await this.ensureReady();
    return this.getStatus();
  }

  async repair(): Promise<PublicationEnvironmentStatus> {
    const active = this.active;
    if (active) await active.catch(() => undefined);
    this.ready = undefined;
    await this.start(undefined, true);
    return this.getStatus();
  }

  ensureReady(signal?: AbortSignal): Promise<ReadyQuartzEngine> {
    if (this.ready) return Promise.resolve(this.ready);
    if (this.active) return waitForSignal(this.active, signal);
    return this.start(signal, false);
  }

  cancel(): boolean {
    if (!this.activeController || this.activeController.signal.aborted) return false;
    this.activeController.abort();
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private start(
    externalSignal: AbortSignal | undefined,
    force: boolean,
  ): Promise<ReadyQuartzEngine> {
    const controller = new AbortController();
    const signal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal]);
    const operation = this.prepareExclusive(force, signal);
    this.active = operation;
    this.activeController = controller;
    void operation.finally(() => {
      if (this.active === operation) this.active = undefined;
      if (this.activeController === controller) this.activeController = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async prepareExclusive(
    force: boolean,
    signal: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    try {
      this.updateStatus({ stage: 'checking-system' });
      const reportProgress: QuartzEnvironmentProgressReporter = (stage) => {
        this.reportProgress(stage);
      };
      const runtime = force && this.dependencies.repairRuntime
        ? await this.dependencies.repairRuntime(signal, reportProgress)
        : await this.dependencies.ensureRuntime(signal, reportProgress);
      signal.throwIfAborted();
      this.updateStatus({
        stage: 'verifying-engine',
        runtime: { source: runtime.source ?? 'managed', version: runtime.nodeVersion },
      });
      const engine = force && this.dependencies.repairEngine
        ? await this.dependencies.repairEngine(runtime, signal, reportProgress)
        : await this.dependencies.ensureEngine(runtime, signal, reportProgress);
      signal.throwIfAborted();
      if (engine.platform !== this.dependencies.platform) {
        throw new Error('The verified Quartz engine targets a different platform.');
      }
      this.ready = engine;
      this.updateStatus({
        stage: 'ready',
        runtime: { source: runtime.source ?? 'managed', version: runtime.nodeVersion },
        engine: { version: engine.engineVersion },
        ...(engine.usingFallback
          ? { impact: 'Quartz 更新失败，当前继续使用上一个已验证版本。' }
          : {}),
      });
      return engine;
    } catch (error) {
      if (isAbortError(error)) {
        this.updateStatus({
          stage: 'idle',
          impact: '本地发布环境准备已取消；未验证的临时文件已清理。',
          nextAction: 'repair',
          detailsAvailable: true,
        });
        throw error;
      }
      this.updateStatus({
        stage: 'failed',
        impact: 'Quartz 环境尚未就绪，本地预览和发布暂不可用。',
        nextAction: 'repair',
        detailsAvailable: true,
      });
      if (
        errorCode(error)?.startsWith('quartz-engine-')
        || errorCode(error) === 'node-runtime-incompatible'
        || errorCode(error) === 'publication-environment-disk-insufficient'
      ) {
        throw error;
      }
      throw new QuartzEnvironmentError(
        'quartz-engine-unavailable',
        'No verified Quartz publication engine is available.',
        error,
      );
    }
  }

  private reportProgress(stage: QuartzEnvironmentProgressStage): void {
    this.updateStatus({
      stage,
      ...(this.status.runtime === undefined ? {} : { runtime: this.status.runtime }),
      ...(this.status.engine === undefined ? {} : { engine: this.status.engine }),
    });
  }

  private updateStatus(status: PublicationEnvironmentStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Status observers cannot change the verified environment transaction.
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortError(): DOMException {
  return new DOMException('The Quartz environment operation was aborted.', 'AbortError');
}
