import { extname, relative } from 'path';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import {
  prepareLegacyPublicationMigrationFromDirectory,
  readArticleMetadataFromDirectory,
  type ArticlePublicationMetadata,
  type PreparedLegacyPublicationMigration,
} from './article-metadata';
import {
  planSiteRoutes,
  type PlannedRedirect,
  type RouteIssue,
  type SiteRoutePlan,
} from '../routing/route-planner';
import { collectDirectoryRouteSources } from '../routing/directory-route-sources';

export type ArticlePublicationState =
  | 'private'
  | 'pending-first-publish'
  | 'deployed'
  | 'pending-takedown';

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
  route: {
    pendingUrl?: string;
    onlineUrl?: string;
    redirects: PlannedRedirect[];
    issues: RouteIssue[];
  };
  legacyMigration?: PreparedLegacyPublicationMigration;
}

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
  if (!root) return { status: 'out-of-scope', selection, sourcePath };
  let metadata: ArticlePublicationMetadata;
  try {
    metadata = await readArticleMetadataFromDirectory(vaultRoot, sourcePath);
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
  try {
    const collected = await collectDirectoryRouteSources(vaultRoot, loaded.config);
    const planned = planSiteRoutes(loaded.config, collected.inputs);
    routePlan = {
      ...planned,
      issues: [...collected.issues, ...planned.issues],
    };
  } catch (error) {
    return { status: 'config-error', sourcePath, message: errorMessage(error) };
  }
  const plannedArticle = routePlan.articles.find(
    (article) => article.sourcePath === sourcePath,
  );
  return {
    status: 'article',
    selection,
    sourcePath,
    contentRootPath: root.path,
    metadata,
    publicationState: publicationState(metadata),
    route: {
      ...(plannedArticle?.url === undefined ? {} : { pendingUrl: plannedArticle.url }),
      ...(metadata.deployment?.url === undefined
        ? {}
        : { onlineUrl: metadata.deployment.url }),
      redirects: routePlan.redirects.filter(
        (redirect) => redirect.to === plannedArticle?.url,
      ),
      issues: routePlan.issues.filter(
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
      ),
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

function publicationState(
  metadata: ArticlePublicationMetadata,
): ArticlePublicationState {
  if (metadata.visibility.value === 'private') {
    return metadata.deployment ? 'pending-takedown' : 'private';
  }
  return metadata.deployment ? 'deployed' : 'pending-first-publish';
}

function pathIsInside(sourcePath: string, rootPath: string): boolean {
  const pathFromRoot = relative(rootPath, sourcePath);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}
