import type { QuartzEngineSmokeRequest } from './quartz-engine-store';
import { QuartzBuildRunner } from '../site-builder/quartz-build-runner';
import { bridgeAndAuditQuartzOutput } from '../site-builder/quartz-output-auditor';
import type { QuartzStagingCompilation } from '../site-builder/quartz-staging-compiler';

export function createQuartzEngineSmoke(rootDirectory: string) {
  const runner = new QuartzBuildRunner({ rootDirectory });
  return async (request: QuartzEngineSmokeRequest): Promise<void> => {
    const staging = smokeStaging();
    const raw = await runner.run(
      {
        ...request.runtime,
        engineDirectory: request.engineDirectory,
        engineVersion: request.manifest.engineVersion,
        quartzVersion: request.manifest.quartzVersion,
        platform: request.manifest.platform,
        usingFallback: false,
      },
      staging,
    );
    const output = bridgeAndAuditQuartzOutput(raw, staging);
    if (!output.files['/index.html'] || !output.files['/smoke/index.html']) {
      throw new Error('The Quartz engine minimal offline build did not emit its smoke routes.');
    }
  };
}

function smokeStaging(): Readonly<QuartzStagingCompilation> {
  return {
    config: {
      version: 1,
      site: { name: 'Pages Publish Quartz Smoke', homeLayout: 'latest' },
      contentRoots: [{ path: '.', publicRoot: '/' }],
      assets: { exclude: [] },
      features: { search: false, graph: false },
      cloudflare: { projectName: 'pages-publish-quartz-smoke' },
    },
    contentFiles: {
      'smoke.md': '---\ntitle: Quartz smoke\n---\n# Quartz smoke\n\nOffline build.',
    },
    assetFiles: {},
    routePlan: {
      articles: [{
        sourcePath: 'smoke.md',
        url: '/smoke/',
        onlineUrl: undefined,
        redirects: [],
      }],
      sections: [],
      systemRoutes: ['/', '/404/', '/privacy/'],
      redirects: [],
      issues: [],
    },
    routeManifest: {
      articles: [{ sourcePath: 'smoke.md', url: '/smoke/', visibility: 'public' }],
      redirects: [],
    },
    sourceDigest: 'pages-publish-quartz-smoke-v1',
  };
}
