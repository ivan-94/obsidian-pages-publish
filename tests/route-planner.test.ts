import { describe, expect, it } from 'vitest';
import type { SiteConfigV1 } from '../src/config/site-config';
import { planSiteRoutes } from '../src/routing/route-planner';

function siteConfig(): SiteConfigV1 {
  return {
    version: 1,
    site: { name: 'Pages', homeLayout: 'sections' },
    contentRoots: [{ path: 'notes', publicRoot: '/articles' }],
    assets: { exclude: [] },
    features: { search: false, graph: false },
    cloudflare: { projectName: 'pages' },
  };
}

describe('route planner', () => {
  it('derives one deterministic article URL from its public root, relative directory, and slug', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guides/hello.md',
        visibility: 'public',
        slug: 'hello-world',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles).toEqual([
      {
        sourcePath: 'notes/guides/hello.md',
        url: '/articles/guides/hello-world/',
        onlineUrl: undefined,
        redirects: [],
      },
    ]);
    expect(plan.issues).toEqual([]);
  });

  it('preserves Unicode slugs without transliteration', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/随笔/你好.md',
        visibility: 'unlisted',
        slug: '你好-🌏',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles[0]?.url).toBe('/articles/随笔/你好-🌏/');
    expect(plan.issues).toEqual([]);
  });

  it.each([
    'nested/slug',
    '.',
    '..',
    'a..b',
    'query?value',
    'fragment#value',
    String.raw`back\slash`,
    '%2Fescaped',
    '%2E',
    '%2e%2e',
    '%25',
    '%252F',
    'line\nbreak',
  ])('blocks a slug that can control URL semantics: %j', (slug) => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/unsafe.md',
        visibility: 'public',
        slug,
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles).toEqual([]);
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        code: 'invalid-slug',
        sourcePath: 'notes/unsafe.md',
      }),
    ]);
  });

  it('reports locatable blockers for article, system-page, and redirect route conflicts', () => {
    const config = siteConfig();
    config.contentRoots[0]!.publicRoot = '/';
    const plan = planSiteRoutes(config, [
      {
        sourcePath: 'notes/one.md',
        visibility: 'public',
        slug: 'same',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/two.md',
        visibility: 'public',
        slug: 'same',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/not-found.md',
        visibility: 'public',
        slug: '404',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/redirect-owner.md',
        visibility: 'public',
        slug: 'new',
        kind: 'article',
        redirects: ['/same/'],
      },
    ]);

    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'route-conflict',
          route: '/same/',
          relatedSourcePaths: ['notes/one.md', 'notes/two.md'],
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'system-route-conflict',
          route: '/404/',
          sourcePath: 'notes/not-found.md',
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'redirect-route-conflict',
          route: '/same/',
          sourcePath: 'notes/redirect-owner.md',
        }),
      ]),
    );
  });

  it('reserves the sitemap file route against article, section, and redirect output', () => {
    const config = siteConfig();
    config.contentRoots[0]!.publicRoot = '/';
    const plan = planSiteRoutes(config, [
      {
        sourcePath: 'notes/sitemap-article.md',
        visibility: 'public',
        slug: 'sitemap.xml',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/sitemap.xml/_index.md',
        visibility: 'public',
        slug: '_index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/redirect-owner.md',
        visibility: 'public',
        slug: 'new',
        kind: 'article',
        redirects: ['/sitemap.xml'],
      },
    ]);

    expect(plan.systemRoutes).toContain('/sitemap.xml');
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'system-route-conflict',
          route: '/sitemap.xml/',
          sourcePath: 'notes/sitemap-article.md',
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'section-system-route-conflict',
          route: '/sitemap.xml/',
          directoryPath: 'notes/sitemap.xml',
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'redirect-route-conflict',
          route: '/sitemap.xml/',
          sourcePath: 'notes/redirect-owner.md',
        }),
      ]),
    );
  });

  it('uses _index.md as the sole directory index when index.md also exists', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guides/_index.md',
        visibility: 'public',
        slug: '_index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/index.md',
        visibility: 'public',
        slug: 'index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/start.md',
        visibility: 'public',
        slug: 'start',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles.map((article) => article.sourcePath)).toEqual([
      'notes/guides/_index.md',
      'notes/guides/start.md',
    ]);
    expect(plan.articles[0]?.url).toBe('/articles/guides/');
    expect(plan.sections).toContainEqual({
      directoryPath: 'notes/guides',
      url: '/articles/guides/',
      sourcePath: 'notes/guides/_index.md',
      generated: false,
    });
    expect(plan.issues).toEqual([]);
  });

  it('blocks ambiguous custom index declarations while keeping the documented filename pair quiet', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guides/_index.md',
        visibility: 'public',
        slug: '_index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/index.md',
        visibility: 'public',
        slug: 'index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/custom.md',
        visibility: 'public',
        slug: 'custom',
        kind: 'index',
        redirects: [],
      },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'multiple-directory-indexes',
        directoryPath: 'notes/guides',
        relatedSourcePaths: [
          'notes/guides/_index.md',
          'notes/guides/custom.md',
          'notes/guides/index.md',
        ],
      }),
    );
  });

  it('normalizes, deduplicates, and flattens redirects to the current page', () => {
    const plan = planSiteRoutes(
      siteConfig(),
      [
        {
          sourcePath: 'notes/new.md',
          visibility: 'public',
          slug: 'new',
          kind: 'article',
          redirects: ['/articles/old', '/articles/old/'],
        },
      ],
      {
        historicalRedirects: [{ from: '/oldest/', to: '/articles/old/' }],
      },
    );

    expect(plan.redirects).toEqual([
      { from: '/articles/old/', to: '/articles/new/' },
      { from: '/oldest/', to: '/articles/new/' },
    ]);
    expect(plan.issues).toEqual([]);
  });

  it('blocks redirect cycles and redirects whose final target is missing', () => {
    const plan = planSiteRoutes(siteConfig(), [], {
      historicalRedirects: [
        { from: '/a/', to: '/b/' },
        { from: '/b/', to: '/a/' },
        { from: '/lost/', to: '/missing/' },
      ],
    });

    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'redirect-cycle',
          route: '/a/',
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'redirect-target-missing',
          route: '/lost/',
        }),
      ]),
    );
  });

  it('warns instead of guessing when a direct Frontmatter slug edit loses a known online URL', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guide.md',
        visibility: 'public',
        slug: 'new',
        kind: 'article',
        redirects: [],
        onlineUrl: '/articles/old/',
      },
    ]);

    expect(plan.redirects).toEqual([]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'untracked-online-url',
        sourcePath: 'notes/guide.md',
        route: '/articles/old/',
      }),
    );
  });

  it('generates ancestor sections and blocks an article that occupies a section route', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guides.md',
        visibility: 'public',
        slug: 'guides',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/deep/start.md',
        visibility: 'public',
        slug: 'start',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.sections.map((section) => section.url)).toEqual([
      '/articles/',
      '/articles/guides/',
      '/articles/guides/deep/',
    ]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'section-route-conflict',
        route: '/articles/guides/',
        sourcePath: 'notes/guides.md',
        directoryPath: 'notes/guides',
      }),
    );
  });

  it('detects canonically equivalent Unicode and percent-encoded article routes', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/one.md',
        visibility: 'public',
        slug: 'café',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/two.md',
        visibility: 'public',
        slug: 'cafe\u0301',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'notes/three.md',
        visibility: 'public',
        slug: 'caf%C3%A9',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'route-conflict',
        route: '/articles/café/',
        relatedSourcePaths: [
          'notes/one.md',
          'notes/three.md',
          'notes/two.md',
        ],
      }),
    );
  });

  it('blocks unsafe derived directory routes and historical redirects that occupy pages', () => {
    const plan = planSiteRoutes(
      siteConfig(),
      [
        {
          sourcePath: 'notes/query?control/article.md',
          visibility: 'public',
          slug: 'article',
          kind: 'article',
          redirects: [],
        },
        {
          sourcePath: 'notes/live.md',
          visibility: 'public',
          slug: 'live',
          kind: 'article',
          redirects: [],
        },
      ],
      { historicalRedirects: [{ from: '/articles/live/', to: '/articles/' }] },
    );

    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocker',
          code: 'invalid-route-directory',
          sourcePath: 'notes/query?control/article.md',
        }),
        expect.objectContaining({
          severity: 'blocker',
          code: 'redirect-route-conflict',
          route: '/articles/live/',
        }),
      ]),
    );
  });

  it('canonicalizes a public root before checking section and system routes', () => {
    const config = siteConfig();
    config.contentRoots[0]!.publicRoot = '/se%61rch';
    config.features.search = true;
    const plan = planSiteRoutes(config, [
      {
        sourcePath: 'notes/article.md',
        visibility: 'public',
        slug: 'article',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.sections[0]?.url).toBe('/search/');
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'section-system-route-conflict',
        route: '/search/',
      }),
    );
  });

  it('blocks a public root with residual percent encoding after one decode', () => {
    const config = siteConfig();
    config.contentRoots[0]!.publicRoot = '/articles/%25';
    const plan = planSiteRoutes(config, [
      {
        sourcePath: 'notes/article.md',
        visibility: 'public',
        slug: 'article',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles).toEqual([]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'invalid-public-root',
        route: '/articles/%25',
      }),
    );
  });

  it('blocks two configured roots that generate the same section route', () => {
    const config = siteConfig();
    config.contentRoots = [
      { path: 'one', publicRoot: '/articles' },
      { path: 'two', publicRoot: '/articles/foo' },
    ];
    const plan = planSiteRoutes(config, [
      {
        sourcePath: 'one/foo/deep.md',
        visibility: 'public',
        slug: 'deep',
        kind: 'article',
        redirects: [],
      },
      {
        sourcePath: 'two/article.md',
        visibility: 'public',
        slug: 'article',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'section-route-conflict',
        route: '/articles/foo/',
        relatedDirectoryPaths: ['one/foo', 'two'],
      }),
    );
  });

  it('locates a redirect that conflicts with a generated section at its owning article', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/owner.md',
        visibility: 'public',
        slug: 'owner',
        kind: 'article',
        redirects: ['/articles/guides/'],
      },
      {
        sourcePath: 'notes/guides/start.md',
        visibility: 'public',
        slug: 'start',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'redirect-route-conflict',
        route: '/articles/guides/',
        sourcePath: 'notes/owner.md',
      }),
    );
  });

  it('locates competing redirect targets at every owning article', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/one.md',
        visibility: 'public',
        slug: 'one',
        kind: 'article',
        redirects: ['/legacy/'],
      },
      {
        sourcePath: 'notes/two.md',
        visibility: 'public',
        slug: 'two',
        kind: 'article',
        redirects: ['/legacy/'],
      },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'redirect-conflict',
        route: '/legacy/',
        relatedSourcePaths: ['notes/one.md', 'notes/two.md'],
      }),
    );
  });

  it('does not generate discoverable sections from unlisted-only content', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/秘密/hidden.md',
        visibility: 'unlisted',
        slug: 'hidden',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.articles[0]?.url).toBe('/articles/秘密/hidden/');
    expect(plan.sections).toEqual([]);
  });

  it('uses an unlisted directory index for a section discovered by public content', () => {
    const plan = planSiteRoutes(siteConfig(), [
      {
        sourcePath: 'notes/guides/_index.md',
        visibility: 'unlisted',
        slug: '_index',
        kind: 'index',
        redirects: [],
      },
      {
        sourcePath: 'notes/guides/start.md',
        visibility: 'public',
        slug: 'start',
        kind: 'article',
        redirects: [],
      },
    ]);

    expect(plan.sections).toContainEqual({
      directoryPath: 'notes/guides',
      url: '/articles/guides/',
      sourcePath: 'notes/guides/_index.md',
      generated: false,
    });
    expect(plan.issues).not.toContainEqual(
      expect.objectContaining({
        severity: 'blocker',
        code: 'section-route-conflict',
        route: '/articles/guides/',
      }),
    );
  });
});
