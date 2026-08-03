import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { compatibleNodeVersion } from './environment-manager';
import type { QuartzEngineRuntimeTools } from './quartz-engine-store';

const execFileAsync = promisify(execFile);

export interface EmbeddedRuntimeCandidate {
  nodeExecutable: string;
  nodeVersion: string;
  npmCliPath?: string;
}

export interface PublicationRuntimeTools extends QuartzEngineRuntimeTools {
  source: 'obsidian' | 'managed';
}

/**
 * Reuses Obsidian's embedded Node only when the matching distribution also
 * exposes a sufficiently recent npm CLI. A bare Electron Node executable is
 * not enough for a locked first-time Quartz installation.
 */
export async function inspectEmbeddedPublicationRuntime(
  candidate: EmbeddedRuntimeCandidate,
  inspectNpmVersion: (
    nodeExecutable: string,
    npmCliPath: string,
  ) => Promise<string> = readNpmVersion,
): Promise<PublicationRuntimeTools | undefined> {
  if (!compatibleNodeVersion(candidate.nodeVersion)) return undefined;
  const npmCliPath = resolve(candidate.npmCliPath ?? defaultNpmCliPath(candidate.nodeExecutable));
  try {
    await access(candidate.nodeExecutable);
    await access(npmCliPath);
    const npmVersion = (await inspectNpmVersion(candidate.nodeExecutable, npmCliPath)).trim();
    if (!compatibleNpmVersion(npmVersion)) return undefined;
    return {
      nodeExecutable: resolve(candidate.nodeExecutable),
      nodeVersion: candidate.nodeVersion.replace(/^v/u, ''),
      npmCliPath,
      npmVersion,
      source: 'obsidian',
    };
  } catch {
    return undefined;
  }
}

export function asManagedPublicationRuntime(
  runtime: QuartzEngineRuntimeTools,
): PublicationRuntimeTools {
  return { ...runtime, source: 'managed' };
}

function defaultNpmCliPath(nodeExecutable: string): string {
  return join(
    dirname(nodeExecutable),
    '..',
    'lib',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
}

async function readNpmVersion(
  nodeExecutable: string,
  npmCliPath: string,
): Promise<string> {
  const result = await execFileAsync(nodeExecutable, [npmCliPath, '--version'], {
    env: {
      PATH: dirname(nodeExecutable),
      TMPDIR: tmpdir(),
    },
    maxBuffer: 64 * 1024,
  });
  return result.stdout;
}

function compatibleNpmVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (major ?? 0) > 10
    || major === 10 && ((minor ?? 0) > 9 || minor === 9 && (patch ?? 0) >= 2);
}
