import {
  materializePublicationSnapshotAssets,
  type PublicationSnapshot,
} from './publish-center';
import type { PreviewAsset } from '../content/local-assets';

export type PublicationStage = 'prepare' | 'build' | 'upload' | 'activate';

export interface CloudflarePagesDeploymentBoundary {
  /** Verifies the credential, selected account, and Pages project before publishing. */
  validate(): Promise<void>;
  upload(input: {
    scanDigest: string;
    files: Readonly<Record<string, string>>;
    assets: Readonly<Record<string, PreviewAsset>>;
  }): Promise<{ deploymentId: string }>;
  activate(input: {
    deploymentId: string;
  }): Promise<{ deploymentId: string; url: string }>;
}

export interface PublicationDeployment {
  deploymentId: string;
  url: string;
  scanDigest: string;
  output: PublicationSnapshot['output'];
}

export interface PublicationFactsBoundary {
  /** Rejects a new remote publication while an earlier local reconciliation is pending. */
  assertReadyForPublication(): Promise<void>;
  /** Persists post-activation local facts and the complete deployment baseline. */
  reconcile(
    deployment: PublicationDeployment,
    snapshot: PublicationSnapshot,
  ): Promise<unknown>;
}

export type PublicationRunStatus =
  | { state: 'idle' }
  | { state: 'running'; stage: PublicationStage }
  | {
    state: 'succeeded';
    stage: 'activate';
    deployment: PublicationDeployment;
  }
  | {
    state: 'failed';
    stage: PublicationStage;
    message: string;
  }
  | {
    state: 'reconciliation-required';
    deployment?: PublicationDeployment;
    message: string;
  };

/** A stage-labelled, UI-safe failure. Provider responses are intentionally not retained. */
class PublicationOrchestrationError extends Error {
  readonly name = 'PublicationOrchestrationError';

  constructor(
    readonly stage: PublicationStage,
    message: string,
  ) {
    super(message);
  }
}

class PublicationReconciliationPendingError extends Error {
  readonly name = 'PublicationReconciliationPendingError';

  constructor() {
    super('The site is online, but local publishing facts need repair before another publish can start.');
  }
}

export interface PublicationOrchestratorDependencies<TPreparation = PublicationSnapshot> {
  /** Revalidates current input before an immutable output snapshot is built. */
  prepare(): Promise<TPreparation>;
  /** Builds and checks that snapshot before any remote mutation starts. */
  build(preparation: TPreparation): Promise<PublicationSnapshot>;
  adapter: CloudflarePagesDeploymentBoundary;
  facts?: PublicationFactsBoundary;
}

/**
 * Owns one background publication operation. It does not offer cancellation:
 * once upload begins, callers can continue observing the task after closing a
 * view, but cannot promise that a remote upload will stop.
 */
export class PublicationOrchestrator<TPreparation = PublicationSnapshot> {
  private status: PublicationRunStatus = { state: 'idle' };
  private activePublish: Promise<PublicationDeployment> | undefined;
  private lastDeployment: PublicationDeployment | undefined;
  private readonly listeners = new Set<(status: PublicationRunStatus) => void>();

  constructor(
    private readonly dependencies: PublicationOrchestratorDependencies<TPreparation>,
  ) {}

  getStatus(): PublicationRunStatus {
    return copyStatus(this.status);
  }

  getLastDeployment(): PublicationDeployment | undefined {
    return this.lastDeployment;
  }

  subscribe(listener: (status: PublicationRunStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Re-checks a durable recovery receipt after application startup or a
   * successful recovery action. A cleared receipt deliberately returns the
   * in-memory publisher to idle so the next user action can begin a publish.
   */
  async refreshPublicationFacts(): Promise<void> {
    if (!this.dependencies.facts) return;
    try {
      await this.dependencies.facts.assertReadyForPublication();
    } catch {
      const pending = new PublicationReconciliationPendingError();
      this.setStatus({ state: 'reconciliation-required', message: pending.message });
      throw pending;
    }
    if (this.status.state === 'reconciliation-required') {
      this.setStatus({ state: 'idle' });
    }
  }

  publish(): Promise<PublicationDeployment> {
    if (this.status.state === 'reconciliation-required') {
      return Promise.reject(new PublicationReconciliationPendingError());
    }
    if (this.activePublish) return this.activePublish;
    const publish = this.publishExclusive();
    this.activePublish = publish;
    void publish.finally(() => {
      if (this.activePublish === publish) this.activePublish = undefined;
    }).catch(() => undefined);
    return publish;
  }

  private async publishExclusive(): Promise<PublicationDeployment> {
    let stage: PublicationStage = 'prepare';
    try {
      this.setStatus({ state: 'running', stage });
      if (this.dependencies.facts) {
        try {
          await this.dependencies.facts.assertReadyForPublication();
        } catch {
          const pending = new PublicationReconciliationPendingError();
          this.setStatus({ state: 'reconciliation-required', message: pending.message });
          throw pending;
        }
      }
      await this.dependencies.adapter.validate();
      const snapshot = await this.dependencies.prepare();

      stage = 'build';
      this.setStatus({ state: 'running', stage });
      const built = await this.dependencies.build(snapshot);

      stage = 'upload';
      this.setStatus({ state: 'running', stage });
      const staged = await this.dependencies.adapter.upload({
        scanDigest: built.scanDigest,
        files: { ...built.files },
        assets: materializePublicationSnapshotAssets(built),
      });

      stage = 'activate';
      this.setStatus({ state: 'running', stage });
      const active = await this.dependencies.adapter.activate({
        deploymentId: staged.deploymentId,
      });
      if (active.deploymentId !== staged.deploymentId) {
        throw new PublicationOrchestrationError(
          'activate',
          'Cloudflare activated an unexpected deployment.',
        );
      }
      const deployment: PublicationDeployment = Object.freeze({
        deploymentId: active.deploymentId,
        url: active.url,
        scanDigest: built.scanDigest,
        output: Object.freeze({ ...built.output }),
      });
      this.lastDeployment = deployment;
      try {
        await this.dependencies.facts?.reconcile(deployment, built);
      } catch {
        const pending = new PublicationReconciliationPendingError();
        this.setStatus({
          state: 'reconciliation-required',
          deployment,
          message: pending.message,
        });
        throw pending;
      }
      this.setStatus({ state: 'succeeded', stage: 'activate', deployment });
      return deployment;
    } catch (error) {
      if (error instanceof PublicationReconciliationPendingError) throw error;
      const failure = error instanceof PublicationOrchestrationError
        ? error
        : new PublicationOrchestrationError(stage, safeFailureMessage(stage));
      this.setStatus({ state: 'failed', stage, message: failure.message });
      throw failure;
    }
  }

  private setStatus(status: PublicationRunStatus): void {
    this.status = copyStatus(status);
    for (const listener of this.listeners) listener(copyStatus(this.status));
  }
}

function copyStatus(status: PublicationRunStatus): PublicationRunStatus {
  if (status.state === 'succeeded') {
    return {
      ...status,
      deployment: {
        ...status.deployment,
        output: { ...status.deployment.output },
      },
    };
  }
  if (status.state === 'reconciliation-required') {
    return {
      ...status,
      ...(status.deployment === undefined
        ? {}
        : {
            deployment: {
              ...status.deployment,
              output: { ...status.deployment.output },
            },
          }),
    };
  }
  return { ...status };
}

function safeFailureMessage(stage: PublicationStage): string {
  switch (stage) {
    case 'prepare':
      return 'Publication preparation failed. Resolve the reported configuration, authorization, or content problem and retry.';
    case 'build':
      return 'Site build and checks failed. The current site remains active. Fix the reported problem and retry.';
    case 'upload':
      return 'Cloudflare upload failed. The current site remains active. Retry after checking the connection.';
    case 'activate':
      return 'Cloudflare activation failed. The current site remains active. Retry after checking the deployment.';
  }
}
