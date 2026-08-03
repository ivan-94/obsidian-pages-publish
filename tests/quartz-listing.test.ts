import { describe, expect, it } from 'vitest';
import {
  markdownRouteLink,
  quartzHomeEntries,
  quartzSectionListingMarkdown,
} from '../src/site-builder/quartz-listing';

describe('Quartz controlled listings', () => {
  it('orders public descendant articles by publication.order then date', () => {
    const listing = quartzSectionListingMarkdown([
      article('No explicit order', '/writing/no-order/', { date: '2026-08-03' }),
      article('Second', '/writing/second/', { order: 20, date: '2026-08-04' }),
      article('First', '/writing/first/', { order: 10, date: '2020-01-01' }),
      article('Nested', '/writing/guides/nested/', { order: 30 }),
      { ...article('Hidden', '/writing/hidden/', { order: 0 }), visibility: 'unlisted' },
      { ...article('Index', '/writing/guides/', { order: 1 }), kind: 'index' },
      article('Outside', '/other/outside/', { order: 1 }),
    ], '/writing/');

    expect(listing.split('\n')).toEqual([
      '- [First](/writing/first/)',
      '- [Second](/writing/second/)',
      '- [Nested](/writing/guides/nested/)',
      '- [No explicit order](/writing/no-order/)',
    ]);
  });

  it('escapes labels and route segments for safe generated Markdown', () => {
    expect(markdownRouteLink('A [label]', '/中文 空格/(draft)/')).toBe(
      '- [A \\[label\\]](/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/(draft)/)',
    );
  });

  it('maps latest and sections home layouts without exposing unlisted or index pages', () => {
    const articles = [
      article('Older', '/writing/older/', { date: '2025-01-01' }),
      article('Newer', '/writing/blog/newer/', { date: '2026-01-01' }),
      { ...article('Guides Home', '/writing/guides/'), kind: 'index' as const },
      { ...article('Hidden', '/writing/hidden/'), visibility: 'unlisted' as const },
    ];
    const sections = [
      { directoryPath: 'Notes', url: '/writing/' },
      {
        directoryPath: 'Notes/guides',
        url: '/writing/guides/',
        sourcePath: 'Guides Home.md',
      },
      { directoryPath: 'Notes/blog', url: '/writing/blog/' },
      { directoryPath: 'Notes/empty', url: '/writing/empty/' },
    ];

    expect(quartzHomeEntries('latest', [{ path: 'Notes' }], sections, articles)).toEqual([
      { title: 'Newer', url: '/writing/blog/newer/' },
      { title: 'Older', url: '/writing/older/' },
    ]);
    expect(quartzHomeEntries('sections', [{ path: 'Notes' }], sections, articles)).toEqual([
      { title: 'blog', url: '/writing/blog/' },
      { title: 'Guides Home', url: '/writing/guides/' },
    ]);

    const hiddenIndexArticles = articles.map((entry) =>
      entry.title === 'Guides Home' ? { ...entry, visibility: 'unlisted' as const } : entry);
    expect(quartzHomeEntries(
      'sections',
      [{ path: 'Notes' }],
      sections,
      hiddenIndexArticles,
    )).toEqual([{ title: 'blog', url: '/writing/blog/' }]);
  });
});

function article(
  title: string,
  url: string,
  values: { date?: string; order?: number } = {},
) {
  return {
    sourcePath: `${title}.md`,
    title,
    url,
    visibility: 'public' as const,
    kind: 'article' as const,
    ...values,
  };
}
