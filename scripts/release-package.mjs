import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const MINIMUM_OBSIDIAN_VERSION = '1.13.0';

const installableFiles = ['manifest.json', 'main.js', 'styles.css'];

/**
 * Creates the exact directory that can be copied to
 * <Vault>/.obsidian/plugins/<plugin-id>. No source, test, credential or cache
 * file is ever included in the installable plugin package.
 */
export async function stagePluginPackage({ projectRoot, distRoot }) {
  const manifestPath = join(projectRoot, 'manifest.json');
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  validateCompatibilityMap(
    JSON.parse(await readFile(join(projectRoot, 'versions.json'), 'utf8')),
    manifest,
  );
  const resolvedDist = resolve(distRoot);
  const directory = resolve(resolvedDist, `${manifest.id}-${manifest.version}`);
  if (relative(resolvedDist, directory).startsWith(`..${sep}`) || directory === resolvedDist) {
    throw new Error('The release destination must remain inside the requested dist directory.');
  }

  await mkdir(resolvedDist, { recursive: true });
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  for (const file of installableFiles) {
    await copyFile(join(projectRoot, file), join(directory, file));
  }
  return { directory, pluginId: manifest.id, version: manifest.version };
}

function validateManifest(value) {
  if (typeof value !== 'object' || value === null) {
    throw new Error('manifest.json must contain an object.');
  }
  const manifest = value;
  if (typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/u.test(manifest.id)) {
    throw new Error('manifest.json must contain a safe plugin id.');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error('manifest.json must contain a semantic plugin version.');
  }
  if (typeof manifest.minAppVersion !== 'string' ||
    compareVersion(manifest.minAppVersion, MINIMUM_OBSIDIAN_VERSION) < 0) {
    throw new Error(
      `The plugin minimum Obsidian version must be ${MINIMUM_OBSIDIAN_VERSION} or newer.`,
    );
  }
  if (manifest.isDesktopOnly !== true) {
    throw new Error('The release package must remain desktop-only.');
  }
  return manifest;
}

function validateCompatibilityMap(value, manifest) {
  if (typeof value !== 'object' || value === null ||
    value[manifest.version] !== manifest.minAppVersion) {
    throw new Error(
      'versions.json must map the packaged version to the manifest minimum Obsidian version.',
    );
  }
}

function compareVersion(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] !== parsedRight[index]) {
      return parsedLeft[index] - parsedRight[index];
    }
  }
  return 0;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await stagePluginPackage({
    projectRoot,
    distRoot: join(projectRoot, 'release'),
  });
  process.stdout.write(`Staged ${result.pluginId} ${result.version} at ${result.directory}\n`);
}
