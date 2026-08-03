import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LockedNpmInstallRequest {
  sourceDirectory: string;
  nodeExecutable: string;
  npmCliPath: string;
  cacheDirectory: string;
  lockfileSha256: string;
  signal?: AbortSignal;
}

export class LockedNpmInstallError extends Error {
  readonly name = 'LockedNpmInstallError';
  readonly code = 'quartz-engine-install-failed';
}

export async function installLockedNpmProject(
  request: LockedNpmInstallRequest,
): Promise<void> {
  const lockfilePath = join(request.sourceDirectory, 'package-lock.json');
  const lockfile = await readFile(lockfilePath);
  const actualChecksum = createHash('sha256').update(lockfile).digest('hex');
  if (actualChecksum !== request.lockfileSha256.toLowerCase()) {
    throw new LockedNpmInstallError(
      'The Quartz package lock checksum did not match the engine manifest.',
    );
  }

  try {
    await execFileAsync(
      request.nodeExecutable,
      [request.npmCliPath, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
      {
        cwd: request.sourceDirectory,
        env: {
          PATH: dirname(request.nodeExecutable),
          TMPDIR: tmpdir(),
          npm_config_audit: 'false',
          npm_config_cache: request.cacheDirectory,
          npm_config_fund: 'false',
          npm_config_global: 'false',
          npm_config_update_notifier: 'false',
        },
        maxBuffer: 1024 * 1024,
        signal: request.signal,
      },
    );
  } catch {
    throw new LockedNpmInstallError(
      'The locked Quartz production dependencies could not be installed.',
    );
  }
}
