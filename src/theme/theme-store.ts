import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { extractTrustedTarGz, UnsafeArchiveError } from '../runtime/safe-tar-extractor';
import {
  assertPublicationEnvironmentDiskCapacity,
  assertPublicationEnvironmentWithinBudget,
} from '../runtime/environment-disk-budget';
import {
  assertThemeIntegrity,
  validateThemePackageManifest,
  type ValidatedThemePackageManifest,
} from './theme-contract';
import { validateThemeOptionsSchema, type ThemeOptionsSchema } from './theme-options-schema';

const THEME_ARCHIVE_LIMIT = 16 * 1024 * 1024;
const THEME_EXPANDED_LIMIT = 64 * 1024 * 1024;
const THEME_FILE_LIMIT = 8 * 1024 * 1024;
const THEME_ENTRY_LIMIT = 2_000;
export const THEME_SMOKE_VERSION = 1;

export type ThemeInstallSource =
  | {
    kind: 'npm';
    packageName: string;
    version: string;
    tarballUrl: string;
    publisher?: { name?: string; email?: string };
  }
  | {
    kind: 'local';
    artifact: string;
  };

export interface ThemeInstallRequest {
  archive: Uint8Array;
  integrity: string;
  source: ThemeInstallSource;
  supportedQuartzVersion: string;
  signal?: AbortSignal;
}

export interface ThemeFileInventoryEntry {
  path: string;
  type: 'file';
  size: number;
  sha256: string;
}

export interface ThemeInstallReceipt {
  formatVersion: 1;
  packageName: string;
  version: string;
  integrity: string;
  source: ThemeInstallSource;
  manifest: ValidatedThemePackageManifest;
  inventory: ThemeFileInventoryEntry[];
  inventorySha256: string;
  smokeVersion: typeof THEME_SMOKE_VERSION;
  installedAt: string;
}

export interface InstalledTheme {
  packageDirectory: string;
  installationDirectory: string;
  receipt: ThemeInstallReceipt;
  optionsSchema?: ThemeOptionsSchema;
}

export interface ThemeSmokeRequest {
  packageDirectory: string;
  manifest: ValidatedThemePackageManifest;
  optionsSchema?: ThemeOptionsSchema;
  integrity: string;
  source: ThemeInstallSource;
  inventory: ThemeFileInventoryEntry[];
  signal?: AbortSignal;
}

export interface ThemeStoreDependencies {
  rootDirectory: string;
  smoke: (request: ThemeSmokeRequest) => Promise<void>;
  checkDiskCapacity?: (rootDirectory: string) => Promise<void>;
  checkEnvironmentSize?: (rootDirectory: string) => Promise<void>;
  now?: () => Date;
}

export class ThemeStoreError extends Error {
  readonly name = 'ThemeStoreError';

  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class ThemeStore {
  private readonly activeOperations = new Map<string, Promise<InstalledTheme>>();

  constructor(private readonly dependencies: ThemeStoreDependencies) {}

  install(request: ThemeInstallRequest): Promise<InstalledTheme> {
    return this.start(request, false);
  }

  repair(request: ThemeInstallRequest): Promise<InstalledTheme> {
    return this.start(request, true);
  }

  async resolveExact(
    packageName: string,
    version: string,
    integrity: string,
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledTheme> {
    assertThemeIntegrity(integrity, 'integrity');
    const directory = this.installationDirectory(packageName, version, integrity);
    return this.verifyInstallation(directory, {
      packageName,
      version,
      integrity,
      supportedQuartzVersion,
      signal,
    });
  }

  async resolveIntegrity(
    integrity: string,
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledTheme> {
    assertThemeIntegrity(integrity, 'integrity');
    const themesRoot = join(this.dependencies.rootDirectory, 'themes');
    let packageDirectories: string[];
    try {
      packageDirectories = await readdir(themesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ThemeStoreError('theme-not-installed', 'Theme is not installed.');
      }
      throw error;
    }
    const matches: string[] = [];
    for (const packageId of packageDirectories.sort()) {
      if (packageId.startsWith('.')) continue;
      const packageRoot = join(themesRoot, packageId);
      const versions = await readdir(packageRoot).catch(() => []);
      for (const versionDirectory of versions.sort()) {
        const directory = join(packageRoot, versionDirectory);
        const receipt = await readReceipt(directory).catch(() => undefined);
        if (receipt?.integrity === integrity) matches.push(directory);
      }
    }
    if (matches.length !== 1) {
      throw new ThemeStoreError(
        matches.length === 0 ? 'theme-not-installed' : 'theme-integrity-ambiguous',
        matches.length === 0
          ? 'Theme is not installed.'
          : 'Multiple installed themes unexpectedly share the requested integrity.',
      );
    }
    const receipt = await readReceipt(matches[0] as string);
    return this.verifyInstallation(matches[0] as string, {
      packageName: receipt.packageName,
      version: receipt.version,
      integrity,
      supportedQuartzVersion,
      signal,
    });
  }

  async listInstalled(
    supportedQuartzVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledTheme[]> {
    const themesRoot = join(this.dependencies.rootDirectory, 'themes');
    const installed: InstalledTheme[] = [];
    const packageDirectories = await readdir(themesRoot).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const packageId of packageDirectories.sort()) {
      signal?.throwIfAborted();
      if (packageId.startsWith('.') || packageId === 'trust-receipts.json') continue;
      const packageRoot = join(themesRoot, packageId);
      const versions = await readdir(packageRoot).catch(() => []);
      for (const versionDirectory of versions.sort()) {
        signal?.throwIfAborted();
        const directory = join(packageRoot, versionDirectory);
        const receipt = await readReceipt(directory).catch(() => undefined);
        if (!receipt) continue;
        try {
          installed.push(await this.verifyInstallation(directory, {
            packageName: receipt.packageName,
            version: receipt.version,
            integrity: receipt.integrity,
            supportedQuartzVersion,
            signal,
          }));
        } catch {
          // Corrupt installations are addressed through Repair and must never
          // be offered as selectable verified versions.
        }
      }
    }
    return installed.sort((left, right) =>
      `${left.receipt.packageName}@${left.receipt.version}:${left.receipt.integrity}`
        .localeCompare(`${right.receipt.packageName}@${right.receipt.version}:${right.receipt.integrity}`));
  }

  async uninstall(
    theme: Pick<ThemeInstallReceipt, 'packageName' | 'version' | 'integrity'>,
    isInUse: (theme: Pick<ThemeInstallReceipt, 'packageName' | 'version' | 'integrity'>) => Promise<boolean>,
  ): Promise<void> {
    if (await isInUse(theme)) {
      throw new ThemeStoreError(
        'theme-in-use',
        'Active theme cannot be uninstalled. Save another theme or the Quartz default first.',
      );
    }
    const directory = this.installationDirectory(
      theme.packageName,
      theme.version,
      theme.integrity,
    );
    await rm(directory, { recursive: true, force: true });
    await removeEmptyParent(dirname(directory));
  }

  private start(request: ThemeInstallRequest, repair: boolean): Promise<InstalledTheme> {
    const key = `${request.integrity}:${repair ? 'repair' : 'install'}`;
    const active = this.activeOperations.get(key);
    if (active) return active;
    const operation = this.installExclusive(request, repair);
    this.activeOperations.set(key, operation);
    void operation.finally(() => {
      if (this.activeOperations.get(key) === operation) this.activeOperations.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async installExclusive(
    request: ThemeInstallRequest,
    repair: boolean,
  ): Promise<InstalledTheme> {
    request.signal?.throwIfAborted();
    verifyIntegrity(request.archive, request.integrity);
    await (this.dependencies.checkDiskCapacity
      ?? assertPublicationEnvironmentDiskCapacity)(this.dependencies.rootDirectory);
    const themesRoot = join(this.dependencies.rootDirectory, 'themes');
    await mkdir(themesRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(themesRoot, '.install-'));
    const temporaryPackage = join(temporaryDirectory, 'package');
    let finalDirectory: string | undefined;
    let replacedDirectory: string | undefined;
    try {
      try {
        await extractTrustedTarGz(request.archive, temporaryPackage, {
          maxCompressedBytes: THEME_ARCHIVE_LIMIT,
          maxExpandedBytes: THEME_EXPANDED_LIMIT,
          maxFileBytes: THEME_FILE_LIMIT,
          maxEntries: THEME_ENTRY_LIMIT,
        });
      } catch (error) {
        if (error instanceof UnsafeArchiveError) {
          throw new ThemeStoreError(
            'theme-archive-unsafe',
            'Theme package is not a safe bounded npm tarball.',
            error,
          );
        }
        throw error;
      }
      request.signal?.throwIfAborted();
      const manifest = await readAndValidateManifest(
        temporaryPackage,
        request.supportedQuartzVersion,
      );
      assertRequestedIdentity(manifest, request.source);
      const optionsSchema = await readOptionsSchema(temporaryPackage, manifest);
      const inventory = await inventoryPackage(temporaryPackage);
      await this.dependencies.smoke({
        packageDirectory: temporaryPackage,
        manifest,
        ...(optionsSchema === undefined ? {} : { optionsSchema }),
        integrity: request.integrity,
        source: request.source,
        inventory,
        signal: request.signal,
      });
      request.signal?.throwIfAborted();
      const receipt: ThemeInstallReceipt = {
        formatVersion: 1,
        packageName: manifest.name,
        version: manifest.version,
        integrity: request.integrity,
        source: structuredClone(request.source),
        manifest,
        inventory,
        inventorySha256: inventoryDigest(inventory),
        smokeVersion: THEME_SMOKE_VERSION,
        installedAt: (this.dependencies.now?.() ?? new Date()).toISOString(),
      };
      await writeFile(
        join(temporaryDirectory, 'receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await (this.dependencies.checkEnvironmentSize
        ?? assertPublicationEnvironmentWithinBudget)(this.dependencies.rootDirectory);
      await makePackageReadOnly(temporaryPackage);
      finalDirectory = this.installationDirectory(
        manifest.name,
        manifest.version,
        request.integrity,
      );
      await mkdir(dirname(finalDirectory), { recursive: true });
      if (await pathExists(finalDirectory)) {
        if (!repair) {
          await rm(temporaryDirectory, { recursive: true, force: true });
          return this.verifyInstallation(finalDirectory, {
            packageName: manifest.name,
            version: manifest.version,
            integrity: request.integrity,
            supportedQuartzVersion: request.supportedQuartzVersion,
            signal: request.signal,
          });
        }
        replacedDirectory = join(
          dirname(finalDirectory),
          `.replaced-${basename(finalDirectory)}-${randomUUID()}`,
        );
        await rename(finalDirectory, replacedDirectory);
      }
      try {
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        if (replacedDirectory !== undefined) {
          await rename(replacedDirectory, finalDirectory);
          replacedDirectory = undefined;
        }
        throw error;
      }
      if (replacedDirectory !== undefined) {
        await rm(replacedDirectory, { recursive: true, force: true });
        replacedDirectory = undefined;
      }
      return {
        packageDirectory: join(finalDirectory, 'package'),
        installationDirectory: finalDirectory,
        receipt,
        ...(optionsSchema === undefined ? {} : { optionsSchema }),
      };
    } catch (error) {
      if (replacedDirectory !== undefined && finalDirectory !== undefined) {
        await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
        await rename(replacedDirectory, finalDirectory).catch(() => undefined);
      }
      throw normalizeStoreError(error);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async verifyInstallation(
    directory: string,
    expected: {
      packageName: string;
      version: string;
      integrity: string;
      supportedQuartzVersion: string;
      signal?: AbortSignal;
    },
  ): Promise<InstalledTheme> {
    try {
      expected.signal?.throwIfAborted();
      const receipt = await readReceipt(directory);
      if (
        receipt.packageName !== expected.packageName ||
        receipt.version !== expected.version ||
        receipt.integrity !== expected.integrity ||
        receipt.smokeVersion !== THEME_SMOKE_VERSION
      ) {
        throw new ThemeStoreError(
          'theme-installation-damaged',
          'Installed theme receipt does not match the requested identity.',
        );
      }
      const packageDirectory = join(directory, 'package');
      const manifest = await readAndValidateManifest(
        packageDirectory,
        expected.supportedQuartzVersion,
      );
      if (manifest.name !== expected.packageName || manifest.version !== expected.version) {
        throw new ThemeStoreError(
          'theme-installation-damaged',
          'Installed theme manifest does not match its receipt.',
        );
      }
      if (JSON.stringify(manifest) !== JSON.stringify(receipt.manifest)) {
        throw new ThemeStoreError(
          'theme-installation-damaged',
          'Installed theme manifest has drifted from its verified receipt.',
        );
      }
      const inventory = await inventoryPackage(packageDirectory);
      if (
        inventoryDigest(inventory) !== receipt.inventorySha256 ||
        JSON.stringify(inventory) !== JSON.stringify(receipt.inventory)
      ) {
        throw new ThemeStoreError(
          'theme-installation-damaged',
          'Installed theme file inventory has changed.',
        );
      }
      const optionsSchema = await readOptionsSchema(packageDirectory, manifest);
      await this.dependencies.smoke({
        packageDirectory,
        manifest,
        ...(optionsSchema === undefined ? {} : { optionsSchema }),
        integrity: receipt.integrity,
        source: receipt.source,
        inventory,
        signal: expected.signal,
      });
      return {
        packageDirectory,
        installationDirectory: directory,
        receipt,
        ...(optionsSchema === undefined ? {} : { optionsSchema }),
      };
    } catch (error) {
      if (error instanceof ThemeStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ThemeStoreError('theme-not-installed', 'Theme is not installed.', error);
      }
      throw new ThemeStoreError(
        'theme-installation-damaged',
        'Installed theme could not be verified.',
        error,
      );
    }
  }

  private installationDirectory(
    packageName: string,
    version: string,
    integrity: string,
  ): string {
    const safeName = packageName
      .replace(/^@/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 80);
    const packageId = `${safeName}-${sha256(packageName).slice(0, 12)}`;
    const integrityId = sha256(integrity).slice(0, 16);
    return join(
      this.dependencies.rootDirectory,
      'themes',
      packageId,
      `${version}-${integrityId}`,
    );
  }
}

async function readAndValidateManifest(
  packageDirectory: string,
  supportedQuartzVersion: string,
): Promise<ValidatedThemePackageManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as unknown;
  } catch (error) {
    throw new ThemeStoreError(
      'theme-manifest-invalid',
      'Theme package.json is missing or invalid.',
      error,
    );
  }
  try {
    return validateThemePackageManifest(raw, supportedQuartzVersion);
  } catch (error) {
    throw new ThemeStoreError(
      'theme-manifest-invalid',
      'Theme package manifest does not satisfy the Theme Contract.',
      error,
    );
  }
}

async function readOptionsSchema(
  packageDirectory: string,
  manifest: ValidatedThemePackageManifest,
): Promise<ThemeOptionsSchema | undefined> {
  const path = manifest.metadata.optionsSchema;
  if (path === undefined) return undefined;
  try {
    const source = await readFile(join(packageDirectory, path.slice(2)), 'utf8');
    return validateThemeOptionsSchema(JSON.parse(source) as unknown);
  } catch (error) {
    throw new ThemeStoreError(
      'theme-options-schema-invalid',
      'Theme options schema is missing or invalid.',
      error,
    );
  }
}

function assertRequestedIdentity(
  manifest: ValidatedThemePackageManifest,
  source: ThemeInstallSource,
): void {
  if (
    source.kind === 'npm' &&
    (manifest.name !== source.packageName || manifest.version !== source.version)
  ) {
    throw new ThemeStoreError(
      'theme-package-identity-mismatch',
      'Downloaded theme package identity does not match the requested npm package.',
    );
  }
}

async function inventoryPackage(
  packageDirectory: string,
): Promise<ThemeFileInventoryEntry[]> {
  const inventory: ThemeFileInventoryEntry[] = [];
  await visit(packageDirectory, packageDirectory, inventory);
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function visit(
  root: string,
  directory: string,
  inventory: ThemeFileInventoryEntry[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
      throw new ThemeStoreError(
        'theme-installation-damaged',
        `Theme package contains an unsupported filesystem entry: ${entry.name}.`,
      );
    }
    if (entry.isDirectory()) {
      await visit(root, path, inventory);
      continue;
    }
    const bytes = await readFile(path);
    inventory.push({
      path: relative(root, path).split(sep).join('/'),
      type: 'file',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}

async function makePackageReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makePackageReadOnly(path);
      await chmod(path, 0o755);
    } else {
      await chmod(path, 0o444);
    }
  }
  // Keep directories traversable/removable by the store. Build-time sandboxing
  // supplies the actual read-only boundary; immutable package files catch
  // accidental in-process writes without making Repair cleanup impossible.
  await chmod(directory, 0o755);
}

async function readReceipt(directory: string): Promise<ThemeInstallReceipt> {
  const value = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ThemeStoreError('theme-installation-damaged', 'Theme receipt is invalid.');
  }
  const receipt = value as Partial<ThemeInstallReceipt>;
  if (
    receipt.formatVersion !== 1 ||
    typeof receipt.packageName !== 'string' ||
    typeof receipt.version !== 'string' ||
    typeof receipt.integrity !== 'string' ||
    !Array.isArray(receipt.inventory) ||
    typeof receipt.inventorySha256 !== 'string' ||
    receipt.smokeVersion !== THEME_SMOKE_VERSION
  ) {
    throw new ThemeStoreError('theme-installation-damaged', 'Theme receipt is invalid.');
  }
  return receipt as ThemeInstallReceipt;
}

function verifyIntegrity(archive: Uint8Array, expected: string): void {
  assertThemeIntegrity(expected, 'integrity');
  const actual = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (actual !== expected) {
    throw new ThemeStoreError(
      'theme-integrity-mismatch',
      'Theme archive did not match its exact sha512 integrity.',
    );
  }
}

function inventoryDigest(inventory: ThemeFileInventoryEntry[]): string {
  return sha256(JSON.stringify(inventory));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeEmptyParent(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) await rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function normalizeStoreError(error: unknown): Error {
  if (
    error instanceof ThemeStoreError ||
    error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && error.name === 'AbortError'
  ) return error;
  return new ThemeStoreError('theme-install-failed', 'Theme installation failed.', error);
}
