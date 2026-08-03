import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileQuartzStaging } from '../src/site-builder/quartz-staging-compiler';
import { validPng } from './image-fixtures';

describe('Quartz immutable staging compiler', () => {
  it('exposes only selected content with controlled frontmatter and exact routes', async () => {
    const vaultRoot = await fixtureVault();

    const staging = await compileQuartzStaging(vaultRoot);

    expect(Object.keys(staging.contentFiles)).toEqual([
      'writing/hello.md',
      'writing/hidden.md',
    ]);
    expect(staging.contentFiles['writing/hello.md']).toContain('permalink: /writing/hello/');
    expect(staging.contentFiles['writing/hello.md']).toContain('title: Public title');
    expect(staging.contentFiles['writing/hello.md']).not.toContain('secret_user_field');
    expect(staging.contentFiles['writing/hello.md']).toContain('[Direct](/writing/hidden/)');
    expect(staging.contentFiles['writing/hello.md']).not.toContain('[[Private');
    expect(staging.contentFiles['writing/hidden.md']).toContain('unlisted: true');
    expect(JSON.stringify(staging)).not.toContain('Private secret');
    expect(JSON.stringify(staging)).not.toContain('private-body-token');
    expect(staging.routeManifest.articles).toEqual([
      expect.objectContaining({
        sourcePath: 'Notes/Public.md',
        title: 'Public title',
        url: '/writing/hello/',
        visibility: 'public',
        kind: 'article',
      }),
      expect.objectContaining({
        sourcePath: 'Notes/Unlisted.md',
        title: 'Unlisted title',
        url: '/writing/hidden/',
        visibility: 'unlisted',
        kind: 'article',
      }),
    ]);
    expect(Object.isFrozen(staging)).toBe(true);
  });

  it('does not copy unrelated Vault files into staging', async () => {
    const vaultRoot = await fixtureVault();
    await writeFile(join(vaultRoot, 'passwords.txt'), 'vault-only-token');

    const staging = await compileQuartzStaging(vaultRoot);

    expect(JSON.stringify(staging)).not.toContain('vault-only-token');
    expect(Object.keys(staging.assetFiles)).toEqual([]);
  });

  it('sanitizes comments and HTML, expands only discoverable embeds, and emits safe Mermaid assets', async () => {
    const vaultRoot = await fixtureVault();
    await writeFile(
      join(vaultRoot, 'Notes', 'Embedded.md'),
      [
        '---',
        'publication:',
        '  visibility: public',
        '  title: Public embedded title',
        '  slug: embedded',
        '---',
        'public-embedded-body-token',
        '',
      ].join('\n'),
    );
    const publicPath = join(vaultRoot, 'Notes', 'Public.md');
    await writeFile(
      publicPath,
      `${await readFile(publicPath, 'utf8')}\n%%comment-canary%%\n<iframe src="https://attacker.invalid">raw-active-token</iframe>\n![[Embedded]]\n![[Unlisted]]\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n`,
    );

    const staging = await compileQuartzStaging(vaultRoot);
    const publicSource = staging.contentFiles['writing/hello.md'] ?? '';

    expect(publicSource).not.toContain('comment-canary');
    expect(publicSource).not.toContain('<iframe');
    expect(publicSource).toContain('public-embedded-body-token');
    expect(publicSource).not.toContain('Direct-link content.');
    expect(publicSource).toContain('![Mermaid diagram](/assets/pages-publish/mermaid-');
    expect(Object.entries(staging.assetFiles)).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/^assets\/pages-publish\/mermaid-[a-f0-9]{64}\.svg$/u),
        expect.objectContaining({ contentType: 'image/svg+xml' }),
      ]),
    ]);
  });

  it('stages the focused private article as local-only unlisted without exposing it from public notes', async () => {
    const vaultRoot = await fixtureVault();

    const staging = await compileQuartzStaging(vaultRoot, {
      previewSourcePath: 'Notes/Private.md',
    });

    expect(staging.contentFiles['writing/private-secret.md']).toContain('unlisted: true');
    expect(staging.contentFiles['writing/private-secret.md']).toContain('private-body-token');
    expect(staging.contentFiles['writing/hello.md']).not.toContain('/writing/private-secret/');
    expect(staging.routeManifest.articles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: 'Notes/Private.md',
        title: 'Private secret',
        url: '/writing/private-secret/',
        visibility: 'unlisted',
        kind: 'article',
      }),
    ]));
  });

  it('maps publication.cover only to a verified hashed staging asset', async () => {
    const vaultRoot = await fixtureVault();
    await mkdir(join(vaultRoot, 'assets'), { recursive: true });
    await writeFile(
      join(vaultRoot, 'assets', 'cover.png'),
      validPng,
    );
    const publicPath = join(vaultRoot, 'Notes', 'Public.md');
    await writeFile(
      publicPath,
      (await readFile(publicPath, 'utf8')).replace(
        '  slug: hello',
        '  slug: hello\n  cover: assets/cover.png',
      ),
    );

    const staging = await compileQuartzStaging(vaultRoot);
    const [assetPath] = Object.keys(staging.assetFiles);

    expect(assetPath).toMatch(/^assets\/[a-f0-9]{64}\.png$/u);
    expect(staging.contentFiles['writing/hello.md']).toContain(
      `cover: /${assetPath}`,
    );
    expect(JSON.stringify(staging.contentFiles)).not.toContain('assets/cover.png');
  });

  it('appends one route-manifest-controlled descendant listing to a custom index', async () => {
    const vaultRoot = await fixtureVault();
    await mkdir(join(vaultRoot, 'Notes', 'Guides'), { recursive: true });
    await writeFile(
      join(vaultRoot, 'Notes', 'Guides', '_index.md'),
      '---\npublication:\n  visibility: public\n  title: Guides\n---\n# Guide intro',
    );
    await writeFile(
      join(vaultRoot, 'Notes', 'Guides', 'second.md'),
      '---\npublication:\n  visibility: public\n  title: Second\n  order: 20\n---\nSecond',
    );
    await writeFile(
      join(vaultRoot, 'Notes', 'Guides', 'first.md'),
      '---\npublication:\n  visibility: public\n  title: First\n  order: 10\n---\nFirst',
    );
    await writeFile(
      join(vaultRoot, 'Notes', 'Guides', 'latest.md'),
      '---\npublication:\n  visibility: public\n  title: Latest\n  date: 2026-08-03\n---\nLatest',
    );
    await writeFile(
      join(vaultRoot, 'Notes', 'Guides', 'hidden.md'),
      '---\npublication:\n  visibility: unlisted\n  title: Hidden\n  order: 1\n---\nHidden',
    );

    const staging = await compileQuartzStaging(vaultRoot);
    const index = staging.contentFiles['writing/Guides/index.md'] ?? '';

    expect(index).toContain('# Guide intro');
    expect(index).not.toContain('Hidden');
    expect(index.indexOf('[First]')).toBeLessThan(index.indexOf('[Second]'));
    expect(index.indexOf('[Second]')).toBeLessThan(index.indexOf('[Latest]'));
  });
});

async function fixtureVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-quartz-staging-'));
  await mkdir(join(vaultRoot, '.publish'), { recursive: true });
  await mkdir(join(vaultRoot, 'Notes'), { recursive: true });
  await writeFile(
    join(vaultRoot, '.publish', 'site.yml'),
    [
      'version: 1',
      'site:',
      '  name: Staging Site',
      '  home_layout: latest',
      'content_roots:',
      '  - path: Notes',
      '    public_root: /writing',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: staging-site',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(vaultRoot, 'Notes', 'Public.md'),
    [
      '---',
      'secret_user_field: must-not-stage',
      'publication:',
      '  visibility: public',
      '  title: Public title',
      '  slug: hello',
      '  tags: [one, two]',
      '  deployment:',
      '    deployment_id: must-not-stage',
      '---',
      '# Public body',
      '',
      'Safe text.',
      '[[Unlisted|Direct]] and [[Private|No route]].',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(vaultRoot, 'Notes', 'Unlisted.md'),
    [
      '---',
      'publication:',
      '  visibility: unlisted',
      '  title: Unlisted title',
      '  slug: hidden',
      '---',
      'Direct-link content.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(vaultRoot, 'Notes', 'Private.md'),
    [
      '---',
      'publication:',
      '  visibility: private',
      '  title: Private secret',
      '  slug: private-secret',
      '---',
      'private-body-token',
      '',
    ].join('\n'),
  );
  return vaultRoot;
}
