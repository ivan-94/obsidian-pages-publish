import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUILTIN_THEME_CATALOG,
  type BuiltinThemeDefinition,
} from '../theme/builtin-theme-catalog';

const marker = 'loadPaths: [path.join(process.cwd(), "node_modules")]';
const cacheImportNeedle = 'await import(`../../${cacheFile}?update=${randomUUID()}`)';
const cacheImportPatch = 'await import(`${path.resolve(cacheFile)}?update=${randomUUID()}`)';
const serveImportNeedle = 'import serveHandler from "serve-handler"';
const serveCallNeedle = '        await serveHandler(req, res, {';
const serveCallPatch = [
  '        const { default: serveHandler } = await import("serve-handler")',
  serveCallNeedle,
].join('\n');
const folderPageVersion = '0.1.0';
const folderListNeedle = 'const pageListContent = PageList(listProps);';
const folderListPatch = 'const pageListContent = null /* pages-publish-controlled-section-list */;';
const gitignoreNeedle = 'gitignore: true,';
const gitignorePatch = 'gitignore: false, // pages-publish-controlled-content-root';

export const quartzEngineCompatibilityPatches = Object.freeze([
  'controlled-workspace-sass-resolution',
  'workspace-cache-import',
  'lazy-disabled-serve-handler',
  'controlled-content-root-glob',
  'route-manifest-controlled-folder-listing',
  'pinned-builtin-theme-packages',
]);

export async function applyQuartzEngineCompatibilityPatch(
  engineDirectory: string,
): Promise<void> {
  const handlersPath = join(engineDirectory, 'quartz', 'cli', 'handlers.js');
  const globPath = join(engineDirectory, 'quartz', 'util', 'glob.ts');
  const source = await readFile(handlersPath, 'utf8');
  const globSource = await readFile(globPath, 'utf8');
  const handlersPatched = (
    source.includes(marker)
    && source.includes(cacheImportPatch)
    && source.includes(serveCallPatch)
    && !source.includes(serveImportNeedle)
  );
  const globPatched = globSource.includes(gitignorePatch)
    && !globSource.includes(gitignoreNeedle);
  const builtinThemesPinned = await builtinThemeSourcesMatch(engineDirectory);
  if (handlersPatched && globPatched && builtinThemesPinned) return;

  if (!handlersPatched) {
    const needle = 'cssImports: true,';
    const matches = source.split(needle).length - 1;
    if (
      matches !== 2
      || !source.includes(cacheImportNeedle)
      || !source.includes(serveImportNeedle)
      || !source.includes(serveCallNeedle)
    ) {
      throw new Error('The pinned Quartz compatibility patch no longer matches upstream source.');
    }
    const patched = source
      .replaceAll(needle, `${needle}\n        ${marker},`)
      .replace(cacheImportNeedle, cacheImportPatch)
      .replace(`${serveImportNeedle}\n`, '')
      .replace(serveCallNeedle, serveCallPatch);
    await writeFile(handlersPath, patched, { mode: 0o600 });
  }

  if (!globPatched) {
    if (
      globSource.split(gitignoreNeedle).length - 1 !== 1
      || globSource.includes(gitignorePatch)
    ) {
      throw new Error('The pinned Quartz compatibility patch no longer matches upstream source.');
    }
    await writeFile(
      globPath,
      globSource.replace(gitignoreNeedle, gitignorePatch),
      { mode: 0o600 },
    );
  }

  if (!builtinThemesPinned) await pinBuiltinThemeSources(engineDirectory);
}

export async function applyInstalledQuartzCompatibilityPatch(
  engineDirectory: string,
): Promise<void> {
  const packageDirectory = join(
    engineDirectory,
    'node_modules',
    '@quartz-community',
    'folder-page',
  );
  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  if (
    packageJson.name !== '@quartz-community/folder-page'
    || packageJson.version !== folderPageVersion
  ) {
    throw new Error('The pinned Quartz folder-page patch no longer matches the installed package.');
  }
  const entryPath = join(packageDirectory, 'dist', 'index.js');
  const source = await readFile(entryPath, 'utf8');
  if (source.includes(folderListPatch) && !source.includes(folderListNeedle)) {
    await assertInstalledBuiltinThemes(engineDirectory);
    return;
  }
  if (source.split(folderListNeedle).length - 1 !== 1 || source.includes(folderListPatch)) {
    throw new Error('The pinned Quartz folder-page patch no longer matches installed source.');
  }
  await writeFile(entryPath, source.replace(folderListNeedle, folderListPatch), { mode: 0o600 });
  await assertInstalledBuiltinThemes(engineDirectory);
}

export async function quartzCompatibilityPatchesMatch(
  engineDirectory: string,
): Promise<boolean> {
  try {
    const handlers = await readFile(join(engineDirectory, 'quartz', 'cli', 'handlers.js'), 'utf8');
    const globSource = await readFile(join(engineDirectory, 'quartz', 'util', 'glob.ts'), 'utf8');
    const folderPage = await readFile(
      join(
        engineDirectory,
        'node_modules',
        '@quartz-community',
        'folder-page',
        'dist',
        'index.js',
      ),
      'utf8',
    );
    const builtinThemesPinned = await builtinThemeSourcesMatch(engineDirectory);
    const builtinThemesInstalled = await installedBuiltinThemesMatch(engineDirectory);
    return handlers.includes(marker)
      && handlers.includes(cacheImportPatch)
      && handlers.includes(serveCallPatch)
      && !handlers.includes(serveImportNeedle)
      && globSource.includes(gitignorePatch)
      && !globSource.includes(gitignoreNeedle)
      && folderPage.includes(folderListPatch)
      && !folderPage.includes(folderListNeedle)
      && builtinThemesPinned
      && builtinThemesInstalled;
  } catch {
    return false;
  }
}

interface QuartzPackageJson {
  dependencies?: Record<string, string>;
}

interface QuartzPackageLock {
  lockfileVersion?: number;
  packages?: Record<string, {
    dependencies?: Record<string, string>;
    version?: string;
    resolved?: string;
    integrity?: string;
    license?: string;
  }>;
}

async function pinBuiltinThemeSources(engineDirectory: string): Promise<void> {
  const packageJsonPath = join(engineDirectory, 'package.json');
  const packageLockPath = join(engineDirectory, 'package-lock.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as QuartzPackageJson;
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8')) as QuartzPackageLock;
  const dependencies = packageJson.dependencies;
  const lockedPackages = packageLock.packages;
  const lockedRootDependencies = lockedPackages?.['']?.dependencies;
  if (
    dependencies?.['@quartz-themes/core'] !== '^1.0.0'
    || packageLock.lockfileVersion !== 3
    || lockedRootDependencies?.['@quartz-themes/core'] !== '^1.0.0'
    || lockedPackages?.['node_modules/@quartz-themes/core']?.version !== '1.1.0'
  ) {
    throw new Error('The pinned Quartz built-in theme dependency patch no longer matches upstream.');
  }
  for (const theme of BUILTIN_THEME_CATALOG) {
    assertCompatibleDependency(dependencies, theme);
    assertCompatibleDependency(lockedRootDependencies, theme);
    const path = `node_modules/${theme.packageName}`;
    const expected = lockedBuiltinTheme(theme);
    const current = lockedPackages[path];
    if (current !== undefined && !lockedThemeMatches(current, expected)) {
      throw new Error(`The pinned Quartz dependency ${theme.packageName} changed unexpectedly.`);
    }
    dependencies[theme.packageName] = theme.version;
    lockedRootDependencies[theme.packageName] = theme.version;
    lockedPackages[path] = expected;
  }
  await Promise.all([
    writeFile(packageJsonPath, `${JSON.stringify(packageJson, undefined, 2)}\n`, { mode: 0o600 }),
    writeFile(packageLockPath, `${JSON.stringify(packageLock, undefined, 2)}\n`, { mode: 0o600 }),
  ]);
}

function assertCompatibleDependency(
  dependencies: Record<string, string>,
  theme: BuiltinThemeDefinition,
): void {
  const current = dependencies[theme.packageName];
  if (current !== undefined && current !== theme.version) {
    throw new Error(`The pinned Quartz dependency ${theme.packageName} changed unexpectedly.`);
  }
}

function lockedBuiltinTheme(theme: BuiltinThemeDefinition): {
  version: string;
  resolved: string;
  integrity: string;
  license: string;
} {
  return {
    version: theme.version,
    resolved: `https://registry.npmjs.org/${theme.packageName}/-/${theme.id}-${theme.version}.tgz`,
    integrity: theme.integrity,
    license: 'MIT',
  };
}

function lockedThemeMatches(
  actual: { version?: string; resolved?: string; integrity?: string; license?: string },
  expected: ReturnType<typeof lockedBuiltinTheme>,
): boolean {
  return actual.version === expected.version
    && actual.resolved === expected.resolved
    && actual.integrity === expected.integrity
    && actual.license === expected.license;
}

async function builtinThemeSourcesMatch(engineDirectory: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(engineDirectory, 'package.json'), 'utf8'),
    ) as QuartzPackageJson;
    const packageLock = JSON.parse(
      await readFile(join(engineDirectory, 'package-lock.json'), 'utf8'),
    ) as QuartzPackageLock;
    const dependencies = packageJson.dependencies;
    const lockedPackages = packageLock.packages;
    const lockedRootDependencies = lockedPackages?.['']?.dependencies;
    if (!dependencies || !lockedPackages || !lockedRootDependencies) return false;
    return BUILTIN_THEME_CATALOG.every((theme) =>
      dependencies[theme.packageName] === theme.version
      && lockedRootDependencies[theme.packageName] === theme.version
      && lockedThemeMatches(
        lockedPackages[`node_modules/${theme.packageName}`] ?? {},
        lockedBuiltinTheme(theme),
      ));
  } catch {
    return false;
  }
}

async function assertInstalledBuiltinThemes(engineDirectory: string): Promise<void> {
  if (!(await installedBuiltinThemesMatch(engineDirectory))) {
    throw new Error('The pinned Quartz built-in theme packages are missing or incompatible.');
  }
}

async function installedBuiltinThemesMatch(engineDirectory: string): Promise<boolean> {
  try {
    const installed = await Promise.all(BUILTIN_THEME_CATALOG.map(async (theme) => {
      const packageJson = JSON.parse(await readFile(join(
        engineDirectory,
        'node_modules',
        ...theme.packageName.split('/'),
        'package.json',
      ), 'utf8')) as { name?: string; version?: string };
      return packageJson.name === theme.packageName && packageJson.version === theme.version;
    }));
    return installed.every(Boolean);
  } catch {
    return false;
  }
}
