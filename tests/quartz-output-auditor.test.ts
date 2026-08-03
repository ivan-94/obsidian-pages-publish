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

  it('rejects an unlisted route leaked into Quartz discovery artifacts', () => {
    const raw = rawOutput();
    raw.files['static/contentIndex.json'] = bytes(
      '{"writing/hidden":{"title":"Hidden"}}',
    );

    expect(() => bridgeAndAuditQuartzOutput(raw, staging())).toThrow(
      QuartzOutputAuditError,
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
        { sourcePath: 'Notes/Hello.md', url: '/writing/hello/', visibility: 'public' },
        { sourcePath: 'Notes/Hidden.md', url: '/writing/hidden/', visibility: 'unlisted' },
      ],
      redirects: [],
    },
    sourceDigest: 'digest',
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
