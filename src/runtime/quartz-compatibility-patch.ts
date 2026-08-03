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

export async function applyQuartzEngineCompatibilityPatch(
  engineDirectory: string,
): Promise<void> {
  const handlersPath = join(engineDirectory, 'quartz', 'cli', 'handlers.js');
  const source = await readFile(handlersPath, 'utf8');
  if (
    source.includes(marker)
    && source.includes(cacheImportPatch)
    && source.includes(serveCallPatch)
    && !source.includes(serveImportNeedle)
  ) return;
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
