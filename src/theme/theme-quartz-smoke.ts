import type { ReadyQuartzEngine } from '../runtime/quartz-engine-store';
import { QuartzBuildRunner } from '../site-builder/quartz-build-runner';
import { bridgeAndAuditQuartzOutput } from '../site-builder/quartz-output-auditor';
import type { QuartzStagingCompilation } from '../site-builder/quartz-staging-compiler';
import type { SiteThemeReference, ThemeOptions } from './theme-contract';
import { themeOptionsFromSchemaDefaults } from './theme-options-schema';
import type {
  InstalledTheme,
  ThemeInstallReceipt,
  ThemeSmokeRequest,
} from './theme-store';
import { THEME_SMOKE_VERSION } from './theme-store';
import { inspectThemeRuntime } from './theme-runtime-inspector';

export function createQuartzThemeSmoke(
  rootDirectory: string,
  ensureEngine: (signal?: AbortSignal) => Promise<ReadyQuartzEngine>,
): (request: ThemeSmokeRequest) => Promise<void> {
  return async (request) => {
    const engine = await ensureEngine(request.signal);
    const options = request.optionsSchema === undefined
      ? {}
      : themeOptionsFromSchemaDefaults(request.optionsSchema);
    const descriptor = await inspectThemeRuntime({
      rootDirectory,
      nodeExecutable: engine.nodeExecutable,
      engineDirectory: engine.engineDirectory,
      packageDirectory: request.packageDirectory,
      manifest: request.manifest,
      options,
      signal: request.signal,
    });
    const receipt: ThemeInstallReceipt = {
      formatVersion: 1,
      packageName: request.manifest.name,
      version: request.manifest.version,
      integrity: request.integrity,
      source: structuredClone(request.source),
      manifest: request.manifest,
      inventory: request.inventory,
      inventorySha256: 'provisional-smoke-inventory',
      smokeVersion: THEME_SMOKE_VERSION,
      installedAt: '1970-01-01T00:00:00.000Z',
    };
    const installed: InstalledTheme = {
      packageDirectory: request.packageDirectory,
      installationDirectory: request.packageDirectory,
      receipt,
      ...(request.optionsSchema === undefined
        ? {}
        : { optionsSchema: request.optionsSchema }),
    };
    const reference = smokeReference(receipt, options);
    const runner = new QuartzBuildRunner({
      rootDirectory,
      themeResolver: {
        resolve: async () => ({ installed, descriptor, options }),
      },
    });
    const staging = smokeStaging(reference);
    const raw = await runner.run(engine, staging, request.signal);
    const output = bridgeAndAuditQuartzOutput(raw, staging);
    if (!output.files['/index.html'] || !output.files['/theme-smoke/index.html']) {
      throw new Error('Theme smoke did not emit the minimal Quartz routes.');
    }
  };
}

function smokeReference(
  receipt: ThemeInstallReceipt,
  options: ThemeOptions,
): SiteThemeReference {
  return receipt.source.kind === 'npm'
    ? {
      source: 'npm',
      package: receipt.packageName,
      version: receipt.version,
      integrity: receipt.integrity,
      options,
    }
    : {
      source: 'local',
      artifact: receipt.source.artifact,
      integrity: receipt.integrity,
      options,
    };
}

function smokeStaging(
  theme: SiteThemeReference,
): Readonly<QuartzStagingCompilation> {
  return {
    config: {
      version: 1,
      site: {
        name: 'Pages Publish Theme Smoke',
        homeLayout: 'latest',
        theme,
      },
      contentRoots: [{ path: '.', publicRoot: '/' }],
      assets: { exclude: [] },
      features: { search: false, graph: false },
      cloudflare: { projectName: 'pages-publish-theme-smoke' },
    },
    contentFiles: {
      'theme-smoke.md': [
        '---',
        'title: Theme smoke',
        '---',
        '# Theme smoke',
        '',
        'Offline external theme build.',
      ].join('\n'),
    },
    assetFiles: {},
    routePlan: {
      articles: [{
        sourcePath: 'theme-smoke.md',
        url: '/theme-smoke/',
        onlineUrl: undefined,
        redirects: [],
      }],
      sections: [],
      systemRoutes: ['/', '/404/', '/privacy/'],
      redirects: [],
      issues: [],
    },
    routeManifest: {
      articles: [{
        sourcePath: 'theme-smoke.md',
        title: 'Theme smoke',
        url: '/theme-smoke/',
        visibility: 'public',
        kind: 'article',
      }],
      redirects: [],
    },
    sourceDigest: 'pages-publish-theme-smoke-v1',
  };
}
