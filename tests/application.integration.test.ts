import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PagesPublishApplication } from '../src/application';

describe('Pages Publish application', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('routes an unconfigured vault to setup and a configured vault to publish center', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
    vaults.push(vault);
    const application = new PagesPublishApplication(vault);

    await expect(application.getLaunchTarget()).resolves.toBe('setup');

    await mkdir(join(vault, '.publish'), { recursive: true });
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

    await expect(application.getLaunchTarget()).resolves.toBe('publish-center');
  });

  it('opens a real local preview through the external browser boundary', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-app-'));
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
      ].join('\n'),
      'utf8',
    );
    const openedUrls: string[] = [];
    const application = new PagesPublishApplication(vault, (url) => {
      openedUrls.push(url);
    });

    const session = await application.openPreview();

    expect(openedUrls).toEqual([session.url]);
    const article = await fetch(`${session.url}notes/hello/`);
    expect(await article.text()).toContain('<h1>Hello Pages</h1>');
    await application.shutdown();
  });
});
