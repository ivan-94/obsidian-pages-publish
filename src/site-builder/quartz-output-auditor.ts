import { extname } from 'node:path';
import type { PreviewAsset } from '../content/local-assets';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';
import { siteCanonicalOrigin } from '../site/discovery';
import type { QuartzRawBuildOutput } from './quartz-build-runner';
import type { QuartzStagingCompilation } from './quartz-staging-compiler';
import { quartzSlugRoute } from './quartz-route-bridge';

export interface AuditedQuartzOutput {
  files: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, PreviewAsset>>;
}

export class QuartzOutputAuditError extends Error {
  readonly name = 'QuartzOutputAuditError';

  constructor(
    readonly code:
      | 'quartz-output-invalid'
      | 'quartz-route-mismatch'
      | 'quartz-discovery-leak'
      | 'quartz-private-leak'
      | 'quartz-unexpected-network',
    message: string,
  ) {
    super(message);
  }
}

export interface QuartzOutputAuditPolicy {
  forbiddenText: readonly string[];
}

export function createQuartzOutputAuditPolicy(
  vaultRoot: string,
  snapshots: ReadonlyMap<string, ArticleSourceSnapshot>,
  options: { allowedPrivateSourcePath?: string } = {},
): QuartzOutputAuditPolicy {
  const forbidden = new Set<string>([vaultRoot]);
  for (const snapshot of snapshots.values()) {
    if (
      snapshot.metadata.visibility.value !== 'private'
      || snapshot.sourcePath === options.allowedPrivateSourcePath
    ) {
      continue;
    }
    addDistinctiveToken(forbidden, snapshot.sourcePath);
    addDistinctiveToken(forbidden, snapshot.metadata.title.value);
    addDistinctiveToken(forbidden, snapshot.metadata.slug.value);
    snapshot.metadata.tags.value.forEach((tag) => addDistinctiveToken(forbidden, tag));
    const deployment = snapshot.metadata.deployment;
    for (const value of [deployment?.url, deployment?.deploymentId, deployment?.sourceDigest]) {
      if (value) forbidden.add(value);
    }
    for (const token of snapshot.body.match(/[A-Za-z0-9][A-Za-z0-9_-]{15,}/gu) ?? []) {
      forbidden.add(token);
    }
  }
  return {
    forbiddenText: Object.freeze(
      [...forbidden]
        .map((value) => value.trim())
        .filter((value) => value.length >= 4)
        .sort((left, right) => right.length - left.length || left.localeCompare(right)),
    ),
  };
}

function addDistinctiveToken(target: Set<string>, value: string): void {
  const normalized = value.trim();
  // Short/common metadata values (for example `private`) cannot be used as
  // substring canaries without rejecting unrelated public prose or Quartz
  // runtime code. Paths, multi-word titles, UUID-like slugs, and explicit
  // high-entropy body tokens remain useful deterministic leak sentinels.
  if (normalized.length >= 12 || /[\\/\s]/u.test(normalized)) target.add(normalized);
}

export function bridgeAndAuditQuartzOutput(
  raw: QuartzRawBuildOutput,
  staging: Readonly<QuartzStagingCompilation>,
  policy: QuartzOutputAuditPolicy = { forbiddenText: [] },
): AuditedQuartzOutput {
  if (raw.sourceDigest !== staging.sourceDigest) {
    throw new QuartzOutputAuditError(
      'quartz-output-invalid',
      'Quartz output does not match the frozen staging input.',
    );
  }
  const files: Record<string, string> = {};
  const assets: Record<string, PreviewAsset> = {};
  const routeBridges = createRouteBridges(staging);
  const outputPathBridges = new Map(
    routeBridges.map((bridge) => [routeOutputPath(bridge.quartz), routeOutputPath(bridge.planned)]),
  );
  const emittedDirectoryRoutes = Object.keys(raw.files).flatMap((rawPath) => {
    const normalized = normalizeQuartzOutputPath(rawPath);
    const output = outputPathBridges.get(normalized) ?? normalized;
    return output.endsWith('/index.html')
      ? [output.slice(0, -'index.html'.length)]
      : [];
  });
  const routes = [...new Set([
    ...staging.routeManifest.articles.map((article) => article.url),
    ...staging.routePlan.sections.map((section) => section.url),
    ...staging.routePlan.systemRoutes.filter((route) => route.endsWith('/')),
    ...emittedDirectoryRoutes,
  ])].sort((left, right) => right.length - left.length);

  for (const [rawPath, content] of Object.entries(raw.files)) {
    if (isDisabledQuartzComponentArtifact(rawPath)) continue;
    const normalizedOutputPath = normalizeQuartzOutputPath(rawPath);
    const outputPath = outputPathBridges.get(normalizedOutputPath) ?? normalizedOutputPath;
    auditEphemeralPathLeak(outputPath, content, raw.forbiddenOutputText ?? []);
    auditForbiddenContent(outputPath, content, policy);
    if (files[outputPath] !== undefined || assets[outputPath] !== undefined) {
      throw new QuartzOutputAuditError(
        'quartz-output-invalid',
        `Quartz output path ${outputPath} is duplicated.`,
      );
    }
    const contentType = contentTypeForPath(outputPath);
    if (isTextContent(contentType)) {
      let source = new TextDecoder('utf-8', { fatal: true }).decode(content);
      source = rebaseQuartzHtmlReferences(rawPath, source, contentType);
      source = rewriteQuartzRouteReferences(source, routeBridges);
      source = rewriteRouteReferences(source, routes);
      source = sanitizeKnownQuartzOutput(source);
      source = stabilizeKnownQuartzOutput(outputPath, source);
      source = sanitizeUnlistedHtmlNavigation(outputPath, source, staging);
      source = ensureControlledHtmlMetadata(outputPath, source, staging);
      source = sanitizeQuartzDiscoveryOutput(outputPath, source, staging);
      const remoteResource = remoteRuntimeResource(source, contentType);
      if (remoteResource) {
        throw new QuartzOutputAuditError(
          'quartz-unexpected-network',
          `Quartz output ${outputPath} contains a remote executable resource: ${remoteResource}`,
        );
      }
      files[outputPath] = source;
    } else {
      assets[outputPath] = { content, contentType };
    }
  }

  for (const [path, source] of Object.entries(files)) {
    if (!/(?:static\/giscus|giscus\.app)/iu.test(source)) continue;
    throw new QuartzOutputAuditError(
      'quartz-unexpected-network',
      `Quartz output ${path} references the disabled comments integration.`,
    );
  }

  for (const redirect of staging.routePlan.redirects) {
    const path = routeOutputPath(redirect.from);
    if (files[path] !== undefined || assets[path] !== undefined) {
      throw new QuartzOutputAuditError(
        'quartz-route-mismatch',
        `Quartz redirect output ${path} conflicts with a page.`,
      );
    }
    files[path] = redirectDocument(redirect.to);
  }

  const expectedRoutes = new Set([
    ...staging.routeManifest.articles.map((article) => article.url),
    ...staging.routePlan.sections.map((section) => section.url),
    ...staging.routePlan.systemRoutes,
  ]);
  for (const route of expectedRoutes) {
    const path = routeOutputPath(route);
    if (files[path] === undefined && assets[path] === undefined) {
      const emittedHtml = Object.keys(files)
        .filter((candidate) => candidate.endsWith('.html'))
        .slice(0, 40)
        .join(', ');
      throw new QuartzOutputAuditError(
        'quartz-route-mismatch',
        `Quartz did not emit the planned route ${route}. Emitted HTML: ${emittedHtml}`,
      );
    }
  }

  const allowedHtml = new Set(
    [...expectedRoutes].filter((route) => route.endsWith('/')).map(routeOutputPath),
  );
  for (const redirect of staging.routePlan.redirects) allowedHtml.add(routeOutputPath(redirect.from));
  for (const path of Object.keys(files).filter((path) => path.endsWith('.html'))) {
    if (!allowedHtml.has(path) && !path.startsWith('/tags/')) {
      throw new QuartzOutputAuditError(
        'quartz-route-mismatch',
        `Quartz emitted an unplanned HTML page at ${path}.`,
      );
    }
  }

  auditInternalHtmlReferences(files, assets, staging);
  auditUnlistedDiscovery(files, staging);
  return {
    files: Object.freeze(files),
    assets: Object.freeze(assets),
  };
}

function auditInternalHtmlReferences(
  files: Readonly<Record<string, string>>,
  assets: Readonly<Record<string, PreviewAsset>>,
  staging: Readonly<QuartzStagingCompilation>,
): void {
  const origin = siteCanonicalOrigin(staging.config);
  const outputPaths = new Set([...Object.keys(files), ...Object.keys(assets)]);
  for (const [outputPath, source] of Object.entries(files)) {
    if (!outputPath.endsWith('.html')) continue;
    for (const match of source.matchAll(
      /(?<![-\w])\b(?:href|src|poster|action)\s*=\s*["']([^"']+)["']/giu,
    )) {
      const reference = decodeXmlText(match[1] ?? '');
      if (reference.startsWith('#')) continue;
      let target: URL;
      try {
        target = new URL(reference, `${origin}${outputPath}`);
      } catch {
        throw new QuartzOutputAuditError(
          'quartz-route-mismatch',
          `Quartz output ${outputPath} contains an invalid internal reference.`,
        );
      }
      if (['javascript:', 'file:'].includes(target.protocol)) {
        throw new QuartzOutputAuditError(
          'quartz-output-invalid',
          `Quartz output ${outputPath} contains an unsafe URL protocol.`,
        );
      }
      if (target.origin !== origin) continue;
      let pathname: string;
      try {
        pathname = decodeURIComponent(target.pathname);
      } catch {
        throw new QuartzOutputAuditError(
          'quartz-route-mismatch',
          `Quartz output ${outputPath} contains an invalid encoded path.`,
        );
      }
      const targetPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      if (!outputPaths.has(targetPath)) {
        throw new QuartzOutputAuditError(
          'quartz-route-mismatch',
          `Quartz output ${outputPath} links to missing output ${pathname}.`,
        );
      }
    }
  }
}

function rebaseQuartzHtmlReferences(
  rawPath: string,
  source: string,
  contentType: string,
): string {
  if (contentType !== 'text/html') return source;
  const origin = 'https://pages-publish.invalid';
  const base = `${origin}/${rawPath}`;
  const rebase = (value: string): string => {
    if (value.length === 0 || value.startsWith('#')) return value;
    const decoded = decodeXmlText(value);
    try {
      const target = new URL(decoded, base);
      if (target.origin !== origin) return decoded;
      return `${target.pathname}${target.search}${target.hash}`;
    } catch {
      return decoded;
    }
  };
  const attributesRebased = source.replace(
      /(?<![-\w])\b(href|src|poster|action)\s*=\s*(["'])([^"']*)\2/giu,
      (_attribute, name: string, quote: string, value: string) =>
        `${name}=${quote}${escapeHtmlAttribute(rebase(value))}${quote}`,
    );
  return attributesRebased.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, (script) =>
    script.replace(
        /(\b(?:fetch|import)\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/gu,
        (_call, prefix: string, quote: string, value: string) =>
          `${prefix}${quote}${escapeJavaScriptString(rebase(value), quote)}${quote}`,
      ));
}

function stabilizeKnownQuartzOutput(outputPath: string, source: string): string {
  if (outputPath === '/sitemap.xml') {
    return source.replace(/\s*<lastmod>[^<]*<\/lastmod>/gu, '');
  }
  return source;
}

function ensureControlledHtmlMetadata(
  outputPath: string,
  source: string,
  staging: Readonly<QuartzStagingCompilation>,
): string {
  if (!outputPath.endsWith('.html')) return source;
  const plannedRoutes = [
    ...staging.routeManifest.articles.map((article) => article.url),
    ...staging.routePlan.sections.map((section) => section.url),
    ...staging.routePlan.systemRoutes.filter((route) => route.endsWith('/')),
  ];
  const route = plannedRoutes.find((candidate) => routeOutputPath(candidate) === outputPath)
    ?? (outputPath.startsWith('/tags/') && outputPath.endsWith('/index.html')
      ? outputPath.slice(0, -'index.html'.length)
      : undefined);
  if (route === undefined) return source;
  const canonical = `${siteCanonicalOrigin(staging.config)}${route}`;
  const controlled = source.replace(
    /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*\bcanonical\b[^"']*["'])[^>]*>/giu,
    '',
  );
  const metadata = [`<link rel="canonical" href="${escapeHtmlAttribute(encodeURI(canonical))}"/>`];
  const unlisted = staging.routeManifest.articles.some((article) =>
    article.visibility === 'unlisted' && article.url === route);
  if (unlisted && !/<meta\b(?=[^>]*\bname\s*=\s*["']robots["'])(?=[^>]*\bcontent\s*=\s*["'][^"']*\bnoindex\b)[^>]*>/iu.test(controlled)) {
    metadata.push('<meta name="robots" content="noindex"/>');
  }
  const insertion = metadata.join('');
  if (/<\/head>/iu.test(controlled)) {
    return controlled.replace(/<\/head>/iu, `${insertion}</head>`);
  }
  if (/<html\b[^>]*>/iu.test(controlled)) {
    return controlled.replace(/<html\b[^>]*>/iu, (tag) => `${tag}<head>${insertion}</head>`);
  }
  return `${insertion}${controlled}`;
}

function sanitizeUnlistedHtmlNavigation(
  outputPath: string,
  source: string,
  staging: Readonly<QuartzStagingCompilation>,
): string {
  if (!outputPath.endsWith('.html')) return source;
  const unlistedRoutes = new Set(
    staging.routeManifest.articles
      .filter((article) => article.visibility === 'unlisted')
      .map((article) => normalizeRoutePath(article.url)),
  );
  const unlistedRouteTokens = [...unlistedRoutes]
    .map((route) => route.replace(/^\//u, ''));
  if (unlistedRoutes.size === 0) return source;
  const origin = siteCanonicalOrigin(staging.config);
  const pageUrl = outputPath === '/index.html'
    ? `${origin}/`
    : `${origin}${outputPath.replace(/index\.html$/u, '')}`;
  return source
    .split(/(<article\b[^>]*>[\s\S]*?<\/article>)/giu)
    .map((segment) => /^<article\b/iu.test(segment)
      ? segment
      : segment.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/giu,
        (anchor, href: string) => {
          try {
            const decodedHref = decodeURIComponent(decodeXmlText(href));
            if (unlistedRouteTokens.some((token) => containsRouteToken(decodedHref, token))) {
              return '';
            }
            const target = new URL(decodedHref, pageUrl);
            if (target.origin !== origin) return anchor;
            const route = normalizeRoutePath(decodeURIComponent(target.pathname));
            return unlistedRoutes.has(route) ? '' : anchor;
          } catch {
            return anchor;
          }
        }))
    .join('');
}

function sanitizeQuartzDiscoveryOutput(
  outputPath: string,
  source: string,
  staging: Readonly<QuartzStagingCompilation>,
): string {
  if (outputPath === '/sitemap.xml') {
    return redactUnlistedSitemapEntries(source, staging);
  }
  if (outputPath !== '/static/contentIndex.json') return source;
  const unlisted = staging.routeManifest.articles
    .filter((article) => article.visibility === 'unlisted');
  const routeTokens = unlisted
    .flatMap((article) => [article.url, article.quartzRoute])
    .filter((token): token is string => token !== undefined)
    .map(normalizeContentIndexSlug)
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length);
  const textTokens = unlisted
    .flatMap((article) => [article.sourcePath, article.title])
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length);
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Unexpected content index shape.');
    }
    const pageEntries = Object.entries(parsed).filter(([slug]) =>
      !unlisted.some((article) => contentIndexSlugMatchesArticle(slug, article)));
    return JSON.stringify(redactDiscoveryValue(
      Object.fromEntries(pageEntries),
      routeTokens,
      textTokens,
    ));
  } catch {
    throw new QuartzOutputAuditError(
      'quartz-output-invalid',
      'Quartz emitted an invalid content search index.',
    );
  }
}

function contentIndexSlugMatchesArticle(
  slug: string,
  article: QuartzStagingCompilation['routeManifest']['articles'][number],
): boolean {
  const normalizedSlug = normalizeContentIndexSlug(slug);
  const candidates = [article.url, article.quartzRoute]
    .filter((route): route is string => route !== undefined)
    .map(normalizeContentIndexSlug);
  return candidates.some((candidate) =>
    normalizedSlug === candidate
    || (article.kind === 'index' && normalizedSlug === `${candidate}/index`));
}

function normalizeContentIndexSlug(route: string): string {
  return route.replace(/^\/+|\/+$/gu, '');
}

function redactUnlistedSitemapEntries(
  source: string,
  staging: Readonly<QuartzStagingCompilation>,
): string {
  const routes = new Set(
    staging.routeManifest.articles
      .filter((article) => article.visibility === 'unlisted')
      .map((article) => normalizeRoutePath(article.url)),
  );
  return source.replace(/<url>[^]*?<\/url>/gu, (entry) => {
    const location = /<loc>([^<]+)<\/loc>/u.exec(entry)?.[1];
    if (location === undefined) return entry;
    try {
      const pathname = new URL(decodeXmlText(location)).pathname;
      return routes.has(normalizeRoutePath(decodeURIComponent(pathname))) ? '' : entry;
    } catch {
      throw new QuartzOutputAuditError(
        'quartz-output-invalid',
        'Quartz emitted an invalid sitemap location.',
      );
    }
  });
}

function normalizeRoutePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '');
}

function decodeXmlText(source: string): string {
  return source
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function redactDiscoveryValue(
  value: unknown,
  routeTokens: readonly string[],
  textTokens: readonly string[],
): unknown {
  if (typeof value === 'string') {
    const withoutRoutes = routeTokens.reduce(redactRouteToken, value);
    return textTokens.reduce((output, token) => output.replaceAll(token, ''), withoutRoutes);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiscoveryValue(entry, routeTokens, textTokens));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDiscoveryValue(entry, routeTokens, textTokens),
      ]),
    );
  }
  return value;
}

function redactRouteToken(source: string, token: string): string {
  let output = '';
  let cursor = 0;
  let offset = source.indexOf(token);
  while (offset >= 0) {
    const prefix = source.slice(0, offset);
    const suffix = source.slice(offset + token.length);
    if (routeTokenStartsHere(prefix) && routeTokenEndsHere(suffix)) {
      output += source.slice(cursor, offset);
      cursor = offset + token.length;
    }
    offset = source.indexOf(token, offset + token.length);
  }
  return output + source.slice(cursor);
}

interface RouteBridge {
  quartz: string;
  planned: string;
}

function createRouteBridges(
  staging: Readonly<QuartzStagingCompilation>,
): RouteBridge[] {
  const bridges: RouteBridge[] = [
    ...staging.routeManifest.articles.map((article) => ({
      quartz: article.quartzRoute ?? quartzSlugRoute(article.url),
      planned: article.url,
    })),
    ...staging.routePlan.sections.map((section) => ({
      quartz: quartzSlugRoute(section.url),
      planned: section.url,
    })),
    ...staging.routePlan.systemRoutes
      .filter((route) => route.endsWith('/'))
      .map((route) => ({ quartz: quartzSlugRoute(route), planned: route })),
  ];
  const byQuartzOutput = new Map<string, string>();
  for (const bridge of bridges) {
    const output = routeOutputPath(bridge.quartz);
    const existing = byQuartzOutput.get(output);
    if (existing !== undefined && existing !== bridge.planned) {
      throw new QuartzOutputAuditError(
        'quartz-route-mismatch',
        `Quartz maps multiple planned routes onto ${bridge.quartz}.`,
      );
    }
    byQuartzOutput.set(output, bridge.planned);
  }
  return bridges.sort((left, right) => right.quartz.length - left.quartz.length);
}

function rewriteQuartzRouteReferences(source: string, bridges: readonly RouteBridge[]): string {
  let output = source;
  for (const bridge of bridges) {
    if (bridge.quartz === bridge.planned) continue;
    const quartzAbsolute = bridge.quartz.replace(/\/$/u, '');
    const plannedAbsolute = bridge.planned.replace(/\/$/u, '');
    output = output.replaceAll(encodeURI(quartzAbsolute), encodeURI(bridge.planned));
    output = output.replace(
      new RegExp(`${escapeRegExp(quartzAbsolute)}(?!/)(?=["'<>#?\\s])`, 'gu'),
      plannedAbsolute,
    );
    const quartzRelative = quartzAbsolute.replace(/^\//u, '');
    const plannedRelative = plannedAbsolute.replace(/^\//u, '');
    output = output.replace(
      new RegExp(`(?<=["'])${escapeRegExp(quartzRelative)}(?=["'])`, 'gu'),
      plannedRelative,
    );
  }
  return output;
}

function isDisabledQuartzComponentArtifact(path: string): boolean {
  return /^static\/giscus\//u.test(path);
}

function normalizeQuartzOutputPath(path: string): string {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new QuartzOutputAuditError(
      'quartz-output-invalid',
      'Quartz emitted an unsafe output path.',
    );
  }
  if (path === 'index.html') return '/index.html';
  if (path.endsWith('/index.html')) return `/${path}`;
  if (path.endsWith('.html')) return `/${path.slice(0, -'.html'.length)}/index.html`;
  return `/${path}`;
}

function routeOutputPath(route: string): string {
  if (route === '/') return '/index.html';
  if (route.endsWith('/')) return `${route}index.html`;
  return route;
}

function rewriteRouteReferences(source: string, routes: readonly string[]): string {
  let output = source;
  for (const route of routes) {
    if (route === '/') continue;
    const withoutSlash = route.slice(0, -1);
    output = output.replace(
      new RegExp(`${escapeRegExp(withoutSlash)}(?!/)(?=["'<>#?\\s])`, 'gu'),
      route,
    );
  }
  return output;
}

function sanitizeKnownQuartzOutput(source: string): string {
  return source
    .replace(
      /<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com" crossorigin="anonymous"\s*\/?\s*>/giu,
      '',
    )
    .replace(
      /<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:og:image(?::(?:url|type|alt))?|twitter:image)["'])[^>]*>/giu,
      '',
    );
}

function auditUnlistedDiscovery(
  files: Readonly<Record<string, string>>,
  staging: Readonly<QuartzStagingCompilation>,
): void {
  const fullDiscoveryPaths = Object.keys(files).filter(
    (path) => path === '/sitemap.xml'
      || path === '/index.xml'
      || path === '/static/contentIndex.json'
      || path === '/index.html'
      || path === '/search/index.html'
      || path === '/graph/index.html'
      || staging.routePlan.sections.some((section) => path === routeOutputPath(section.url))
      || path.startsWith('/tags/'),
  );
  const publicArticlePaths = new Set(
    staging.routeManifest.articles
      .filter((article) => article.visibility === 'public')
      .map((article) => routeOutputPath(article.url)),
  );
  const discoverySurfaces = [
    ...fullDiscoveryPaths.map((path) => ({ path, source: files[path] ?? '' })),
    ...[...publicArticlePaths]
      .filter((path) => !fullDiscoveryPaths.includes(path) && files[path] !== undefined)
      .map((path) => ({ path, source: removeAuthoredArticleContent(files[path] ?? '') })),
  ];
  for (const article of staging.routeManifest.articles) {
    if (article.visibility !== 'unlisted') continue;
    const routeToken = article.url.replace(/^\//u, '').replace(/\/$/u, '');
    const textTokens = [article.title, article.sourcePath]
      .filter((token) => token.length >= 2);
    for (const { path, source } of discoverySurfaces) {
      if (path === routeOutputPath(article.url)) continue;
      const leakedToken = containsRouteToken(source, routeToken)
        ? routeToken
        : textTokens.find((token) => source.includes(token));
      if (leakedToken !== undefined) {
        throw new QuartzOutputAuditError(
          'quartz-discovery-leak',
          `The unlisted route ${article.url} leaked into Quartz discovery output ${path} through ${JSON.stringify(leakedToken)}.`,
        );
      }
    }
  }
}

function removeAuthoredArticleContent(source: string): string {
  return source.replace(/<article\b[^>]*>[\s\S]*?<\/article>/giu, '');
}

function containsRouteToken(source: string, token: string): boolean {
  if (token.length < 2) return false;
  let offset = source.indexOf(token);
  while (offset >= 0) {
    const prefix = source.slice(0, offset);
    const suffix = source.slice(offset + token.length);
    if (routeTokenStartsHere(prefix) && routeTokenEndsHere(suffix)) return true;
    offset = source.indexOf(token, offset + token.length);
  }
  return false;
}

function routeTokenStartsHere(prefix: string): boolean {
  if (prefix.length === 0) return true;
  return /[\s"'<>#?/.=:(]/u.test(prefix.at(-1) ?? '');
}

function routeTokenEndsHere(suffix: string): boolean {
  if (suffix.length === 0) return true;
  if (suffix[0] !== '/') return isRouteDelimiter(suffix[0]);
  return suffix.length === 1 || isRouteDelimiter(suffix[1]);
}

function isRouteDelimiter(character: string | undefined): boolean {
  return character === undefined || /[\s"'<>#?]/u.test(character);
}

function redirectDocument(target: string): string {
  const escaped = target.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
    `<link rel="canonical" href="${escaped}">`,
    '<meta name="robots" content="noindex">',
    '</head><body></body></html>',
  ].join('');
}

function remoteRuntimeResource(source: string, contentType: string): string | undefined {
  if (contentType === 'text/css') {
    return /(?:@import\s+|url\(\s*)["']?https?:\/\/[^\s"')]+/iu.exec(source)?.[0];
  }
  if (contentType === 'text/javascript' || contentType === 'application/json') {
    return /(?:\b(?:import|fetch)\s*\(|\b(?:WebSocket|EventSource|Worker)\s*\()\s*["'`]https?:\/\/[^\s"'`)]+/iu.exec(source)?.[0]
      ?? /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid\//iu.exec(source)?.[0];
  }
  if (contentType !== 'text/html') return undefined;
  const script = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^>]*>/iu.exec(source)?.[0];
  if (script) return script;
  const embed = /<(?:iframe|object|embed|video|audio|source)\b[^>]*>/iu.exec(source)?.[0];
  if (embed) return embed;
  for (const match of source.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    if (!/\bhref\s*=\s*["']https?:\/\//iu.test(tag)) continue;
    const relation = /\brel\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]?.toLowerCase();
    if (relation !== 'canonical' && relation !== 'alternate') return tag;
  }
  return undefined;
}

function auditForbiddenContent(
  outputPath: string,
  content: Uint8Array,
  policy: QuartzOutputAuditPolicy,
): void {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  for (const token of policy.forbiddenText) {
    if (bytes.indexOf(Buffer.from(token, 'utf8')) < 0) continue;
    throw new QuartzOutputAuditError(
      'quartz-private-leak',
      `Quartz output ${outputPath} contains data outside the publication boundary.`,
    );
  }
}

function auditEphemeralPathLeak(
  outputPath: string,
  content: Uint8Array,
  forbiddenText: readonly string[],
): void {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  const tokens = forbiddenText.flatMap((token) => [token, encodeURI(token)]);
  for (const token of new Set(tokens)) {
    if (token.length === 0 || bytes.indexOf(Buffer.from(token, 'utf8')) < 0) continue;
    throw new QuartzOutputAuditError(
      'quartz-output-invalid',
      `Quartz output ${outputPath} contains an ephemeral build path.`,
    );
  }
}

function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };
  return types[extension] ?? 'application/octet-stream';
}

function isTextContent(contentType: string): boolean {
  return contentType.startsWith('text/')
    || contentType === 'application/json'
    || contentType === 'application/xml'
    || contentType === 'application/manifest+json';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;');
}

function escapeJavaScriptString(value: string, quote: string): string {
  const escaped = value.replaceAll('\\', '\\\\');
  return quote === '"' ? escaped.replaceAll('"', '\\"') : escaped.replaceAll("'", "\\'");
}
