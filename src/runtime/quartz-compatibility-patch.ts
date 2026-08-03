import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  if (handlersPatched && globPatched) return;

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
  if (source.includes(folderListPatch) && !source.includes(folderListNeedle)) return;
  if (source.split(folderListNeedle).length - 1 !== 1 || source.includes(folderListPatch)) {
    throw new Error('The pinned Quartz folder-page patch no longer matches installed source.');
  }
  await writeFile(entryPath, source.replace(folderListNeedle, folderListPatch), { mode: 0o600 });
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
    return handlers.includes(marker)
      && handlers.includes(cacheImportPatch)
      && handlers.includes(serveCallPatch)
      && !handlers.includes(serveImportNeedle)
      && globSource.includes(gitignorePatch)
      && !globSource.includes(gitignoreNeedle)
      && folderPage.includes(folderListPatch)
      && !folderPage.includes(folderListNeedle);
  } catch {
    return false;
  }
}
