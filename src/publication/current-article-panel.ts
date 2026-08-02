import { extname, relative } from 'path';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import {
  prepareLegacyPublicationMigrationFromDirectory,
  readArticleSnapshotFromDirectory,
  type ArticlePublicationMetadata,
  type ArticleSourceSnapshot,
  type PreparedLegacyPublicationMigration,
} from './article-metadata';
import {
  planSiteRoutes,
  type PlannedRedirect,
  type RouteIssue,
  type SiteRoutePlan,
} from '../routing/route-planner';
import { collectDirectoryRouteSources } from '../routing/directory-route-sources';
import {
  inspectNoteReferences,
  countNoteReferences,
  type NoteReferenceIssue,
} from '../content/note-references';
import {
  collectLocalPreviewAssets,
  countMarkdownAssetReferences,
  type LocalAssetIssue,
} from '../content/local-assets';
import { inspectRawHtml, type RawHtmlIssue } from '../content/raw-html';

export type ArticlePublicationState =
  | 'private'
  | 'pending-first-publish'
  | 'synced'
  | 'updated'
  | 'url-changed'
  | 'visibility-changed'
  | 'pending-takedown'
  | 'blocked'
  | 'unknown';

export interface CurrentArticleContext {
  activePath?: string | null;
  pinnedPath?: string | null;
}

export interface CurrentArticlePanelArticle {
  status: 'article';
  selection: 'active' | 'pinned';
  sourcePath: string;
  contentRootPath: string;
  metadata: ArticlePublicationMetadata;
  publicationState: ArticlePublicationState;
  sitePublicationFailed?: boolean;
  currentSourceDigest: string;
  dependencies: { images: number; notes: number; externalLinks: number };
  contentIssues: ArticleContentIssue[];
  route: {
    pendingUrl?: string;
    onlineUrl?: string;
    redirects: PlannedRedirect[];
    issues: RouteIssue[];
  };
  legacyMigration?: PreparedLegacyPublicationMigration;
}

export type ArticleContentIssue =
  | NoteReferenceIssue
  | LocalAssetIssue
  | RawHtmlIssue;

export type CurrentArticlePanelState =
  | CurrentArticlePanelArticle
  | { status: 'no-active' }
  | {
      status: 'non-markdown';
      selection: 'active' | 'pinned';
      sourcePath: string;
    }
  | {
      status: 'out-of-scope';
      selection: 'active' | 'pinned';
      sourcePath: string;
    }
  | {
      status: 'out-of-scope-online';
      selection: 'active' | 'pinned';
      sourcePath: string;
      onlineUrl: string;
    }
  | { status: 'missing-pinned'; sourcePath: string }
  | { status: 'no-site'; sourcePath: string }
  | { status: 'config-error'; sourcePath: string; message: string };

export async function resolveCurrentArticlePanelFromDirectory(
  vaultRoot: string,
  context: CurrentArticleContext,
): Promise<CurrentArticlePanelState> {
  const sourcePath = context.pinnedPath ?? context.activePath;
  if (!sourcePath) return { status: 'no-active' };
  const selection = context.pinnedPath ? 'pinned' : 'active';
  if (extname(sourcePath).toLowerCase() !== '.md') {
    return { status: 'non-markdown', selection, sourcePath };
  }
  let loaded;
  try {
    loaded = await loadSiteConfigFromDirectory(vaultRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'no-site', sourcePath };
    return { status: 'config-error', sourcePath, message: errorMessage(error) };
  }
  if (loaded.status !== 'editable') {
    return {
      status: 'config-error',
      sourcePath,
      message: `Site configuration version ${loaded.version} is read-only.`,
    };
  }
  const root = loaded.config.contentRoots.find((candidate) =>
    pathIsInside(sourcePath, candidate.path),
  );
  if (!root) {
    try {
      const snapshot = await readArticleSnapshotFromDirectory(vaultRoot, sourcePath);
      if (snapshot.metadata.deployment?.url) {
        return {
          status: 'out-of-scope-online',
          selection,
          sourcePath,
          onlineUrl: snapshot.metadata.deployment.url,
        };
      }
    } catch {
      // An out-of-scope path remains an out-of-scope state even when unreadable.
    }
    return { status: 'out-of-scope', selection, sourcePath };
  }
  let metadata: ArticlePublicationMetadata;
  let currentSourceDigest: string;
  let articleSnapshot: ArticleSourceSnapshot;
  try {
    articleSnapshot = await readArticleSnapshotFromDirectory(vaultRoot, sourcePath);
    metadata = articleSnapshot.metadata;
    currentSourceDigest = articleSnapshot.contentDigest ?? articleSnapshot.revision;
  } catch (error) {
    if (context.pinnedPath && isErrno(error, 'ENOENT')) {
      return { status: 'missing-pinned', sourcePath };
    }
    return { status: 'config-error', sourcePath, message: errorMessage(error) };
  }
  let legacyMigration: PreparedLegacyPublicationMigration | undefined;
  try {
    legacyMigration = await prepareLegacyPublicationMigrationFromDirectory(
      vaultRoot,
      sourcePath,
    );
  } catch (error) {
    return { status: 'config-error', sourcePath, message: errorMessage(error) };
  }
  let routePlan: SiteRoutePlan;
  let contentIssues: ArticleContentIssue[];
  let dependencies: CurrentArticlePanelArticle['dependencies'];
  try {
    const collected = await collectDirectoryRouteSources(vaultRoot, loaded.config);
    const planned = planSiteRoutes(loaded.config, collected.inputs);
    routePlan = {
      ...planned,
      issues: [...collected.issues, ...planned.issues],
    };
    const assetPlan = await collectLocalPreviewAssets(
      vaultRoot,
      collected.snapshots,
      loaded.config.assets.exclude,
      new Set(routePlan.articles.map((article) => article.sourcePath)),
    );
    contentIssues = [
      ...inspectNoteReferences(collected.snapshots, {
        isObsidianAsset: (candidateSourcePath, target) =>
          assetPlan.claimsObsidianAsset(candidateSourcePath, target),
      }),
      ...assetPlan.issues,
      ...inspectRawHtml(collected.snapshots),
    ]
      .filter((issue) => issue.sourcePath === sourcePath)
      .sort(
        (left, right) =>
          left.line - right.line || left.column - right.column,
      );
    dependencies = {
      images: countMarkdownAssetReferences(articleSnapshot),
      notes: countNoteReferences(articleSnapshot),
      externalLinks: assetPlan.externalLinks.filter(
        (link) => link.sourcePath === sourcePath,
      ).length,
    };
  } catch (error) {
    return { status: 'config-error', sourcePath, message: errorMessage(error) };
  }
  const plannedArticle = routePlan.articles.find(
    (article) => article.sourcePath === sourcePath,
  );
  const routeIssues = routePlan.issues.filter(
    (issue) =>
      issue.sourcePath === sourcePath ||
      issue.relatedSourcePaths?.includes(sourcePath) ||
      (plannedArticle !== undefined &&
        issue.directoryPath !== undefined &&
        pathIsInside(sourcePath, issue.directoryPath)) ||
      (plannedArticle !== undefined &&
        issue.relatedDirectoryPaths?.some((directoryPath) =>
          pathIsInside(sourcePath, directoryPath),
        )) ||
      issue.route === plannedArticle?.url ||
      issue.route === metadata.deployment?.url,
  );
  return {
    status: 'article',
    selection,
    sourcePath,
    contentRootPath: root.path,
    metadata,
    currentSourceDigest,
    dependencies,
    publicationState: deriveArticlePublicationState({
      visibility: metadata.visibility.value,
      pendingUrl: plannedArticle?.url,
      onlineUrl: metadata.deployment?.url,
      currentSourceDigest,
      deployedSourceDigest: metadata.deployment?.sourceDigest,
      hasBlocker: [...contentIssues, ...routeIssues].some(
        (issue) => issue.severity === 'blocker' && !('dormant' in issue && issue.dormant),
      ),
    }),
    contentIssues,
    route: {
      ...(plannedArticle?.url === undefined ? {} : { pendingUrl: plannedArticle.url }),
      ...(metadata.deployment?.url === undefined
        ? {}
        : { onlineUrl: metadata.deployment.url }),
      redirects: routePlan.redirects.filter(
        (redirect) => redirect.to === plannedArticle?.url,
      ),
      issues: routeIssues,
    },
    ...(legacyMigration === undefined ? {} : { legacyMigration }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown article error.';
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

export function deriveArticlePublicationState(input: {
  visibility: 'public' | 'unlisted' | 'private';
  pendingUrl?: string;
  onlineUrl?: string;
  currentSourceDigest?: string;
  deployedSourceDigest?: string;
  deployedVisibility?: 'public' | 'unlisted' | 'private';
  hasBlocker: boolean;
}): ArticlePublicationState {
  if (input.hasBlocker) return 'blocked';
  if (input.visibility === 'private') {
    return input.onlineUrl ? 'pending-takedown' : 'private';
  }
  if (!input.onlineUrl) return 'pending-first-publish';
  if (input.pendingUrl && routePath(input.pendingUrl) !== routePath(input.onlineUrl)) {
    return 'url-changed';
  }
  if (input.deployedVisibility && input.visibility !== input.deployedVisibility) {
    return 'visibility-changed';
  }
  if (!input.currentSourceDigest || !input.deployedSourceDigest) return 'unknown';
  if (input.currentSourceDigest !== input.deployedSourceDigest) {
    return 'updated';
  }
  return 'synced';
}

function routePath(value: string): string {
  if (value.startsWith('/')) return value;
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function pathIsInside(sourcePath: string, rootPath: string): boolean {
  const pathFromRoot = relative(rootPath, sourcePath);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}
