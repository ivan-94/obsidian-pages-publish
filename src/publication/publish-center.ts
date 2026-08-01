import type { ScanIssue, SiteScanResult } from '../content/site-scanner';
import type { LocalPreview, PreviewArticle } from '../core/preview';
import type { PreviewAsset } from '../content/local-assets';

export type PublishChange =
  | 'added'
  | 'updated'
  | 'url-changed'
  | 'visibility-changed'
  | 'takedown'
  | 'unchanged'
  | 'unknown';

export type PublishVisibility = 'public' | 'unlisted' | 'private';

export interface PublishCenterArticleInput {
  sourcePath: string;
  title: string;
  url?: string;
  visibility?: PublishVisibility;
  sourceDigest: string;
  availability?: 'ready' | 'unavailable' | 'historical';
}

export interface DeploymentBaselineArticle {
  sourcePath: string;
  sourceDigest: string;
  url: string;
  visibility: PublishVisibility;
  title?: string;
}

export type PublishBaseline =
  | { status: 'first-publish' }
  | { status: 'missing' }
  | { status: 'available'; articles: readonly DeploymentBaselineArticle[] };

export interface PublishCenterArticle {
  sourcePath: string;
  title: string;
  url?: string;
  onlineUrl?: string;
  visibility: PublishVisibility | undefined;
  nextIncluded: boolean;
  availability: 'ready' | 'unavailable' | 'historical';
  change: PublishChange;
  issues: ScanIssue[];
}

export interface PublishCenterState {
  siteName: string;
  baseline: 'first-publish' | 'available' | 'unknown';
  canPublish: boolean;
  scanDigest: string;
  output: PublishOutput;
  articles: PublishCenterArticle[];
  issues: ScanIssue[];
  summary: {
    changes: number;
    added: number;
    updated: number;
    urlChanged: number;
    visibilityChanged: number;
    takedowns: number;
    unknown: number;
    blockers: number;
    warnings: number;
  };
}

export interface PublishOutput {
  status: 'known' | 'unknown';
  fileCount: number;
  assetCount: number;
  assetBytes: number;
}

/**
 * A copied, value-only build input. S13 consumes this object rather than the
 * live Vault, so edits after confirmation belong to the next publish report.
 */
export interface PublicationSnapshot {
  scanDigest: string;
  files: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, PublicationSnapshotAsset>>;
  output: {
    fileCount: number;
    assetCount: number;
    assetBytes: number;
  };
}

export interface PublicationSnapshotAsset {
  contentBase64: string;
  contentType: string;
}

export function createPublishCenterState(input: {
  siteName: string;
  scan: SiteScanResult;
  articles: readonly PublishCenterArticleInput[];
  baseline: PublishBaseline;
  output?: Omit<PublishOutput, 'status'> & { status?: PublishOutput['status'] };
}): PublishCenterState {
  const baselineBySource = input.baseline.status === 'available'
    ? new Map(input.baseline.articles.map((article) => [article.sourcePath, article]))
    : new Map<string, DeploymentBaselineArticle>();
  const articles = input.articles
    .map((article) => toPublishCenterArticle(article, baselineBySource.get(article.sourcePath), input))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  if (input.baseline.status === 'available') {
    for (const previous of input.baseline.articles) {
      if (input.articles.some((article) => article.sourcePath === previous.sourcePath)) continue;
      articles.push({
        sourcePath: previous.sourcePath,
        title: previous.title ?? previous.sourcePath,
        onlineUrl: previous.url,
        visibility: undefined,
        nextIncluded: false,
        availability: 'historical',
        change: 'takedown',
        issues: issuesForSource(input.scan.issues, previous.sourcePath),
      });
    }
  }
  articles.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  const blockers = input.scan.issues.filter((issue) => issue.severity === 'blocker');
  const warnings = input.scan.issues.filter((issue) => issue.severity === 'warning');
  return {
    siteName: input.siteName,
    baseline: baselineLabel(input.baseline),
    canPublish: blockers.length === 0,
    scanDigest: input.scan.digest,
    output: {
      status: input.output?.status ?? 'unknown',
      fileCount: input.output?.fileCount ?? 0,
      assetCount: input.output?.assetCount ?? 0,
      assetBytes: input.output?.assetBytes ?? 0,
    },
    articles,
    issues: [...input.scan.issues],
    summary: {
      changes: articles.filter((article) => article.change !== 'unchanged').length,
      added: countChanges(articles, 'added'),
      updated: countChanges(articles, 'updated'),
      urlChanged: countChanges(articles, 'url-changed'),
      visibilityChanged: countChanges(articles, 'visibility-changed'),
      takedowns: countChanges(articles, 'takedown'),
      unknown: countChanges(articles, 'unknown'),
      blockers: blockers.length,
      warnings: warnings.length,
    },
  };
}

export function createPublicationSnapshot(
  scan: SiteScanResult,
  preview: LocalPreview,
): PublicationSnapshot {
  const files = Object.freeze({ ...preview.files });
  const assets = Object.freeze(Object.fromEntries(
    Object.entries(preview.assets).map(([path, asset]) => [
      path,
      Object.freeze({
        contentBase64: Buffer.from(asset.content).toString('base64'),
        contentType: asset.contentType,
      }),
    ]),
  ));
  const output = Object.freeze({
    fileCount: Object.keys(files).length,
    assetCount: Object.keys(assets).length,
    assetBytes: Object.values(assets).reduce(
      (total, asset) => total + Buffer.from(asset.contentBase64, 'base64').byteLength,
      0,
    ),
  });
  return Object.freeze({
    scanDigest: scan.digest,
    files,
    assets,
    output,
  });
}

/** Returns independent byte buffers; mutations cannot alter the snapshot. */
export function materializePublicationSnapshotAssets(
  snapshot: PublicationSnapshot,
): Record<string, PreviewAsset> {
  return Object.fromEntries(Object.entries(snapshot.assets).map(([path, asset]) => [
    path,
    {
      content: new Uint8Array(Buffer.from(asset.contentBase64, 'base64')),
      contentType: asset.contentType,
    },
  ]));
}

/**
 * Until S14 persists the complete deployment manifest, this is the only safe
 * report for a new site: all selected current pages are additions.
 */
export function createFirstPublishCenterState(
  scan: SiteScanResult,
  preview: LocalPreview,
): PublishCenterState {
  return createPublishCenterState({
    siteName: preview.siteName,
    scan,
    articles: preview.articles.map(toFirstPublishArticle),
    baseline: { status: 'first-publish' },
    output: previewOutput(preview),
  });
}

export function previewOutput(preview: LocalPreview): PublishOutput {
  return {
    status: 'known',
    fileCount: Object.keys(preview.files).length,
    assetCount: Object.keys(preview.assets).length,
    assetBytes: Object.values(preview.assets).reduce(
      (total, asset) => total + asset.content.byteLength,
      0,
    ),
  };
}

function toPublishCenterArticle(
  article: PublishCenterArticleInput,
  previous: DeploymentBaselineArticle | undefined,
  input: { scan: SiteScanResult; baseline: PublishBaseline },
): PublishCenterArticle {
  const nextIncluded = article.visibility !== 'private';
  return {
    sourcePath: article.sourcePath,
    title: article.title,
    ...(article.url ? { url: article.url } : {}),
    ...(previous ? { onlineUrl: previous.url } : {}),
    visibility: article.visibility,
    nextIncluded: article.visibility !== undefined && nextIncluded,
    availability: article.availability ?? 'ready',
    change: determineChange(article, previous, input.baseline),
    issues: issuesForSource(input.scan.issues, article.sourcePath),
  };
}

function determineChange(
  article: PublishCenterArticleInput,
  previous: DeploymentBaselineArticle | undefined,
  baseline: PublishBaseline,
): PublishChange {
  if (article.availability === 'unavailable' || article.visibility === undefined) {
    return 'unknown';
  }
  if (baseline.status === 'missing') return 'unknown';
  if (!previous) return article.visibility === 'private' ? 'unchanged' : 'added';
  if (article.visibility === 'private') return 'takedown';
  if (article.url !== previous.url) return 'url-changed';
  if (article.visibility !== previous.visibility) return 'visibility-changed';
  if (article.sourceDigest !== previous.sourceDigest) return 'updated';
  return 'unchanged';
}

function toFirstPublishArticle(article: PreviewArticle): PublishCenterArticleInput {
  return {
    ...article,
  };
}

function baselineLabel(
  baseline: PublishBaseline,
): PublishCenterState['baseline'] {
  return baseline.status === 'missing' ? 'unknown' : baseline.status;
}

function countChanges(
  articles: readonly PublishCenterArticle[],
  change: PublishChange,
): number {
  return articles.filter((article) => article.change === change).length;
}

function issuesForSource(
  issues: readonly ScanIssue[],
  sourcePath: string,
): ScanIssue[] {
  return issues.filter((issue) => issue.path === sourcePath);
}
