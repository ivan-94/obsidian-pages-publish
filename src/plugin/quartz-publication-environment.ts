import type { SupportedPlatformIdentity } from './platform';
import type { PublicationEnvironmentStatus } from '../runtime/environment-manager';
import type {
  QuartzEngineRuntimeTools,
  ReadyQuartzEngine,
} from '../runtime/quartz-engine-store';
import { errorCode, QuartzEnvironmentError } from '../runtime/quartz-environment-error';

export interface QuartzPublicationEnvironmentDependencies {
  platform: SupportedPlatformIdentity;
  ensureRuntime(): Promise<QuartzEngineRuntimeTools>;
  ensureEngine(runtime: QuartzEngineRuntimeTools): Promise<ReadyQuartzEngine>;
  repairRuntime?(): Promise<QuartzEngineRuntimeTools>;
  repairEngine?(runtime: QuartzEngineRuntimeTools): Promise<ReadyQuartzEngine>;
}

export class QuartzPublicationEnvironment {
  private status: PublicationEnvironmentStatus = { stage: 'idle' };
  private ready: ReadyQuartzEngine | undefined;
  private active: Promise<ReadyQuartzEngine> | undefined;

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
    const operation = this.prepareExclusive(true);
    this.active = operation;
    try {
      await operation;
    } finally {
      if (this.active === operation) this.active = undefined;
    }
    return this.getStatus();
  }

  ensureReady(): Promise<ReadyQuartzEngine> {
    if (this.ready) return Promise.resolve(this.ready);
    if (this.active) return this.active;
    const operation = this.prepareExclusive(false);
    this.active = operation;
    void operation.finally(() => {
      if (this.active === operation) this.active = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async prepareExclusive(force: boolean): Promise<ReadyQuartzEngine> {
    try {
      this.status = { stage: 'checking-system' };
      const runtime = force && this.dependencies.repairRuntime
        ? await this.dependencies.repairRuntime()
        : await this.dependencies.ensureRuntime();
      this.status = {
        stage: 'verifying-engine',
        runtime: { source: runtime.source ?? 'managed', version: runtime.nodeVersion },
      };
      const engine = force && this.dependencies.repairEngine
        ? await this.dependencies.repairEngine(runtime)
        : await this.dependencies.ensureEngine(runtime);
      if (engine.platform !== this.dependencies.platform) {
        throw new Error('The verified Quartz engine targets a different platform.');
      }
      this.ready = engine;
      this.status = {
        stage: 'ready',
        runtime: { source: runtime.source ?? 'managed', version: runtime.nodeVersion },
        engine: { version: engine.engineVersion },
        ...(engine.usingFallback
          ? { impact: 'Quartz 更新失败，当前继续使用上一个已验证版本。' }
          : {}),
      };
      return engine;
    } catch (error) {
      this.status = {
        stage: 'failed',
        impact: 'Quartz 环境尚未就绪，本地预览和发布暂不可用。',
        nextAction: 'repair',
        detailsAvailable: true,
      };
      if (errorCode(error)?.startsWith('quartz-engine-') || errorCode(error) === 'node-runtime-incompatible') {
        throw error;
      }
      throw new QuartzEnvironmentError(
        'quartz-engine-unavailable',
        'No verified Quartz publication engine is available.',
        error,
      );
    }
  }
}
