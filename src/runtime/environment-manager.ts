export interface SystemNodeRuntime {
  executable: string;
  version: string;
}

export interface VerifiedEnvironmentArtifact {
  version: string;
  sha256: string;
}

export interface VerifiedEnvironment {
  runtime?: VerifiedEnvironmentArtifact;
  engine?: VerifiedEnvironmentArtifact;
}

export interface EnvironmentReleaseArtifact {
  version: string;
  url: string;
  sha256: string;
  signature?: string;
}

export interface PublicationEnvironmentRelease {
  runtime: EnvironmentReleaseArtifact;
  engine: EnvironmentReleaseArtifact;
}

export interface PublicationEnvironmentStore {
  read(): Promise<VerifiedEnvironment | undefined>;
  install(
    artifacts: Partial<Record<'runtime' | 'engine', VerifiedEnvironmentArtifact>>,
    content: Partial<Record<'runtime' | 'engine', Uint8Array>>,
  ): Promise<void>;
}

export interface PublicationEnvironmentDependencies {
  inspectSystemNode(): Promise<SystemNodeRuntime | undefined>;
  fetchRelease(): Promise<PublicationEnvironmentRelease>;
  download(url: string): Promise<Uint8Array>;
  verifySignature?(
    signature: string,
    content: Uint8Array,
    artifact: EnvironmentReleaseArtifact,
  ): Promise<boolean>;
  store: PublicationEnvironmentStore;
}

export interface PublicationEnvironmentStatus {
  stage:
    | 'idle'
    | 'checking-system'
    | 'fetching-release'
    | 'verifying-runtime'
    | 'verifying-engine'
    | 'installing'
    | 'ready'
    | 'failed';
  runtime?: { source: 'system' | 'managed'; version: string };
  engine?: { version: string };
  impact?: string;
  nextAction?: 'repair';
  detailsAvailable?: boolean;
}

export class PublicationEnvironmentManager {
  private status: PublicationEnvironmentStatus = { stage: 'idle' };

  constructor(private readonly dependencies: PublicationEnvironmentDependencies) {}

  async prepare(): Promise<PublicationEnvironmentStatus> {
    return this.run(() => this.prepareExclusive());
  }

  async repair(): Promise<PublicationEnvironmentStatus> {
    return this.run(() => this.installCurrentRelease());
  }

  getStatus(): PublicationEnvironmentStatus {
    return { ...this.status };
  }

  private async run(
    operation: () => Promise<PublicationEnvironmentStatus>,
  ): Promise<PublicationEnvironmentStatus> {
    try {
      const ready = await operation();
      this.status = ready;
      return ready;
    } catch (error) {
      this.status = {
        stage: 'failed',
        impact: '本地预览和发布暂不可用。',
        nextAction: 'repair',
        detailsAvailable: true,
      };
      throw error;
    }
  }

  private async prepareExclusive(): Promise<PublicationEnvironmentStatus> {
    this.status = { stage: 'checking-system' };
    const system = await this.dependencies.inspectSystemNode();
    const cached = await this.dependencies.store.read();
    if (system && compatibleNodeVersion(system.version) && cached?.engine) {
      return {
        stage: 'ready',
        runtime: { source: 'system', version: system.version },
        engine: { version: cached.engine.version },
      };
    }
    if (cached?.runtime && compatibleNodeVersion(cached.runtime.version) && cached.engine) {
      return {
        stage: 'ready',
        runtime: { source: 'managed', version: cached.runtime.version },
        engine: { version: cached.engine.version },
      };
    }
    return this.installCurrentRelease();
  }

  private async installCurrentRelease(): Promise<PublicationEnvironmentStatus> {
    this.status = { stage: 'fetching-release' };
    const release = await this.dependencies.fetchRelease();
    validateRelease(release);
    const runtimeContent = await this.dependencies.download(release.runtime.url);
    this.status = { stage: 'verifying-runtime' };
    verifyChecksum(runtimeContent, release.runtime.sha256, 'runtime');
    await this.verifySignature(release.runtime, runtimeContent, 'runtime');
    const engineContent = await this.dependencies.download(release.engine.url);
    this.status = { stage: 'verifying-engine' };
    verifyChecksum(engineContent, release.engine.sha256, 'engine');
    await this.verifySignature(release.engine, engineContent, 'engine');
    this.status = { stage: 'installing' };
    await this.dependencies.store.install(
      {
        runtime: { version: release.runtime.version, sha256: release.runtime.sha256 },
        engine: { version: release.engine.version, sha256: release.engine.sha256 },
      },
      { runtime: runtimeContent, engine: engineContent },
    );
    return {
      stage: 'ready',
      runtime: { source: 'managed', version: release.runtime.version },
      engine: { version: release.engine.version },
    };
  }

  private async verifySignature(
    artifact: EnvironmentReleaseArtifact,
    content: Uint8Array,
    kind: 'runtime' | 'engine',
  ): Promise<void> {
    if (!artifact.signature) return;
    if (
      !this.dependencies.verifySignature ||
      !(await this.dependencies.verifySignature(artifact.signature, content, artifact))
    ) {
      throw new Error(`The ${kind} release signature could not be verified.`);
    }
  }
}

const trustedReleaseOrigin = 'https://releases.pages-publish.dev';

function validateRelease(release: PublicationEnvironmentRelease): void {
  if (!compatibleNodeVersion(release.runtime.version)) {
    throw new Error('The managed Node.js release is not compatible.');
  }
  validateReleaseArtifact('runtime', release.runtime);
  validateReleaseArtifact('engine', release.engine);
}

function validateReleaseArtifact(
  kind: 'runtime' | 'engine',
  artifact: EnvironmentReleaseArtifact,
): void {
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch {
    throw new Error(`The ${kind} release URL is invalid.`);
  }
  if (url.origin !== trustedReleaseOrigin || !/^[a-f0-9]{64}$/iu.test(artifact.sha256)) {
    throw new Error(`The ${kind} release is not from the trusted source.`);
  }
}

function verifyChecksum(
  content: Uint8Array,
  expected: string,
  kind: 'runtime' | 'engine',
): void {
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`The ${kind} download checksum did not match.`);
  }
}

function compatibleNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 20 || (major === 20 && minor >= 19);
}
import { createHash } from 'node:crypto';
