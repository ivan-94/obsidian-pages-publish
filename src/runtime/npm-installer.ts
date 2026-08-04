import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearTimeout as cancelTimeout,
  setTimeout as scheduleTimeout,
} from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { rethrowAbort } from './quartz-environment-error';

const SYSTEM_COMMAND_PATH = '/usr/bin:/bin';
const TERMINATION_GRACE_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 25;

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
    await runNpmCi(request, isolatedUserConfig, isolatedGlobalConfig);
  } catch (error) {
    rethrowAbort(error);
    throw new LockedNpmInstallError(
      'The locked Quartz production dependencies could not be installed.',
    );
  }
}

async function runNpmCi(
  request: LockedNpmInstallRequest,
  isolatedUserConfig: string,
  isolatedGlobalConfig: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      request.nodeExecutable,
      [
        request.npmCliPath,
        'ci',
        '--include=dev',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: request.sourceDirectory,
        detached: true,
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
        stdio: 'ignore',
      },
    );
    const processGroupId = child.pid;
    let aborted = request.signal?.aborted ?? false;
    let forceKillTimer: ReturnType<typeof scheduleTimeout> | undefined;
    let settled = false;

    const cleanup = (): void => {
      request.signal?.removeEventListener('abort', abortProcessGroup);
      if (forceKillTimer !== undefined) cancelTimeout(forceKillTimer);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abortProcessGroup = (): void => {
      aborted = true;
      signalProcessGroup(child.pid, 'SIGTERM', child.kill.bind(child));
      forceKillTimer ??= scheduleTimeout(() => {
        signalProcessGroup(child.pid, 'SIGKILL', child.kill.bind(child));
      }, TERMINATION_GRACE_MS);
    };

    child.once('error', (error) => {
      settle(() => reject(aborted ? abortReason(request.signal) : error));
    });
    child.once('close', (exitCode, terminationSignal) => {
      void (async () => {
        if (aborted && processGroupId !== undefined) {
          await waitForProcessGroupExit(processGroupId);
        }
        settle(() => {
          if (aborted) {
            reject(abortReason(request.signal));
          } else if (exitCode === 0) {
            resolve();
          } else {
            reject(new Error(
              `npm ci exited with code ${String(exitCode)} (${String(terminationSignal)}).`,
            ));
          }
        });
      })().catch((error: unknown) => settle(() => reject(asError(error))));
    });

    request.signal?.addEventListener('abort', abortProcessGroup, { once: true });
    if (request.signal?.aborted) abortProcessGroup();
  });
}

function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: (signal: NodeJS.Signals) => boolean,
): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fallback(signal);
  }
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processGroupExists(processGroupId)) return;
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  throw new Error(`Timed out waiting for npm process group ${String(processGroupId)} to exit.`);
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The locked npm install was aborted.', 'AbortError');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
