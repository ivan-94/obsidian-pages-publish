import { posix } from 'path';
import type { SiteConfigV1 } from '../config/site-config';
import type { PublicationVisibility } from '../publication/article-metadata';
import { hasControlCharacter, normalizeRouteUrlPath } from './url-path';

export { normalizeRouteUrlPath } from './url-path';

export interface RouteArticleInput {
  sourcePath: string;
  visibility: PublicationVisibility;
  slug: string;
  kind: 'article' | 'index';
  redirects: string[];
  onlineUrl?: string;
}

export interface PlannedArticleRoute {
  sourcePath: string;
  url: string;
  onlineUrl: string | undefined;
  redirects: PlannedRedirect[];
}

export interface PlannedRedirect {
  from: string;
  to: string;
}

export interface PlannedSectionRoute {
  directoryPath: string;
  url: string;
  sourcePath?: string;
  generated: boolean;
}

export interface RouteIssue {
  severity: 'warning' | 'blocker';
  code: string;
  message: string;
  sourcePath?: string;
  relatedSourcePaths?: string[];
  directoryPath?: string;
  relatedDirectoryPaths?: string[];
  route?: string;
}

export interface SiteRoutePlan {
  articles: PlannedArticleRoute[];
  sections: PlannedSectionRoute[];
  systemRoutes: string[];
  redirects: PlannedRedirect[];
  issues: RouteIssue[];
}

export interface RoutePlanOptions {
  historicalRedirects?: PlannedRedirect[];
}

export class RoutePlanningError extends Error {
  readonly name = 'RoutePlanningError';

  constructor(readonly issues: RouteIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
  }
}

export function planSiteRoutes(
  config: SiteConfigV1,
  inputs: RouteArticleInput[],
  options: RoutePlanOptions = {},
): SiteRoutePlan {
  const articles: PlannedArticleRoute[] = [];
  const issues: RouteIssue[] = [];
  const routingConfig = normalizeRoutingConfig(config, issues);
  const visibleInputs = inputs.filter((input) => input.visibility !== 'private');
  const preferredIndexes = preferredDirectoryIndexes(routingConfig, visibleInputs);
  const suppressed = new Set<string>();
  for (const entry of preferredIndexes.values()) {
    if (!isDocumentedIndexPair(entry.candidates)) {
      if (entry.candidates.length > 1) {
        issues.push({
          severity: 'blocker',
          code: 'multiple-directory-indexes',
          directoryPath:
            entry.directory === '.'
              ? entry.rootPath
              : posix.join(entry.rootPath, entry.directory),
          relatedSourcePaths: entry.candidates
            .map((candidate) => candidate.sourcePath)
            .sort((left, right) => left.localeCompare(right)),
          message: 'A directory has multiple competing index declarations.',
        });
      }
    }
    for (const candidate of entry.candidates) {
      if (candidate.sourcePath !== entry.winner.sourcePath) {
        suppressed.add(candidate.sourcePath);
      }
    }
  }
  for (const input of visibleInputs) {
    if (suppressed.has(input.sourcePath)) continue;
    const root = routingConfig.contentRoots.find((candidate) =>
      pathIsInside(input.sourcePath, candidate.path),
    );
    if (!root) continue;
    const relativePath = posix.relative(root.path, input.sourcePath);
    const directory = posix.dirname(relativePath);
    const indexEntry = preferredIndexes.get(directoryKey(root.path, directory));
    const isDirectoryIndex = indexEntry?.winner.sourcePath === input.sourcePath;
    const normalizedSlug = normalizeSlug(input.slug);
    if (!isDirectoryIndex && normalizedSlug === undefined) {
      issues.push({
        severity: 'blocker',
        code: 'invalid-slug',
        sourcePath: input.sourcePath,
        message: 'Slug cannot control path levels, queries, fragments, or URL decoding.',
      });
      continue;
    }
    const normalizedDirectory = normalizeRelativeDirectory(directory);
    if (normalizedDirectory === undefined) {
      issues.push({
        severity: 'blocker',
        code: 'invalid-route-directory',
        sourcePath: input.sourcePath,
        directoryPath: directory,
        message: 'A source directory cannot safely map to a URL path.',
      });
      continue;
    }
    const url = isDirectoryIndex
      ? sectionRoutePath(root.publicRoot, normalizedDirectory)
      : routePath(root.publicRoot, normalizedDirectory, normalizedSlug!);
    const redirects: PlannedRedirect[] = [];
    const seenRedirects = new Set<string>();
    for (const rawRedirect of input.redirects) {
      const from = normalizeRouteUrlPath(rawRedirect);
      if (!from) {
        issues.push({
          severity: 'blocker',
          code: 'invalid-redirect',
          sourcePath: input.sourcePath,
          route: rawRedirect,
          message: 'Redirect must be a safe absolute URL path.',
        });
        continue;
      }
      if (seenRedirects.has(from)) continue;
      seenRedirects.add(from);
      redirects.push({ from, to: url });
    }
    articles.push({
      sourcePath: input.sourcePath,
      url,
      onlineUrl: input.onlineUrl,
      redirects,
    });
  }
  articles.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const publicSourcePaths = new Set(
    inputs
      .filter((input) => input.visibility === 'public')
      .map((input) => input.sourcePath),
  );
  const sections = plannedSections(
    routingConfig,
    articles,
    preferredIndexes,
    publicSourcePaths,
  );
  const systemRoutes = [
    '/',
    '/404/',
    '/privacy/',
    '/sitemap.xml',
    ...(routingConfig.features.search ? ['/search/'] : []),
    ...(routingConfig.features.graph ? ['/graph/'] : []),
  ];
  const articleOwners = new Map<string, string[]>();
  for (const article of articles) {
    const owners = articleOwners.get(article.url) ?? [];
    owners.push(article.sourcePath);
    articleOwners.set(article.url, owners);
  }
  for (const [route, owners] of articleOwners) {
    if (owners.length > 1) {
      issues.push({
        severity: 'blocker',
        code: 'route-conflict',
        route,
        relatedSourcePaths: owners,
        message: `Multiple articles generate ${route}.`,
      });
    }
    if (conflictsWithSystemRoute(route, systemRoutes)) {
      for (const sourcePath of owners) {
        if (
          route === '/' &&
          sections.some((section) => section.url === route && section.sourcePath === sourcePath)
        ) {
          continue;
        }
        issues.push({
          severity: 'blocker',
          code: 'system-route-conflict',
          route,
          sourcePath,
          message: `Article route ${route} conflicts with a system page.`,
        });
      }
    }
  }
  for (const section of sections) {
    const owners = articleOwners.get(section.url) ?? [];
    for (const sourcePath of owners) {
      if (sourcePath === section.sourcePath) continue;
      issues.push({
        severity: 'blocker',
        code: 'section-route-conflict',
        sourcePath,
        directoryPath: section.directoryPath,
        route: section.url,
        message: `Article route ${section.url} conflicts with a section page.`,
      });
    }
  }
  const sectionOwners = new Map<string, PlannedSectionRoute[]>();
  for (const section of sections) {
    const owners = sectionOwners.get(section.url) ?? [];
    owners.push(section);
    sectionOwners.set(section.url, owners);
  }
  for (const [route, owners] of sectionOwners) {
    if (owners.length > 1) {
      issues.push({
        severity: 'blocker',
        code: 'section-route-conflict',
        route,
        relatedDirectoryPaths: owners
          .map((owner) => owner.directoryPath)
          .sort((left, right) => left.localeCompare(right)),
        message: `Multiple sections generate ${route}.`,
      });
    }
    if (route !== '/' && conflictsWithSystemRoute(route, systemRoutes)) {
      for (const owner of owners) {
        issues.push({
          severity: 'blocker',
          code: 'section-system-route-conflict',
          route,
          directoryPath: owner.directoryPath,
          message: `Section route ${route} conflicts with a system page.`,
        });
      }
    }
  }
  const redirectOwners = new Map<
    string,
    Array<{ sourcePath: string; to: string }>
  >();
  for (const article of articles) {
    for (const redirect of article.redirects) {
      const owners = redirectOwners.get(redirect.from) ?? [];
      owners.push({ sourcePath: article.sourcePath, to: redirect.to });
      redirectOwners.set(redirect.from, owners);
      if (
        articleOwners.has(redirect.from) ||
        sectionOwners.has(redirect.from) ||
        conflictsWithSystemRoute(redirect.from, systemRoutes)
      ) {
        issues.push({
          severity: 'blocker',
          code: 'redirect-route-conflict',
          route: redirect.from,
          sourcePath: article.sourcePath,
          message: `Redirect ${redirect.from} conflicts with a page route.`,
        });
      }
    }
  }
  for (const [route, owners] of redirectOwners) {
    if (new Set(owners.map((owner) => owner.to)).size <= 1) continue;
    issues.push({
      severity: 'blocker',
      code: 'redirect-conflict',
      route,
      relatedSourcePaths: [...new Set(owners.map((owner) => owner.sourcePath))].sort(
        (left, right) => left.localeCompare(right),
      ),
      message: `Redirect ${route} has multiple targets.`,
    });
  }
  const redirects = resolveRedirects(
    [...articles.flatMap((article) => article.redirects), ...(options.historicalRedirects ?? [])],
    new Set([
      ...articles.map((article) => article.url),
      ...sections.map((section) => section.url),
      ...systemRoutes,
    ]),
    issues,
  );
  for (const article of articles) {
    const onlineUrl = normalizeOnlineUrl(article.onlineUrl);
    if (
      onlineUrl &&
      onlineUrl !== article.url &&
      !redirects.some(
        (redirect) => redirect.from === onlineUrl && redirect.to === article.url,
      )
    ) {
      issues.push({
        severity: 'warning',
        code: 'untracked-online-url',
        sourcePath: article.sourcePath,
        route: onlineUrl,
        message: `The known online URL ${onlineUrl} is not preserved by a redirect.`,
      });
    }
  }
  return { articles, sections, systemRoutes, redirects, issues };
}

function conflictsWithSystemRoute(
  route: string,
  systemRoutes: readonly string[],
): boolean {
  return systemRoutes.some(
    (systemRoute) =>
      route === systemRoute ||
      (!systemRoute.endsWith('/') && route === `${systemRoute}/`),
  );
}

function resolveRedirects(
  candidates: PlannedRedirect[],
  pageRoutes: Set<string>,
  issues: RouteIssue[],
): PlannedRedirect[] {
  const targets = new Map<string, string>();
  for (const candidate of candidates) {
    const from = normalizeRouteUrlPath(candidate.from);
    const to = normalizeRouteUrlPath(candidate.to);
    if (!from || !to) {
      issues.push({
        severity: 'blocker',
        code: 'invalid-redirect',
        route: candidate.from,
        message: 'Redirect source and target must be safe absolute URL paths.',
      });
      continue;
    }
    const existing = targets.get(from);
    if (existing && existing !== to) {
      if (
        !issues.some(
          (issue) => issue.code === 'redirect-conflict' && issue.route === from,
        )
      ) {
        issues.push({
          severity: 'blocker',
          code: 'redirect-conflict',
          route: from,
          message: `Redirect ${from} has multiple targets.`,
        });
      }
      continue;
    }
    targets.set(from, to);
  }

  const resolved: PlannedRedirect[] = [];
  for (const from of [...targets.keys()].sort()) {
    if (pageRoutes.has(from)) {
      if (
        !issues.some(
          (issue) => issue.code === 'redirect-route-conflict' && issue.route === from,
        )
      ) {
        issues.push({
          severity: 'blocker',
          code: 'redirect-route-conflict',
          route: from,
          message: `Redirect ${from} conflicts with a page route.`,
        });
      }
      continue;
    }
    const visited = new Set<string>();
    let target = targets.get(from)!;
    visited.add(from);
    while (!pageRoutes.has(target) && targets.has(target)) {
      if (visited.has(target)) {
        issues.push({
          severity: 'blocker',
          code: 'redirect-cycle',
          route: from,
          message: `Redirect ${from} participates in a cycle.`,
        });
        target = '';
        break;
      }
      visited.add(target);
      target = targets.get(target)!;
    }
    if (!target) continue;
    if (!pageRoutes.has(target)) {
      issues.push({
        severity: 'blocker',
        code: 'redirect-target-missing',
        route: from,
        message: `Redirect ${from} does not resolve to a generated page.`,
      });
      continue;
    }
    resolved.push({ from, to: target });
  }
  return resolved;
}

interface PreferredIndex {
  winner: RouteArticleInput;
  candidates: RouteArticleInput[];
  rootPath: string;
  directory: string;
}

function preferredDirectoryIndexes(
  config: SiteConfigV1,
  inputs: RouteArticleInput[],
): Map<string, PreferredIndex> {
  const byDirectory = new Map<string, RouteArticleInput[]>();
  for (const input of inputs) {
    const root = config.contentRoots.find((candidate) =>
      pathIsInside(input.sourcePath, candidate.path),
    );
    if (!root) continue;
    const relativePath = posix.relative(root.path, input.sourcePath);
    const filename = posix.basename(relativePath).toLocaleLowerCase('en-US');
    if (input.kind !== 'index' && filename !== '_index.md' && filename !== 'index.md') {
      continue;
    }
    const directory = posix.dirname(relativePath);
    const key = directoryKey(root.path, directory);
    const candidates = byDirectory.get(key) ?? [];
    candidates.push(input);
    byDirectory.set(key, candidates);
  }
  const preferred = new Map<string, PreferredIndex>();
  for (const [key, candidates] of byDirectory) {
    candidates.sort((left, right) => {
      const priority = indexPriority(right.sourcePath) - indexPriority(left.sourcePath);
      return priority || left.sourcePath.localeCompare(right.sourcePath);
    });
    const separator = key.indexOf('\u0000');
    preferred.set(key, {
      winner: candidates[0]!,
      candidates,
      rootPath: key.slice(0, separator),
      directory: key.slice(separator + 1),
    });
  }
  return preferred;
}

function isDocumentedIndexPair(candidates: RouteArticleInput[]): boolean {
  if (candidates.length <= 1) return true;
  if (candidates.length !== 2) return false;
  const filenames = candidates
    .map((candidate) =>
      posix.basename(candidate.sourcePath).toLocaleLowerCase('en-US'),
    )
    .sort();
  return filenames[0] === '_index.md' && filenames[1] === 'index.md';
}

function plannedSections(
  config: SiteConfigV1,
  articles: PlannedArticleRoute[],
  indexes: Map<string, PreferredIndex>,
  publicSourcePaths: Set<string>,
): PlannedSectionRoute[] {
  const sections = new Map<string, PlannedSectionRoute>();
  for (const article of articles) {
    if (!publicSourcePaths.has(article.sourcePath)) continue;
    const root = config.contentRoots.find((candidate) =>
      pathIsInside(article.sourcePath, candidate.path),
    );
    if (!root) continue;
    const directory = posix.dirname(posix.relative(root.path, article.sourcePath));
    const segments = directory === '.' ? [] : directory.split('/');
    for (let depth = 0; depth <= segments.length; depth += 1) {
      const ancestor = depth === 0 ? '.' : segments.slice(0, depth).join('/');
      const key = directoryKey(root.path, ancestor);
      const winner = indexes.get(key)?.winner;
      const normalizedDirectory = normalizeRelativeDirectory(ancestor);
      if (normalizedDirectory === undefined) continue;
      const url = sectionRoutePath(root.publicRoot, normalizedDirectory);
      sections.set(key, {
        directoryPath:
          ancestor === '.' ? root.path : posix.join(root.path, ancestor),
        url,
        ...(winner === undefined ? {} : { sourcePath: winner.sourcePath }),
        generated: winner === undefined,
      });
    }
  }
  return [...sections.values()].sort((left, right) =>
    left.directoryPath.localeCompare(right.directoryPath),
  );
}

function normalizeRoutingConfig(
  config: SiteConfigV1,
  issues: RouteIssue[],
): SiteConfigV1 {
  const contentRoots: SiteConfigV1['contentRoots'] = [];
  for (const root of config.contentRoots) {
    const publicRoot = normalizeRouteUrlPath(root.publicRoot);
    if (!publicRoot) {
      issues.push({
        severity: 'blocker',
        code: 'invalid-public-root',
        directoryPath: root.path,
        route: root.publicRoot,
        message: `Public root ${root.publicRoot} is not a safe canonical URL path.`,
      });
      continue;
    }
    contentRoots.push({ path: root.path, publicRoot });
  }
  return { ...config, contentRoots };
}

function directoryKey(rootPath: string, directory: string): string {
  return `${rootPath}\u0000${directory}`;
}

function indexPriority(sourcePath: string): number {
  const filename = posix.basename(sourcePath).toLocaleLowerCase('en-US');
  if (filename === '_index.md') return 2;
  if (filename === 'index.md') return 1;
  return 0;
}

function pathIsInside(sourcePath: string, rootPath: string): boolean {
  const pathFromRoot = posix.relative(rootPath, sourcePath);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith('../');
}

function routePath(
  publicRoot: string,
  relativeDirectory: string,
  slug: string,
): string {
  const segments = [publicRoot, relativeDirectory === '.' ? '' : relativeDirectory, slug]
    .flatMap((value) => value.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}/`;
}

function sectionRoutePath(publicRoot: string, relativeDirectory: string): string {
  const segments = [publicRoot, relativeDirectory === '.' ? '' : relativeDirectory]
    .flatMap((value) => value.split('/'))
    .filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

function normalizeSlug(slug: string): string | undefined {
  if (slug.length === 0 || slug !== slug.trim()) return undefined;
  if (/[\\/?#]/u.test(slug) || hasControlCharacter(slug) || slug.includes('..')) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(slug);
    const safe =
      decoded !== '.' &&
      decoded !== '..' &&
      !decoded.includes('%') &&
      !/[\\/?#]/u.test(decoded) &&
      !hasControlCharacter(decoded) &&
      !decoded.includes('..');
    return safe ? decoded.normalize('NFC') : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRelativeDirectory(directory: string): string | undefined {
  if (directory === '.') return '.';
  const normalized: string[] = [];
  for (const segment of directory.split('/')) {
    if (!segment || segment === '.' || segment === '..') return undefined;
    if (/[\\?#]/u.test(segment) || hasControlCharacter(segment)) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('%') ||
      /[\\/?#]/u.test(decoded) ||
      hasControlCharacter(decoded)
    ) {
      return undefined;
    }
    normalized.push(decoded.normalize('NFC'));
  }
  return normalized.join('/');
}

function normalizeOnlineUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/')) return normalizeRouteUrlPath(value);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return normalizeRouteUrlPath(parsed.pathname);
  } catch {
    return undefined;
  }
}
