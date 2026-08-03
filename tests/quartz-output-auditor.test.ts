import { describe, expect, it } from 'vitest';
import { bridgeAndAuditQuartzOutput } from '../src/site-builder/quartz-output-auditor';
import type { QuartzStagingCompilation } from '../src/site-builder/quartz-staging-compiler';

describe('Quartz output route bridge and auditor', () => {
  it('normalizes Quartz flat HTML into existing directory routes', () => {
    const output = bridgeAndAuditQuartzOutput(
      rawOutput({
        'writing/hello.html': [
          '<html><head><link rel="stylesheet" href="../index.css"/>',
          '<script>fetch("../static/contentIndex.json")</script></head>',
          '<body><nav><a href="../writing/hello">Writing</a></nav>',
          '<article><a href="/writing/hidden">Hidden</a>',
          '<code>fetch("../example.json")</code></article></body></html>',
        ].join(''),
        'writing/hidden.html': '<h1>Hidden</h1>',
        'index.css': 'body{}',
      }),
      staging(),
    );

    expect(output.files['/writing/hello/index.html']).toContain('/writing/hidden/');
    expect(output.files['/writing/hello/index.html']).toContain('href="/index.css"');
    expect(output.files['/writing/hello/index.html']).toContain(
      'fetch("/static/contentIndex.json")',
    );
    expect(output.files['/writing/hello/index.html']).toContain(
      '<code>fetch("../example.json")</code>',
    );
    expect(output.files['/writing/hello/index.html']).toContain('href="/writing/hello/"');
    expect(output.files['/writing/hidden/index.html']).toContain('Hidden');
    expect(output.files['/writing/hello/index.html']).toContain(
      '<link rel="canonical" href="https://example.com/writing/hello/"/>',
    );
    expect(output.files['/writing/hidden/index.html']).toContain(
      '<meta name="robots" content="noindex"/>',
    );
    expect(output.files['/privacy/index.html']).toBeDefined();
    expect(output.files['/404.html']).toBe(output.files['/404/index.html']);
    expect(output.files['/search/index.html']).toBeDefined();
    expect(output.files['/graph/index.html']).toBeDefined();
    expect(output.files['/tags/index.html']).toBeDefined();
    expect(output.assets['/static/icon.png']?.contentType).toBe('image/png');
  });

  it('removes an unlisted route from the Quartz search index', () => {
    const raw = rawOutput();
    raw.files['static/contentIndex.json'] = bytes(
      '{"writing/hidden":{"title":"Hidden"}}',
    );

    const output = bridgeAndAuditQuartzOutput(raw, staging());

    expect(output.files['/static/contentIndex.json']).toBe('{}');
  });

  it('allows an unlisted custom section index only at its own direct route', () => {
    const base = staging();
    const input: Readonly<QuartzStagingCompilation> = {
      ...base,
      routePlan: {
        ...base.routePlan,
        sections: [{
          directoryPath: 'Notes/Hidden',
          url: '/writing/hidden/',
          sourcePath: 'Notes/Hidden.md',
          generated: false,
        }],
      },
      routeManifest: {
        ...base.routeManifest,
        articles: base.routeManifest.articles.map((article) =>
          article.sourcePath === 'Notes/Hidden.md'
            ? { ...article, kind: 'index' as const }
            : article),
      },
    };

    const raw = rawOutput({
      'sitemap.xml': [
        '<urlset>',
        '<url><loc>https://example.com/writing/hidden/</loc></url>',
        '<url><loc>https://example.com/writing/hidden/child/</loc></url>',
        '</urlset>',
      ].join(''),
    });
    const output = bridgeAndAuditQuartzOutput(raw, input);

    expect(output.files['/sitemap.xml']).not.toContain('/writing/hidden/</loc>');
    expect(output.files['/sitemap.xml']).toContain('/writing/hidden/child/</loc>');
  });

  it('does not confuse an unlisted route with a longer public route prefix', () => {
    const raw = rawOutput({
      'index.html': '<aside data-route="writing/hidden-section/child">Public child</aside>',
    });

    expect(() => bridgeAndAuditQuartzOutput(raw, staging())).not.toThrow();
  });

  it('removes unlisted navigation while preserving explicit authored links', () => {
    const explorerLeak = rawOutput({
      'writing/hello.html': [
        '<article><a href="/writing/hidden/">Explicit link</a></article>',
        '<aside class="explorer"><a href="/writing/hidden/">Hidden</a></aside>',
      ].join(''),
    });
    const output = bridgeAndAuditQuartzOutput(explorerLeak, staging());

    expect(output.files['/writing/hello/index.html']).toContain('Explicit link');
    expect(output.files['/writing/hello/index.html']).not.toContain('>Hidden</a>');

    const clientDataLeak = rawOutput({
      'writing/hello.html': [
        '<article><a href="/writing/hidden/">Explicit link</a></article>',
        '<aside data-route="writing/hidden">Leaked client data</aside>',
      ].join(''),
    });
    expect(() => bridgeAndAuditQuartzOutput(clientDataLeak, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-discovery-leak' }),
    );
  });

  it('rejects ephemeral workspace and engine paths from text or binary output', () => {
    const textLeak = rawOutput({
      'index.html': '<html>/tmp/pages build/workspace/content</html>',
    });
    textLeak.forbiddenOutputText = ['/tmp/pages build/workspace'];
    expect(() => bridgeAndAuditQuartzOutput(textLeak, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-output-invalid' }),
    );

    const binaryLeak = rawOutput();
    binaryLeak.files['static/debug.bin'] = bytes('/tmp/pages%20build/workspace');
    binaryLeak.forbiddenOutputText = ['/tmp/pages build/workspace'];
    expect(() => bridgeAndAuditQuartzOutput(binaryLeak, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-output-invalid' }),
    );
  });

  it('rejects missing planned routes and remote executable resources', () => {
    const missing = rawOutput();
    delete missing.files['writing/hello.html'];
    expect(() => bridgeAndAuditQuartzOutput(missing, staging())).toThrow('planned route');

    const remote = rawOutput({
      'writing/hello.html': '<script src="https://tracker.example/a.js"></script>',
    });
    expect(() => bridgeAndAuditQuartzOutput(remote, staging())).toThrow('remote executable');
  });

  it('rejects broken same-origin links after route normalization', () => {
    const broken = rawOutput({
      'writing/hello.html': '<article><a href="/missing/">Missing</a></article>',
    });

    expect(() => bridgeAndAuditQuartzOutput(broken, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-route-mismatch' }),
    );
  });

  it('normalizes trailing slashes for Quartz-generated tag pages', () => {
    const raw = rawOutput({
      'tags/index.html': '<article><a href="/tags/smoke">Smoke</a></article>',
      'tags/smoke.html': '<article>Tagged pages</article>',
    });

    const output = bridgeAndAuditQuartzOutput(raw, staging());

    expect(output.files['/tags/index.html']).toContain('href="/tags/smoke/"');
    expect(output.files['/tags/smoke/index.html']).toBeDefined();
  });

  it('emits a bounded Cloudflare Pages permanent redirect manifest', () => {
    const base = staging();
    const withRedirects: Readonly<QuartzStagingCompilation> = {
      ...base,
      routePlan: {
        ...base.routePlan,
        redirects: [{ from: '/writing/旧 地址/', to: '/writing/hello/' }],
      },
      routeManifest: {
        ...base.routeManifest,
        redirects: [{ from: '/writing/旧 地址/', to: '/writing/hello/' }],
      },
    };

    const output = bridgeAndAuditQuartzOutput(rawOutput(), withRedirects);

    expect(output.files['/_redirects']).toBe(
      '/writing/%E6%97%A7%20%E5%9C%B0%E5%9D%80/ /writing/hello/ 301\n',
    );
    expect(output.files['/writing/旧 地址/index.html']).toContain('/writing/hello/');
  });

  it('rejects more redirects than Cloudflare Pages can apply', () => {
    const base = staging();
    const redirects = Array.from({ length: 2_001 }, (_, index) => ({
      from: `/old-${index}/`,
      to: '/writing/hello/',
    }));
    const input: Readonly<QuartzStagingCompilation> = {
      ...base,
      routePlan: { ...base.routePlan, redirects },
      routeManifest: { ...base.routeManifest, redirects },
    };

    expect(() => bridgeAndAuditQuartzOutput(rawOutput(), input)).toThrow(
      expect.objectContaining({ code: 'quartz-output-invalid' }),
    );
  });

  it('rejects remote runtime loads from emitted JS/CSS', () => {
    const remoteScript = rawOutput({
      'static/prescript.js': 'import("https://cdn.example/runtime.js")',
    });
    expect(() => bridgeAndAuditQuartzOutput(remoteScript, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-unexpected-network' }),
    );

    const remoteFont = rawOutput({
      'static/index.css': '@font-face{src:url(https://fonts.example/font.woff2)}',
    });
    expect(() => bridgeAndAuditQuartzOutput(remoteFont, staging())).toThrow(
      expect.objectContaining({ code: 'quartz-unexpected-network' }),
    );
  });

  it('removes metadata for the disabled Quartz OG image output', () => {
    const output = bridgeAndAuditQuartzOutput(rawOutput({
      'index.html': [
        '<html><head>',
        '<meta property="og:image" content="https://example.com/static/og-image.png"/>',
        '<meta name="twitter:image" content="https://example.com/static/og-image.png"/>',
        '</head><body>Home</body></html>',
      ].join(''),
    }), staging());

    expect(output.files['/index.html']).not.toContain('og-image.png');
  });

  it('rejects private canaries in either text or binary output', () => {
    const textLeak = rawOutput({ 'index.html': '<html>private-canary-0123456789</html>' });
    expect(() => bridgeAndAuditQuartzOutput(textLeak, staging(), {
      forbiddenText: ['private-canary-0123456789'],
    })).toThrow(expect.objectContaining({ code: 'quartz-private-leak' }));

    const binaryLeak = rawOutput();
    binaryLeak.files['static/leak.bin'] = bytes('private-canary-0123456789');
    expect(() => bridgeAndAuditQuartzOutput(binaryLeak, staging(), {
      forbiddenText: ['private-canary-0123456789'],
    })).toThrow(expect.objectContaining({ code: 'quartz-private-leak' }));
  });
});

function rawOutput(overrides: Record<string, string> = {}): {
  files: Record<string, Uint8Array>;
  sourceDigest: string;
  engineVersion: string;
  forbiddenOutputText?: readonly string[];
} {
  const textFiles: Record<string, string> = {
    'index.html': '<html>Home</html>',
    '404.html': '<html>404</html>',
    'privacy.html': '<html>Privacy</html>',
    'search.html': '<html>Search</html>',
    'graph.html': '<html>Graph</html>',
    'writing/hello.html': '<html>Hello</html>',
    'writing/hidden.html': '<html>Hidden</html>',
    'tags/index.html': '<html>Tags</html>',
    'sitemap.xml': '<url><loc>https://example.com/writing/hello</loc></url>',
    'index.xml': '<item>/writing/hello</item>',
    'static/contentIndex.json': '{"writing/hello":{"title":"Hello"}}',
    ...overrides,
  };
  const files: Record<string, Uint8Array> = {
      ...Object.fromEntries(Object.entries(textFiles).map(([path, value]) => [path, bytes(value)])),
      'static/icon.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
  return {
    files,
    sourceDigest: 'digest',
    engineVersion: 'pages-publish-quartz-5.0.0.1',
  };
}

function staging(): Readonly<QuartzStagingCompilation> {
  return {
    config: {
      version: 1,
      site: { name: 'Audit', homeLayout: 'latest' },
      contentRoots: [{ path: 'Notes', publicRoot: '/writing' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'audit', customDomain: 'example.com' },
    },
    contentFiles: {
      'writing/hello.md': '---\ntitle: Hello\n---\nHello',
      'writing/hidden.md': '---\ntitle: Hidden\nunlisted: true\n---\nHidden',
    },
    assetFiles: {},
    routePlan: {
      articles: [
        { sourcePath: 'Notes/Hello.md', url: '/writing/hello/', onlineUrl: undefined, redirects: [] },
        { sourcePath: 'Notes/Hidden.md', url: '/writing/hidden/', onlineUrl: undefined, redirects: [] },
      ],
      sections: [],
      systemRoutes: ['/', '/404/', '/privacy/', '/search/', '/graph/'],
      redirects: [],
      issues: [],
    },
    routeManifest: {
      articles: [
        {
          sourcePath: 'Notes/Hello.md',
          title: 'Hello',
          url: '/writing/hello/',
          visibility: 'public',
          kind: 'article',
        },
        {
          sourcePath: 'Notes/Hidden.md',
          title: 'Hidden',
          url: '/writing/hidden/',
          visibility: 'unlisted',
          kind: 'article',
        },
      ],
      redirects: [],
    },
    sourceDigest: 'digest',
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
