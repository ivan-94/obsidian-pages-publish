import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { prepareLocalPreviewFromDirectory } from '../src/core/preview';

describe('release candidate large Vault smoke', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('scans and builds a large mixed-visibility Vault without leaking private content', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-release-benchmark-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), siteConfig(), 'utf8');
    await Promise.all([
      ...Array.from({ length: 300 }, (_, index) =>
        writeArticle(vault, index, 'public'),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        writeArticle(vault, index + 300, 'unlisted'),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        writeArticle(vault, index + 330, 'private'),
      ),
    ]);

    const heapBefore = process.memoryUsage().heapUsed;
    const scanStarted = performance.now();
    const scan = await scanSiteFromDirectory(vault);
    const scanDurationMs = performance.now() - scanStarted;
    const previewStarted = performance.now();
    const preview = await prepareLocalPreviewFromDirectory(vault);
    const previewDurationMs = performance.now() - previewStarted;
    const heapDeltaMiB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    expect(scan.candidates).toHaveLength(360);
    expect(scan.issues.filter((issue) => issue.severity === 'blocker')).toEqual([]);
    expect(preview.articles.filter((article) => article.visibility === 'public')).toHaveLength(300);
    expect(preview.articles.filter((article) => article.visibility === 'unlisted')).toHaveLength(30);
    expect(preview.articles.filter((article) => article.visibility === 'private')).toHaveLength(30);
    expect(JSON.stringify(preview.files)).not.toContain('PRIVATE RELEASE SECRET');
    process.stdout.write(
      `release-baseline candidates=360 scan_ms=${Math.round(scanDurationMs)} preview_ms=${Math.round(previewDurationMs)} heap_delta_mib=${heapDeltaMiB.toFixed(1)}\n`,
    );
  }, 30_000);
});

async function writeArticle(
  vault: string,
  index: number,
  visibility: 'public' | 'unlisted' | 'private',
): Promise<void> {
  const privateBody = visibility === 'private' ? '\nPRIVATE RELEASE SECRET' : '';
  await writeFile(
    join(vault, 'notes', `article-${index}.md`),
    `---\npublication:\n  visibility: ${visibility}\n---\n# ${visibility} Article ${index}\n\nRelease benchmark content.${privateBody}\n`,
    'utf8',
  );
}

function siteConfig(): string {
  return [
    'version: 1',
    'site:',
    '  name: Release baseline',
    '  home_layout: sections',
    'content_roots:',
    '  - path: notes',
    '    public_root: /notes',
    'assets:',
    '  exclude: []',
    'features:',
    '  search: true',
    '  graph: true',
    'cloudflare:',
    '  project_name: release-baseline',
    '',
  ].join('\n');
}
