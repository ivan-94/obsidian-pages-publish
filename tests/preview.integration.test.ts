import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';

describe('local site preview', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('prepares one public note from a real vault as previewable site files', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: LLM Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: llm-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(vault, 'notes', 'hello.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '---',
        '# Hello Pages',
        '',
        'This came from a real vault.',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await prepareLocalPreviewFromDirectory(vault);

    expect(preview.siteName).toBe('LLM Wiki');
    expect(preview.pages).toEqual([
      {
        sourcePath: 'notes/hello.md',
        title: 'Hello Pages',
        url: '/notes/hello/',
      },
    ]);
    expect(preview.files['/index.html']).toContain(
      '<a href="/notes/hello/">Hello Pages</a>',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      '<h1>Hello Pages</h1>',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      'This came from a real vault.',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      'data-pages-preview="local"',
    );
    expect(preview.files['/notes/hello/index.html']).toContain(
      '本地预览 · 尚未发布',
    );
  });

  it('rejects a site config that omits required product schema fields', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-vault-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Incomplete site',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(prepareLocalPreviewFromDirectory(vault)).rejects.toThrow(
      'Invalid Pages Publish site configuration.',
    );
  });
});
