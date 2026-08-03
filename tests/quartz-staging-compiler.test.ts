import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileQuartzStaging } from '../src/site-builder/quartz-staging-compiler';

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
      { sourcePath: 'Notes/Public.md', url: '/writing/hello/', visibility: 'public' },
      { sourcePath: 'Notes/Unlisted.md', url: '/writing/hidden/', visibility: 'unlisted' },
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
