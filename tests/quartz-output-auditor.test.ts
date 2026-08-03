import { describe, expect, it } from 'vitest';
import {
  QuartzOutputAuditError,
  bridgeAndAuditQuartzOutput,
} from '../src/site-builder/quartz-output-auditor';
import type { QuartzStagingCompilation } from '../src/site-builder/quartz-staging-compiler';

describe('Quartz output route bridge and auditor', () => {
  it('normalizes Quartz flat HTML into existing directory routes', () => {
    const output = bridgeAndAuditQuartzOutput(
      rawOutput({
        'writing/hello.html': '<a href="/writing/hidden">Hidden</a>',
        'writing/hidden.html': '<h1>Hidden</h1>',
      }),
      staging(),
    );

    expect(output.files['/writing/hello/index.html']).toContain('/writing/hidden/');
    expect(output.files['/writing/hidden/index.html']).toContain('Hidden');
    expect(output.files['/privacy/index.html']).toBeDefined();
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
      'index.html': '<a href="/writing/hidden-section/child/">Public child</a>',
    });

    expect(() => bridgeAndAuditQuartzOutput(raw, staging())).not.toThrow();
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
