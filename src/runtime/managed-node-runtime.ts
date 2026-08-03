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
}

export interface ManagedNodeRuntimeDependencies {
  rootDirectory: string;
  download: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  verify?: (request: ManagedNodeVerificationRequest) => Promise<void>;
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
  ): Promise<QuartzEngineRuntimeTools> {
    if (this.activeOperation) return this.activeOperation;
    const operation = this.ensureReadyExclusive(inputManifest, signal);
    this.activeOperation = operation;
    void operation.finally(() => {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async ensureReadyExclusive(
    inputManifest: Readonly<ManagedNodeManifest>,
    signal?: AbortSignal,
  ): Promise<QuartzEngineRuntimeTools> {
    const manifest = validateManifest(inputManifest);
    const platformDirectory = join(
      this.dependencies.rootDirectory,
      'runtimes',
      manifest.platform,
    );
    const runtimeDirectory = join(platformDirectory, `node-${manifest.version}`);
    const tools = runtimeTools(runtimeDirectory, manifest);
    if (await runtimeMatches(runtimeDirectory, manifest)) return tools;

    await mkdir(platformDirectory, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(platformDirectory, '.install-'));
    let moved = false;
    try {
      const archive = await this.dependencies.download(manifest.sourceUrl, signal);
      const actualSha256 = createHash('sha256').update(archive).digest('hex');
      if (actualSha256 !== manifest.sourceSha256) {
        throw new Error('The managed Node runtime checksum did not match.');
      }
      await extractTrustedNodeRuntimeTarGz(archive, temporaryDirectory, {
        maxCompressedBytes: 64 * 1024 * 1024,
        maxExpandedBytes: 512 * 1024 * 1024,
      });
      const temporaryTools = runtimeTools(temporaryDirectory, manifest);
      await chmod(temporaryTools.nodeExecutable, 0o755);
      await (this.dependencies.verify ?? verifyManagedNode)({
        ...temporaryTools,
        runtimeDirectory: temporaryDirectory,
      });
      await writeFile(
        join(temporaryDirectory, '.pages-publish-verified.json'),
        `${JSON.stringify(manifest)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      if (await pathExists(runtimeDirectory)) {
        await rename(
          runtimeDirectory,
          join(platformDirectory, `.invalid-node-${manifest.version}-${randomUUID()}`),
        );
      }
      await rename(temporaryDirectory, runtimeDirectory);
      moved = true;
      return tools;
    } finally {
      if (!moved) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function validateManifest(manifest: Readonly<ManagedNodeManifest>): Readonly<ManagedNodeManifest> {
  const expected = builtinManagedNodeManifest(manifest.platform);
  if (
    manifest.version !== expected.version
    || manifest.npmVersion !== expected.npmVersion
    || manifest.sourceUrl !== expected.sourceUrl
    || !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)
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
    });
    const npm = await execFileAsync(
      request.nodeExecutable,
      [request.npmCliPath, '--version'],
      { env: environment, maxBuffer: 64 * 1024 },
    );
    if (node.stdout.trim() !== `v${request.nodeVersion}` || npm.stdout.trim() !== request.npmVersion) {
      throw new Error('version mismatch');
    }
  } catch {
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
