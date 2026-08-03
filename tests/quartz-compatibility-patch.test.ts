import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyQuartzEngineCompatibilityPatch } from '../src/runtime/quartz-compatibility-patch';

describe('Quartz engine compatibility patch', () => {
  it('confines both Sass resolvers to the controlled workspace node_modules', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-patch-'));
    await mkdir(join(directory, 'quartz', 'cli'), { recursive: true });
    await writeFile(
      join(directory, 'quartz', 'cli', 'handlers.js'),
      [
        'sassPlugin({',
        '  type: "css-text",',
        '  cssImports: true,',
        '}),',
        'const mod = await import(`../../${cacheFile}?update=${randomUUID()}`)',
        'sassPlugin({',
        '  filter: /x/,',
        '  type: "css",',
        '  cssImports: true,',
        '}),',
      ].join('\n'),
    );

    await applyQuartzEngineCompatibilityPatch(directory);

    const patched = await readFile(join(directory, 'quartz', 'cli', 'handlers.js'), 'utf8');
    expect(patched.match(/loadPaths:/gu)).toHaveLength(2);
    expect(patched).toContain('path.join(process.cwd(), "node_modules")');
    expect(patched).toContain('import(`${path.resolve(cacheFile)}?update=${randomUUID()}`)');
  });

  it('fails closed when the pinned upstream source shape changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pages-quartz-patch-reject-'));
    await mkdir(join(directory, 'quartz', 'cli'), { recursive: true });
    await writeFile(join(directory, 'quartz', 'cli', 'handlers.js'), 'changed upstream');

    await expect(applyQuartzEngineCompatibilityPatch(directory)).rejects.toThrow(
      'compatibility patch',
    );
  });
});
