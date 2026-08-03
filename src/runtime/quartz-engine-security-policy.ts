import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const quartzEngineSecurityDispositions = Object.freeze([
  Object.freeze({
    advisory: 'GHSA-f88m-g3jw-g9cj',
    package: 'sharp',
    severity: 'high',
    disposition: 'disabled OG-image and favicon plugin entry points plus sharp/libvips are removed',
  }),
  Object.freeze({
    advisory: 'GHSA-mh99-v99m-4gvg',
    package: 'serve-handler>brace-expansion',
    severity: 'high',
    disposition: 'serve-only dependency is lazy and removed; publication invokes build only',
  }),
]);

/** Removes audited packages that are unreachable in the controlled build profile. */
export async function pruneDisabledQuartzPackages(engineDirectory: string): Promise<void> {
  const nodeModules = join(engineDirectory, 'node_modules');
  await Promise.all([
    rm(join(nodeModules, 'sharp'), { recursive: true, force: true }),
    rm(join(nodeModules, 'serve-handler'), { recursive: true, force: true }),
    rm(join(nodeModules, '@quartz-community', 'og-image'), { recursive: true, force: true }),
    rm(join(nodeModules, '@quartz-community', 'favicon'), { recursive: true, force: true }),
  ]);
  const imagePackages = join(nodeModules, '@img');
  let entries: string[] = [];
  try {
    entries = await readdir(imagePackages);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('sharp-'))
      .map((entry) => rm(join(imagePackages, entry), { recursive: true, force: true })),
  );
}

export async function disabledQuartzPackagesAreAbsent(engineDirectory: string): Promise<boolean> {
  for (const path of [
    'node_modules/sharp',
    'node_modules/serve-handler',
    'node_modules/@quartz-community/og-image',
    'node_modules/@quartz-community/favicon',
  ]) {
    try {
      await access(join(engineDirectory, path));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
