import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';

describe('site content scanner', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('warns when the whole vault is selected as a content root', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Whole Vault',
        '  home_layout: sections',
        'content_roots:',
        '  - path: .',
        '    public_root: /',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: whole-vault',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(vault, 'hello.md'), '# Hello\n', 'utf8');

    const result = await scanSiteFromDirectory(vault);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'vault-root-exposure',
        path: 'content_roots[0].path',
      }),
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourcePath: 'hello.md' }),
    ]);
  });

  it('blocks publishing when an entire configured content root is missing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Synced Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: synced-notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: synced-wiki',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await scanSiteFromDirectory(vault);

    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        code: 'content-root-missing',
        path: 'content_roots[0].path',
      }),
    ]);
  });

  it('produces a deterministic content digest without network, writes, or scope leakage', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Scoped Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: scoped-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const insidePath = join(vault, 'notes', 'inside.md');
    const outsidePath = join(vault, 'outside-secret.md');
    await writeFile(insidePath, '# Inside\n', 'utf8');
    await writeFile(outsidePath, '# Never leak this title\n', 'utf8');
    const fetchBoundary = vi.fn();
    vi.stubGlobal('fetch', fetchBoundary);

    const first = await scanSiteFromDirectory(vault);
    const second = await scanSiteFromDirectory(vault);

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('outside-secret');
    expect(JSON.stringify(first)).not.toContain('Never leak this title');
    expect(fetchBoundary).not.toHaveBeenCalled();
    await expect(readFile(insidePath, 'utf8')).resolves.toBe('# Inside\n');
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
      '# Never leak this title\n',
    );
  });

  it('honors an already-aborted scan signal', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanSiteFromDirectory(vault, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('turns an unreadable content root into a publishing blocker', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Unreadable Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'features:',
        '  search: true',
        '  graph: true',
        'cloudflare:',
        '  project_name: unreadable-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const unreadable = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });

    const result = await scanSiteFromDirectory(vault, {
      fileSystem: {
        readDirectory: async () => Promise.reject(unreadable),
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        code: 'content-root-unreadable',
        path: 'content_roots[0].path',
      }),
    ]);
  });

  it('surfaces route conflicts as locatable publishing blockers', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-scan-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(
      join(vault, '.publish', 'site.yml'),
      [
        'version: 1',
        'site:',
        '  name: Conflicting Wiki',
        '  home_layout: sections',
        'content_roots:',
        '  - path: notes',
        '    public_root: /notes',
        'assets:',
        '  exclude: []',
        'features:',
        '  search: false',
        '  graph: false',
        'cloudflare:',
        '  project_name: conflicting-wiki',
        '',
      ].join('\n'),
      'utf8',
    );
    const source =
      '---\npublication:\n  visibility: public\n  slug: same\n---\n# Page\n';
    await writeFile(join(vault, 'notes', 'one.md'), source, 'utf8');
    await writeFile(join(vault, 'notes', 'two.md'), source, 'utf8');

    const result = await scanSiteFromDirectory(vault);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'route-conflict',
        path: 'notes/one.md',
      }),
    );
    expect(result.routePlan?.articles).toHaveLength(2);
  });
});
