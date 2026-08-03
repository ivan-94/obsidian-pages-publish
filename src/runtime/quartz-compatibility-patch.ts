import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const marker = 'loadPaths: [path.join(process.cwd(), "node_modules")]';
const cacheImportNeedle = 'await import(`../../${cacheFile}?update=${randomUUID()}`)';
const cacheImportPatch = 'await import(`${path.resolve(cacheFile)}?update=${randomUUID()}`)';

export async function applyQuartzEngineCompatibilityPatch(
  engineDirectory: string,
): Promise<void> {
  const handlersPath = join(engineDirectory, 'quartz', 'cli', 'handlers.js');
  const source = await readFile(handlersPath, 'utf8');
  if (source.includes(marker) && source.includes(cacheImportPatch)) return;
  const needle = 'cssImports: true,';
  const matches = source.split(needle).length - 1;
  if (matches !== 2 || !source.includes(cacheImportNeedle)) {
    throw new Error('The pinned Quartz compatibility patch no longer matches upstream source.');
  }
  const patched = source
    .replaceAll(needle, `${needle}\n        ${marker},`)
    .replace(cacheImportNeedle, cacheImportPatch);
  await writeFile(handlersPath, patched, { mode: 0o600 });
}
