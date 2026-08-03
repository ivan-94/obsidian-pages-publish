import { loadDirectoryRouteSources } from '../routing/directory-route-sources';
import type { ReadyQuartzEngine } from '../runtime/quartz-engine-store';
import type {
  LocalPreview,
  PreviewArticle,
  PreviewPage,
  SiteBuilder,
  SiteBuildRequest,
} from './site-builder';
import { QuartzBuildRunner, type QuartzRawBuildOutput } from './quartz-build-runner';
import {
  bridgeAndAuditQuartzOutput,
  createQuartzOutputAuditPolicy,
} from './quartz-output-auditor';
import {
  compileQuartzStaging,
  type QuartzStagingCompilation,
} from './quartz-staging-compiler';

export interface QuartzEnvironmentBoundary {
  ensureReady(signal?: AbortSignal): Promise<ReadyQuartzEngine>;
}

export interface QuartzRunnerBoundary {
  run(
    engine: ReadyQuartzEngine,
    staging: Readonly<QuartzStagingCompilation>,
    signal?: AbortSignal,
  ): Promise<QuartzRawBuildOutput>;
}

export class QuartzSiteBuilder implements SiteBuilder {
  private buildTail: Promise<unknown> = Promise.resolve();
  private readonly lifecycleController = new AbortController();

  constructor(private readonly dependencies: {
    environment: QuartzEnvironmentBoundary;
    runner: QuartzRunnerBoundary | QuartzBuildRunner;
  }) {}

  build(request: SiteBuildRequest): Promise<LocalPreview> {
    const signal = request.signal === undefined
      ? this.lifecycleController.signal
      : AbortSignal.any([request.signal, this.lifecycleController.signal]);
    const operation = this.buildTail
      .catch(() => undefined)
      .then(() => this.buildExclusive({ ...request, signal }));
    this.buildTail = operation;
    return operation;
  }

  async dispose(): Promise<void> {
    this.lifecycleController.abort();
    await this.buildTail.catch(() => undefined);
  }

  private async buildExclusive(request: SiteBuildRequest): Promise<LocalPreview> {
    request.signal?.throwIfAborted();
    const engine = await this.dependencies.environment.ensureReady(request.signal);
    request.signal?.throwIfAborted();
    const staging = await compileQuartzStaging(request.vaultRoot, {
      ...(request.webpDecoder === undefined ? {} : { webpDecoder: request.webpDecoder }),
      ...(request.focusSourcePath === undefined
        ? {}
        : { previewSourcePath: request.focusSourcePath }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const { snapshots } = await loadDirectoryRouteSources(request.vaultRoot, staging.config);
    const auditPolicy = createQuartzOutputAuditPolicy(request.vaultRoot, snapshots, {
      ...(request.focusSourcePath === undefined
        ? {}
        : { allowedPrivateSourcePath: request.focusSourcePath }),
    });
    const rawOutput = await this.dependencies.runner.run(engine, staging, request.signal);
    const output = bridgeAndAuditQuartzOutput(rawOutput, staging, auditPolicy);
    const routesBySource = new Map(
      staging.routePlan.articles.map((article) => [article.sourcePath, article]),
    );
    const pages: PreviewPage[] = staging.routeManifest.articles
      .filter((article) => article.visibility === 'public')
      .map((article) => ({
        sourcePath: article.sourcePath,
        title: snapshots.get(article.sourcePath)?.metadata.title.value ?? article.sourcePath,
        url: article.url,
      }));
    const articles: PreviewArticle[] = [...snapshots.values()]
      .map((snapshot) => {
        const route = routesBySource.get(snapshot.sourcePath);
        return {
          sourcePath: snapshot.sourcePath,
          title: snapshot.metadata.title.value,
          visibility: snapshot.metadata.visibility.value,
          sourceDigest: snapshot.contentDigest ?? snapshot.revision,
          ...(route?.url === undefined ? {} : { url: route.url }),
          ...(snapshot.metadata.deployment?.url === undefined
            ? route?.onlineUrl === undefined
              ? {}
              : { onlineUrl: route.onlineUrl }
            : { onlineUrl: snapshot.metadata.deployment.url }),
          ...(snapshot.metadata.deployment?.firstPublishedAt === undefined
            ? {}
            : { firstPublishedAt: snapshot.metadata.deployment.firstPublishedAt }),
          ...(snapshot.metadata.deployment?.lastPublishedAt === undefined
            ? {}
            : { lastPublishedAt: snapshot.metadata.deployment.lastPublishedAt }),
        };
      })
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

    return {
      siteName: staging.config.site.name,
      ...(staging.config.site.timezone === undefined
        ? {}
        : { timeZone: staging.config.site.timezone }),
      pages,
      articles,
      files: output.files,
      assets: output.assets,
      routePlan: staging.routePlan,
    };
  }
}
