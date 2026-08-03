import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { SupportedPlatformIdentity } from '../plugin/platform';
import { compatibleNodeVersion } from './environment-manager';
import { installLockedNpmProject, type LockedNpmInstallRequest } from './npm-installer';
import {
  validateQuartzEngineManifest,
  type QuartzEngineManifest,
} from './quartz-engine-manifest';
import { extractTrustedTarGz } from './safe-tar-extractor';
import { applyQuartzEngineCompatibilityPatch } from './quartz-compatibility-patch';
import {
  errorCode,
  QuartzEnvironmentError,
  rethrowAbort,
} from './quartz-environment-error';
import {
  disabledQuartzPackagesAreAbsent,
  pruneDisabledQuartzPackages,
  quartzEngineSecurityDispositions,
} from './quartz-engine-security-policy';

export interface QuartzEngineRuntimeTools {
  nodeExecutable: string;
  nodeVersion: string;
  npmCliPath: string;
  npmVersion: string;
  source?: 'obsidian' | 'managed';
}

export interface ReadyQuartzEngine extends QuartzEngineRuntimeTools {
  engineVersion: string;
  quartzVersion: string;
  platform: SupportedPlatformIdentity;
  engineDirectory: string;
  usingFallback: boolean;
}

interface VerifiedEngineRecord {
  engineVersion: string;
  quartzVersion: string;
  platform: SupportedPlatformIdentity;
  sourceSha256: string;
  lockfileSha256: string;
}

export interface QuartzEngineSmokeRequest {
  engineDirectory: string;
  manifest: Readonly<QuartzEngineManifest>;
  runtime: QuartzEngineRuntimeTools;
}

export interface QuartzEngineStoreDependencies {
  rootDirectory: string;
  download: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  installDependencies?: (request: LockedNpmInstallRequest) => Promise<void>;
  smoke: (request: QuartzEngineSmokeRequest) => Promise<void>;
}

export class QuartzEngineStore {
  private activeOperation: Promise<ReadyQuartzEngine> | undefined;

  constructor(private readonly dependencies: QuartzEngineStoreDependencies) {}

  ensureReady(
    manifest: QuartzEngineManifest,
    runtime: QuartzEngineRuntimeTools,
    signal?: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    if (this.activeOperation) return this.activeOperation;
    return this.start(manifest, runtime, false, signal);
  }

  repair(
    manifest: QuartzEngineManifest,
    runtime: QuartzEngineRuntimeTools,
    signal?: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    const active = this.activeOperation;
    if (active) {
      return active
        .catch(() => undefined)
        .then(() => this.repair(manifest, runtime, signal));
    }
    return this.start(manifest, runtime, true, signal);
  }

  private start(
    manifest: QuartzEngineManifest,
    runtime: QuartzEngineRuntimeTools,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    const operation = this.ensureReadyExclusive(manifest, runtime, force, signal);
    this.activeOperation = operation;
    void operation.finally(() => {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async ensureReadyExclusive(
    inputManifest: QuartzEngineManifest,
    runtime: QuartzEngineRuntimeTools,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    const manifest = validateQuartzEngineManifest(inputManifest, inputManifest.platform);
    validateRuntime(runtime);
    const exactDirectory = this.engineDirectory(manifest.platform, manifest.engineVersion);
    if (!force && await installationMatches(exactDirectory, manifest)) {
      await this.activate(exactDirectory, manifest);
      return readyEngine(exactDirectory, manifest, runtime, false);
    }

    const fallback = await this.readActive(manifest.platform, runtime);
    try {
      return await this.install(manifest, runtime, exactDirectory, signal);
    } catch (error) {
      if (fallback) return { ...fallback, usingFallback: true };
      throw error;
    }
  }

  private async install(
    manifest: Readonly<QuartzEngineManifest>,
    runtime: QuartzEngineRuntimeTools,
    exactDirectory: string,
    signal?: AbortSignal,
  ): Promise<ReadyQuartzEngine> {
    const platformDirectory = join(
      this.dependencies.rootDirectory,
      'engines',
      manifest.platform,
    );
    await mkdir(platformDirectory, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(platformDirectory, '.install-'));
    let moved = false;
    try {
      let archive: Uint8Array;
      try {
        archive = await this.dependencies.download(manifest.sourceUrl, signal);
      } catch (error) {
        rethrowAbort(error);
        throw new QuartzEnvironmentError(
          'quartz-engine-download-failed',
          'The pinned Quartz source archive could not be downloaded.',
          error,
        );
      }
      verifySha256(archive, manifest.sourceSha256);
      try {
        await extractTrustedTarGz(archive, temporaryDirectory);
        await verifyQuartzPackage(temporaryDirectory, manifest.quartzVersion);
        await applyQuartzEngineCompatibilityPatch(temporaryDirectory);
      } catch (error) {
        if (errorCode(error) === 'quartz-engine-integrity-failed') throw error;
        throw new QuartzEnvironmentError(
          'quartz-engine-integrity-failed',
          'The pinned Quartz source archive did not match the trusted engine.',
          error,
        );
      }
      try {
        await (this.dependencies.installDependencies ?? installLockedNpmProject)({
          sourceDirectory: temporaryDirectory,
          nodeExecutable: runtime.nodeExecutable,
          npmCliPath: runtime.npmCliPath,
          cacheDirectory: join(this.dependencies.rootDirectory, 'npm-cache'),
          lockfileSha256: manifest.lockfileSha256,
          signal,
        });
        await pruneDisabledQuartzPackages(temporaryDirectory);
        await writeDependencyInventory(temporaryDirectory, manifest);
      } catch (error) {
        rethrowAbort(error);
        if (errorCode(error) === 'quartz-engine-install-failed') throw error;
        throw new QuartzEnvironmentError(
          'quartz-engine-install-failed',
          'The locked Quartz dependency installation failed.',
          error,
        );
      }
      try {
        await this.dependencies.smoke({
          engineDirectory: temporaryDirectory,
          manifest,
          runtime,
        });
      } catch (error) {
        rethrowAbort(error);
        throw new QuartzEnvironmentError(
          'quartz-engine-smoke-failed',
          'The installed Quartz engine failed its offline smoke build.',
          error,
        );
      }
      await writeFile(
        join(temporaryDirectory, '.pages-publish-verified.json'),
        `${JSON.stringify(recordFromManifest(manifest))}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      if (await pathExists(exactDirectory)) {
        await rename(
          exactDirectory,
          join(platformDirectory, `.invalid-${manifest.engineVersion}-${randomUUID()}`),
        );
      }
      await rename(temporaryDirectory, exactDirectory);
      moved = true;
      await this.activate(exactDirectory, manifest);
      return readyEngine(exactDirectory, manifest, runtime, false);
    } finally {
      if (!moved) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async activate(
    engineDirectory: string,
    manifest: Readonly<QuartzEngineManifest>,
  ): Promise<void> {
    const activePath = this.activePath(manifest.platform);
    await mkdir(this.dependencies.rootDirectory, { recursive: true });
    const temporaryPath = `${activePath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ ...recordFromManifest(manifest), engineDirectory })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporaryPath, activePath);
  }

  private async readActive(
    platform: SupportedPlatformIdentity,
    runtime: QuartzEngineRuntimeTools,
  ): Promise<ReadyQuartzEngine | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.activePath(platform), 'utf8')) as
        & VerifiedEngineRecord
        & { engineDirectory: string };
      if (parsed.platform !== platform || !(await installationMatches(parsed.engineDirectory, parsed))) {
        return undefined;
      }
      return {
        ...runtime,
        engineVersion: parsed.engineVersion,
        quartzVersion: parsed.quartzVersion,
        platform,
        engineDirectory: parsed.engineDirectory,
        usingFallback: false,
      };
    } catch {
      return undefined;
    }
  }

  private engineDirectory(
    platform: SupportedPlatformIdentity,
    engineVersion: string,
  ): string {
    return join(this.dependencies.rootDirectory, 'engines', platform, engineVersion);
  }

  private activePath(platform: SupportedPlatformIdentity): string {
    return join(this.dependencies.rootDirectory, `active-${platform}.json`);
  }
}

function validateRuntime(runtime: QuartzEngineRuntimeTools): void {
  if (!compatibleNodeVersion(runtime.nodeVersion) || !isMinimumNpm(runtime.npmVersion, 10, 9, 2)) {
    throw new QuartzEnvironmentError(
      'node-runtime-incompatible',
      'The Quartz engine requires Node 22 and npm 10.9.2 or newer.',
    );
  }
  if (runtime.nodeExecutable.length === 0 || runtime.npmCliPath.length === 0) {
    throw new QuartzEnvironmentError(
      'node-runtime-incompatible',
      'The Quartz engine runtime tools are incomplete.',
    );
  }
}

function isMinimumNpm(version: string, major: number, minor: number, patch: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [major, minor, patch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

async function verifyQuartzPackage(directory: string, expectedVersion: string): Promise<void> {
  try {
    const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name !== '@jackyzha0/quartz' || packageJson.version !== expectedVersion) {
      throw new Error('mismatch');
    }
    await access(join(directory, 'package-lock.json'));
    await access(join(directory, 'quartz', 'bootstrap-cli.mjs'));
  } catch {
    throw new Error('The Quartz source archive does not match the pinned engine version.');
  }
}

interface LockedPackageRecord {
  name?: unknown;
  version?: unknown;
  integrity?: unknown;
  resolved?: unknown;
}

async function writeDependencyInventory(
  directory: string,
  manifest: Readonly<QuartzEngineManifest>,
): Promise<void> {
  const lockfile = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')) as {
    lockfileVersion?: unknown;
    packages?: Record<string, LockedPackageRecord>;
  };
  if (lockfile.lockfileVersion !== 3 || !lockfile.packages) {
    throw new Error('The Quartz package lock cannot produce a dependency inventory.');
  }
  const packages = Object.entries(lockfile.packages)
    .map(([path, value]) => ({
      path,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.integrity === 'string' ? { integrity: value.integrity } : {}),
      ...(typeof value.resolved === 'string' ? { resolved: value.resolved } : {}),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(
    join(directory, '.pages-publish-dependencies.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      engineVersion: manifest.engineVersion,
      quartzVersion: manifest.quartzVersion,
      lockfileSha256: manifest.lockfileSha256.toLowerCase(),
      packages,
      securityDispositions: quartzEngineSecurityDispositions,
    }, undefined, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

async function installationMatches(
  directory: string,
  expected: VerifiedEngineRecord,
): Promise<boolean> {
  try {
    const record = JSON.parse(
      await readFile(join(directory, '.pages-publish-verified.json'), 'utf8'),
    ) as VerifiedEngineRecord;
    await access(join(directory, 'package.json'));
    await access(join(directory, 'package-lock.json'));
    await access(join(directory, 'quartz', 'bootstrap-cli.mjs'));
    await access(join(directory, '.pages-publish-dependencies.json'));
    return await disabledQuartzPackagesAreAbsent(directory)
      && record.engineVersion === expected.engineVersion
      && record.quartzVersion === expected.quartzVersion
      && record.platform === expected.platform
      && record.sourceSha256 === expected.sourceSha256
      && record.lockfileSha256 === expected.lockfileSha256;
  } catch {
    return false;
  }
}

function recordFromManifest(manifest: Readonly<QuartzEngineManifest>): VerifiedEngineRecord {
  return {
    engineVersion: manifest.engineVersion,
    quartzVersion: manifest.quartzVersion,
    platform: manifest.platform,
    sourceSha256: manifest.sourceSha256.toLowerCase(),
    lockfileSha256: manifest.lockfileSha256.toLowerCase(),
  };
}

function readyEngine(
  engineDirectory: string,
  manifest: Readonly<QuartzEngineManifest>,
  runtime: QuartzEngineRuntimeTools,
  usingFallback: boolean,
): ReadyQuartzEngine {
  return {
    ...runtime,
    engineVersion: manifest.engineVersion,
    quartzVersion: manifest.quartzVersion,
    platform: manifest.platform,
    engineDirectory,
    usingFallback,
  };
}

function verifySha256(content: Uint8Array, expected: string): void {
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new QuartzEnvironmentError(
      'quartz-engine-integrity-failed',
      'The Quartz source archive checksum did not match the engine manifest.',
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
