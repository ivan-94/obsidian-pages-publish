import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workspace = new URL('..', import.meta.url);

describe('global UI responsive and accessibility smoke', () => {
  it('keeps narrow publish-center rows labelled and global interaction focus-visible', async () => {
    const [styles, view] = await Promise.all([
      readFile(new URL('styles.css', workspace), 'utf8'),
      readFile(new URL('src/plugin/view.ts', workspace), 'utf8'),
    ]);

    expect(styles).toContain('.pages-publish-view :focus-visible');
    expect(styles).toContain('@container (max-width: 640px)');
    expect(styles).toContain('content: attr(data-label)');
    expect(styles).toContain('.pages-publish-view__actions');
    expect(view).toContain("'data-label': '下一版包含'");
    expect(view).toContain("'data-label': '文章 / 路径'");
  });
});
