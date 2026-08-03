import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { rethrowAbort } from './quartz-environment-error';

const execFileAsync = promisify(execFile);
const SYSTEM_COMMAND_PATH = '/usr/bin:/bin';

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

  await mkdir(request.cacheDirectory, { recursive: true });
  const isolatedUserConfig = join(request.cacheDirectory, '.pages-publish-user-npmrc');
  const isolatedGlobalConfig = join(request.cacheDirectory, '.pages-publish-global-npmrc');
  await Promise.all([
    writeFile(isolatedUserConfig, '', { mode: 0o600 }),
    writeFile(isolatedGlobalConfig, '', { mode: 0o600 }),
  ]);

  try {
    await execFileAsync(
      request.nodeExecutable,
      [request.npmCliPath, 'ci', '--include=dev', '--no-audit', '--no-fund'],
      {
        cwd: request.sourceDirectory,
        env: {
          // npm lifecycle scripts invoke POSIX tools (notably `sh`). Keep the
          // managed Node first while exposing only the macOS system command
          // directories instead of inheriting the user's mutable PATH.
          PATH: `${dirname(request.nodeExecutable)}:${SYSTEM_COMMAND_PATH}`,
          TMPDIR: tmpdir(),
          npm_config_audit: 'false',
          npm_config_cache: request.cacheDirectory,
          npm_config_fund: 'false',
          npm_config_global: 'false',
          npm_config_globalconfig: isolatedGlobalConfig,
          npm_config_registry: 'https://registry.npmjs.org/',
          npm_config_replace_registry_host: 'never',
          npm_config_update_notifier: 'false',
          npm_config_userconfig: isolatedUserConfig,
        },
        maxBuffer: 1024 * 1024,
        signal: request.signal,
      },
    );
  } catch (error) {
    rethrowAbort(error);
    throw new LockedNpmInstallError(
      'The locked Quartz production dependencies could not be installed.',
    );
  }
}
