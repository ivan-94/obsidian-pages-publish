import {
  compatibleNodeVersion,
  type PublicationEnvironmentStatus,
} from '../runtime/environment-manager';

/**
 * The production plugin already executes its publication engine from the
 * installed bundle. This host verifies the actual Obsidian Node runtime and
 * reports that bundled engine instead of downloading an invented artifact.
 */
export class BundledPublicationEnvironment {
  private status: PublicationEnvironmentStatus = { stage: 'idle' };

  constructor(private readonly input: {
    runtimeVersion: string;
    engineVersion: string;
  }) {}

  getStatus(): PublicationEnvironmentStatus {
    return {
      ...this.status,
      ...(this.status.runtime === undefined
        ? {}
        : { runtime: { ...this.status.runtime } }),
      ...(this.status.engine === undefined
        ? {}
        : { engine: { ...this.status.engine } }),
    };
  }

  async prepare(): Promise<PublicationEnvironmentStatus> {
    this.status = { stage: 'checking-system' };
    if (!compatibleNodeVersion(this.input.runtimeVersion)) {
      this.status = {
        stage: 'failed',
        impact: `Obsidian 的 Node.js ${this.input.runtimeVersion} 不在支持范围内，本地预览和发布暂不可用。`,
        nextAction: 'repair',
        detailsAvailable: true,
      };
      throw new Error('The Obsidian Node.js runtime is not compatible.');
    }
    this.status = { stage: 'verifying-engine' };
    if (this.input.engineVersion.trim().length === 0) {
      this.status = {
        stage: 'failed',
        impact: '无法确认随插件安装的发布引擎版本。',
        nextAction: 'repair',
        detailsAvailable: true,
      };
      throw new Error('The bundled publication engine version is unavailable.');
    }
    this.status = {
      stage: 'ready',
      runtime: { source: 'obsidian', version: this.input.runtimeVersion },
      engine: { version: this.input.engineVersion },
    };
    return this.getStatus();
  }

  repair(): Promise<PublicationEnvironmentStatus> {
    return this.prepare();
  }
}
