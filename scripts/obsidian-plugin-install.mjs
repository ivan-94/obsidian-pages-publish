import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const OBSIDIAN_PLUGIN_FILES = Object.freeze([
  'main.js',
  'manifest.json',
  'styles.css',
]);

/**
 * File-system-only smoke helper for a blank Vault. It deliberately preserves
 * existing non-package plugin data (such as Obsidian's non-secret `data.json`)
 * and never reads, writes, or deletes site content outside the selected plugin
 * directory.
 */
export async function installStagedObsidianPlugin(input) {
  const vaultRoot = resolve(input.vaultRoot);
  const configRoot = resolveVaultChild(vaultRoot, input.configDir);
  const pluginsRoot = resolveVaultChild(configRoot, 'plugins');
  const manifest = await readInstallableManifest(input.stagedDirectory);
  const pluginDirectory = resolveVaultChild(pluginsRoot, manifest.id);

  await ensureSafeVaultDirectory(vaultRoot, pluginDirectory);
  for (const file of OBSIDIAN_PLUGIN_FILES) {
    await atomicallyInstallFile({
      vaultRoot,
      pluginDirectory,
      source: join(manifest.directory, file),
      file,
    });
  }
  return {
    pluginDirectory,
    pluginId: manifest.id,
    version: manifest.version,
  };
}

/** Removes only one validated plugin directory; it never touches Vault content or remote state. */
export async function uninstallStagedObsidianPlugin(input) {
  const vaultRoot = resolve(input.vaultRoot);
  const configRoot = resolveVaultChild(vaultRoot, input.configDir);
  const pluginsRoot = resolveVaultChild(configRoot, 'plugins');
  const pluginId = validatePluginId(input.pluginId);
  const pluginDirectory = resolveVaultChild(pluginsRoot, pluginId);

  if (!(await isExistingSafeVaultDirectory(vaultRoot, configRoot))) return;
  if (!(await isExistingSafeVaultDirectory(vaultRoot, pluginsRoot))) return;
  await rm(pluginDirectory, { recursive: true, force: true });
}

async function readInstallableManifest(stagedDirectory) {
  const stagedRoot = resolve(stagedDirectory);
  const entries = (await readdir(stagedRoot, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== OBSIDIAN_PLUGIN_FILES.length ||
    entries.some((entry, index) => entry !== OBSIDIAN_PLUGIN_FILES[index])) {
    throw new Error('A staged package must contain exactly the three installable files.');
  }
  for (const file of OBSIDIAN_PLUGIN_FILES) {
    const source = join(stagedRoot, file);
    const stats = await lstat(source);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`A staged package file must be a regular file: ${file}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(stagedRoot, 'manifest.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('The staged manifest must be an object.');
  }
  return {
    directory: stagedRoot,
    id: validatePluginId(manifest.id),
    version: validateVersion(manifest.version),
  };
}

function resolveVaultChild(root, child) {
  if (typeof child !== 'string' || child.length === 0 || isAbsolute(child)) {
    throw new Error('The plugin path must remain inside the selected Vault.');
  }
  const candidate = resolve(root, child);
  const path = relative(root, candidate);
  if (path === '' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('The plugin path must remain inside the selected Vault.');
  }
  return candidate;
}

async function ensureSafeVaultDirectory(vaultRoot, directory) {
  await inspectSafeVaultDirectory(vaultRoot, directory, true);
  // Recheck the whole chain after mkdir: an ancestor must not become a
  // symlink while a missing child is being created.
  await inspectSafeVaultDirectory(vaultRoot, directory, false);
}

async function isExistingSafeVaultDirectory(vaultRoot, directory) {
  return inspectSafeVaultDirectory(vaultRoot, directory, false);
}

async function inspectSafeVaultDirectory(vaultRoot, directory, createMissing) {
  const rootStats = await lstat(vaultRoot);
  assertRegularDirectory(rootStats);
  const path = relative(vaultRoot, directory);
  if (path === '' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('The plugin path must remain inside the selected Vault.');
  }
  let current = vaultRoot;
  for (const segment of path.split(sep)) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!createMissing) return false;
      await mkdir(current);
      stats = await lstat(current);
    }
    assertRegularDirectory(stats);
  }
  const [realVault, realDirectory] = await Promise.all([
    realpath(vaultRoot),
    realpath(directory),
  ]);
  const actualPath = relative(realVault, realDirectory);
  if (actualPath === '' || actualPath.startsWith(`..${sep}`) || isAbsolute(actualPath)) {
    throw new Error('The plugin path must remain inside the selected Vault.');
  }
  return true;
}

async function atomicallyInstallFile(input) {
  await ensureSafeVaultDirectory(input.vaultRoot, input.pluginDirectory);
  const destination = join(input.pluginDirectory, input.file);
  const temporary = join(
    input.pluginDirectory,
    `.${input.file}.install-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(input.source, temporary);
    const stats = await lstat(temporary);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Temporary package files must be regular files.');
    }
    // rename replaces a destination symlink itself rather than following it.
    await ensureSafeVaultDirectory(input.vaultRoot, input.pluginDirectory);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertRegularDirectory(stats) {
  if (stats.isSymbolicLink()) {
    throw new Error('Plugin installation paths must not traverse a symbolic link.');
  }
  if (!stats.isDirectory()) {
    throw new Error('Plugin installation directories must be regular directories.');
  }
}

function isNotFound(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

function validatePluginId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/u.test(value)) {
    throw new Error('The staged manifest must contain a safe plugin id.');
  }
  return value;
}

function validateVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error('The staged manifest must contain a semantic version.');
  }
  return value;
}
