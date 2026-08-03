import { lstat, mkdir, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { QuartzEnvironmentError } from './quartz-environment-error';

export const minimumPublicationEnvironmentFreeBytes = 2 * 1024 * 1024 * 1024;
export const maximumPublicationEnvironmentBytes = Math.floor(1.5 * 1024 * 1024 * 1024);

export async function assertPublicationEnvironmentDiskCapacity(
  rootDirectory: string,
  minimumFreeBytes = minimumPublicationEnvironmentFreeBytes,
): Promise<void> {
  await mkdir(rootDirectory, { recursive: true });
  const statistics = await statfs(rootDirectory);
  const availableBytes = statistics.bavail * statistics.bsize;
  if (availableBytes < minimumFreeBytes) {
    throw new QuartzEnvironmentError(
      'publication-environment-disk-insufficient',
      `Pages Publish requires at least ${formatBytes(minimumFreeBytes)} of free disk space.`,
    );
  }
}

export async function assertPublicationEnvironmentWithinBudget(
  rootDirectory: string,
  maximumBytes = maximumPublicationEnvironmentBytes,
): Promise<void> {
  const actualBytes = await directoryBytes(rootDirectory);
  if (actualBytes > maximumBytes) {
    throw new QuartzEnvironmentError(
      'publication-environment-disk-insufficient',
      `The Pages Publish environment exceeds its ${formatBytes(maximumBytes)} disk budget.`,
    );
  }
}

export async function directoryBytes(rootDirectory: string): Promise<number> {
  let total = 0;
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const statistics = await lstat(path);
      total += statistics.size;
      if (!Number.isSafeInteger(total)) {
        throw new QuartzEnvironmentError(
          'publication-environment-disk-insufficient',
          'The Pages Publish environment size could not be measured safely.',
        );
      }
    }
  }
  return total;
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
