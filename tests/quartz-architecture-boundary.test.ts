import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '..', 'src');

describe('Quartz architecture boundary', () => {
  it('keeps Quartz types and modules below the upper application and deployment layers', async () => {
    const upperFiles = [
      join(sourceRoot, 'application.ts'),
      ...await typescriptFiles(join(sourceRoot, 'core')),
      ...await typescriptFiles(join(sourceRoot, 'publication')),
      ...await typescriptFiles(join(sourceRoot, 'cloudflare')),
    ];

    for (const path of upperFiles) {
      const source = await readFile(path, 'utf8');
      const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
        .map((match) => match[1] ?? '');
      expect(imports, path).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)quartz|@quartz/iu),
      ]));
    }
  });

  it('does not retain the legacy renderer or theme in production source', async () => {
    const productionFiles = await typescriptFiles(sourceRoot);

    for (const path of productionFiles) {
      const source = await readFile(path, 'utf8');
      expect(source, path).not.toMatch(/legacy-(?:preview|default-theme)/u);
    }
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(path));
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}
