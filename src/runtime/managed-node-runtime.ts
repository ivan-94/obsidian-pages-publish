import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { SupportedPlatformIdentity } from '../plugin/platform';
import type { QuartzEngineRuntimeTools } from './quartz-engine-store';
import { extractTrustedNodeRuntimeTarGz } from './safe-tar-extractor';
import {
  assertPublicationEnvironmentDiskCapacity,
  assertPublicationEnvironmentWithinBudget,
} from './environment-disk-budget';
import type { QuartzEnvironmentProgressReporter } from './quartz-environment-progress';
import { rethrowAbort } from './quartz-environment-error';

const execFileAsync = promisify(execFile);

export interface ManagedNodeManifest {
  version: string;
  npmVersion: string;
  platform: SupportedPlatformIdentity;
  sourceUrl: string;
  sourceSha256: string;
}

export interface ManagedNodeVerificationRequest extends QuartzEngineRuntimeTools {
  runtimeDirectory: string;
  signal?: AbortSignal;
}

export interface ManagedNodeRuntimeDependencies {
  rootDirectory: string;
  download: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  verify?: (request: ManagedNodeVerificationRequest) => Promise<void>;
  /** Test/update-channel trust boundary; production uses the exact built-in manifest. */
  trustManifest?: (manifest: Readonly<ManagedNodeManifest>) => boolean;
  checkDiskCapacity?: (rootDirectory: string) => Promise<void>;
  checkEnvironmentSize?: (rootDirectory: string) => Promise<void>;
}

export function builtinManagedNodeManifest(
  platform: SupportedPlatformIdentity,
): Readonly<ManagedNodeManifest> {
  const sourceSha256 = platform === 'darwin-arm64'
    ? 'ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953'
    : 'b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81';
  return Object.freeze({
    version: '22.23.1',
    npmVersion: '10.9.8',
    platform,
    sourceUrl: `https://nodejs.org/dist/v22.23.1/node-v22.23.1-${platform}.tar.gz`,
    sourceSha256,
  });
}

export class ManagedNodeRuntimeStore {
  private activeOperation: Promise<QuartzEngineRuntimeTools> | undefined;

  constructor(private readonly dependencies: ManagedNodeRuntimeDependencies) {}

  ensureReady(
    inputManifest: Readonly<ManagedNodeManifest>,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools> {
    if (this.activeOperation) return this.activeOperation;
    return this.start(inputManifest, false, signal, reportProgress);
  }

  repair(
    inputManifest: Readonly<ManagedNodeManifest>,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools> {
    const active = this.activeOperation;
    if (active) {
      return active
        .catch(() => undefined)
        .then(() => this.repair(inputManifest, signal, reportProgress));
    }
    return this.start(inputManifest, true, signal, reportProgress);
  }

  private start(
    inputManifest: Readonly<ManagedNodeManifest>,
    force: boolean,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools> {
    const operation = this.ensureReadyExclusive(
      inputManifest,
      force,
      signal,
      reportProgress,
    );
    this.activeOperation = operation;
    void operation.finally(() => {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async ensureReadyExclusive(
    inputManifest: Readonly<ManagedNodeManifest>,
    force: boolean,
    signal?: AbortSignal,
    reportProgress?: QuartzEnvironmentProgressReporter,
  ): Promise<QuartzEngineRuntimeTools> {
    const manifest = validateManifest(
      inputManifest,
      this.dependencies.trustManifest,
    );
    const platformDirectory = join(
      this.dependencies.rootDirectory,
      'runtimes',
      manifest.platform,
    );
    const runtimeDirectory = join(platformDirectory, `node-${manifest.version}`);
    const tools = runtimeTools(runtimeDirectory, manifest);
    if (!force && await runtimeMatches(runtimeDirectory, manifest)) return tools;

    await mkdir(platformDirectory, { recursive: true });
    await (this.dependencies.checkDiskCapacity
      ?? assertPublicationEnvironmentDiskCapacity)(this.dependencies.rootDirectory);
    const temporaryDirectory = await mkdtemp(join(platformDirectory, '.install-'));
    let moved = false;
    let replacedDirectory: string | undefined;
    try {
      reportProgress?.('downloading-runtime');
      const archive = await this.dependencies.download(manifest.sourceUrl, signal);
      signal?.throwIfAborted();
      const actualSha256 = createHash('sha256').update(archive).digest('hex');
      if (actualSha256 !== manifest.sourceSha256) {
        throw new Error('The managed Node runtime checksum did not match.');
      }
      reportProgress?.('installing-runtime');
      await extractTrustedNodeRuntimeTarGz(archive, temporaryDirectory, {
        maxCompressedBytes: 64 * 1024 * 1024,
        maxExpandedBytes: 512 * 1024 * 1024,
      });
      signal?.throwIfAborted();
      const temporaryTools = runtimeTools(temporaryDirectory, manifest);
      await chmod(temporaryTools.nodeExecutable, 0o755);
      await (this.dependencies.verify ?? verifyManagedNode)({
        ...temporaryTools,
        runtimeDirectory: temporaryDirectory,
        signal,
      });
      await writeFile(
        join(temporaryDirectory, '.pages-publish-verified.json'),
        `${JSON.stringify(manifest)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await (this.dependencies.checkEnvironmentSize
        ?? assertPublicationEnvironmentWithinBudget)(this.dependencies.rootDirectory);
      if (await pathExists(runtimeDirectory)) {
        replacedDirectory = join(
          platformDirectory,
          `.replaced-node-${manifest.version}-${randomUUID()}`,
        );
        await rename(runtimeDirectory, replacedDirectory);
      }
      try {
        await rename(temporaryDirectory, runtimeDirectory);
      } catch (error) {
        if (replacedDirectory !== undefined) {
          await rename(replacedDirectory, runtimeDirectory);
          replacedDirectory = undefined;
        }
        throw error;
      }
      moved = true;
      if (replacedDirectory !== undefined) {
        await rm(replacedDirectory, { recursive: true, force: true });
        replacedDirectory = undefined;
      }
      return tools;
    } finally {
      if (!moved) await rm(temporaryDirectory, { recursive: true, force: true });
      if (moved && replacedDirectory !== undefined) {
        await rm(replacedDirectory, { recursive: true, force: true });
      }
    }
  }
}

function validateManifest(
  manifest: Readonly<ManagedNodeManifest>,
  trustManifest?: (manifest: Readonly<ManagedNodeManifest>) => boolean,
): Readonly<ManagedNodeManifest> {
  const expected = builtinManagedNodeManifest(manifest.platform);
  if (
    !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)
    || (trustManifest === undefined
      ? manifest.version !== expected.version
        || manifest.npmVersion !== expected.npmVersion
        || manifest.sourceUrl !== expected.sourceUrl
        || manifest.sourceSha256 !== expected.sourceSha256
      : !trustManifest(manifest))
  ) {
    throw new Error('The managed Node runtime manifest is not trusted.');
  }
  return Object.freeze({ ...manifest });
}

function runtimeTools(
  runtimeDirectory: string,
  manifest: Readonly<ManagedNodeManifest>,
): QuartzEngineRuntimeTools {
  return {
    nodeExecutable: join(runtimeDirectory, 'bin', 'node'),
    nodeVersion: manifest.version,
    npmCliPath: join(
      runtimeDirectory,
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    npmVersion: manifest.npmVersion,
    source: 'managed',
  };
}

async function runtimeMatches(
  runtimeDirectory: string,
  manifest: Readonly<ManagedNodeManifest>,
): Promise<boolean> {
  try {
    const record = JSON.parse(
      await readFile(join(runtimeDirectory, '.pages-publish-verified.json'), 'utf8'),
    ) as ManagedNodeManifest;
    const tools = runtimeTools(runtimeDirectory, manifest);
    await access(tools.nodeExecutable);
    await access(tools.npmCliPath);
    return record.version === manifest.version
      && record.npmVersion === manifest.npmVersion
      && record.platform === manifest.platform
      && record.sourceUrl === manifest.sourceUrl
      && record.sourceSha256 === manifest.sourceSha256;
  } catch {
    return false;
  }
}

async function verifyManagedNode(request: ManagedNodeVerificationRequest): Promise<void> {
  const environment = {
    PATH: dirname(request.nodeExecutable),
    TMPDIR: join(request.runtimeDirectory, '.tmp'),
  };
  await mkdir(environment.TMPDIR, { recursive: true });
  try {
    const node = await execFileAsync(request.nodeExecutable, ['--version'], {
      env: environment,
      maxBuffer: 64 * 1024,
      signal: request.signal,
    });
    const npm = await execFileAsync(
      request.nodeExecutable,
      [request.npmCliPath, '--version'],
      { env: environment, maxBuffer: 64 * 1024, signal: request.signal },
    );
    if (node.stdout.trim() !== `v${request.nodeVersion}` || npm.stdout.trim() !== request.npmVersion) {
      throw new Error('version mismatch');
    }
  } catch (error) {
    rethrowAbort(error);
    throw new Error('The managed Node runtime smoke check failed.');
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
