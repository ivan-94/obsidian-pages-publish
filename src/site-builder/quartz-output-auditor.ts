import { extname } from 'node:path';
import type { PreviewAsset } from '../content/local-assets';
import type { QuartzRawBuildOutput } from './quartz-build-runner';
import type { QuartzStagingCompilation } from './quartz-staging-compiler';

export interface AuditedQuartzOutput {
  files: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, PreviewAsset>>;
}

export class QuartzOutputAuditError extends Error {
  readonly name = 'QuartzOutputAuditError';
  readonly code = 'quartz-output-audit-failed';
}

export function bridgeAndAuditQuartzOutput(
  raw: QuartzRawBuildOutput,
  staging: Readonly<QuartzStagingCompilation>,
): AuditedQuartzOutput {
  if (raw.sourceDigest !== staging.sourceDigest) {
    throw new QuartzOutputAuditError('Quartz output does not match the frozen staging input.');
  }
  const files: Record<string, string> = {};
  const assets: Record<string, PreviewAsset> = {};
  const routes = [
    ...staging.routeManifest.articles.map((article) => article.url),
    ...staging.routePlan.sections.map((section) => section.url),
    ...staging.routePlan.systemRoutes.filter((route) => route.endsWith('/')),
  ].sort((left, right) => right.length - left.length);

  for (const [rawPath, content] of Object.entries(raw.files)) {
    const outputPath = normalizeQuartzOutputPath(rawPath);
    if (files[outputPath] !== undefined || assets[outputPath] !== undefined) {
      throw new QuartzOutputAuditError(`Quartz output path ${outputPath} is duplicated.`);
    }
    const contentType = contentTypeForPath(outputPath);
    if (isTextContent(contentType)) {
      const source = sanitizeKnownQuartzOutput(
        rewriteRouteReferences(new TextDecoder('utf-8', { fatal: true }).decode(content), routes),
      );
      const remoteResource = contentType === 'text/html'
        ? remoteExecutableResource(source)
        : undefined;
      if (remoteResource) {
        throw new QuartzOutputAuditError(
          `Quartz output ${outputPath} contains a remote executable resource: ${remoteResource}`,
        );
      }
      files[outputPath] = source;
    } else {
      assets[outputPath] = { content, contentType };
    }
  }

  for (const redirect of staging.routePlan.redirects) {
    const path = routeOutputPath(redirect.from);
    if (files[path] !== undefined || assets[path] !== undefined) {
      throw new QuartzOutputAuditError(`Quartz redirect output ${path} conflicts with a page.`);
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
      throw new QuartzOutputAuditError(`Quartz did not emit the planned route ${route}.`);
    }
  }

  const allowedHtml = new Set(
    [...expectedRoutes].filter((route) => route.endsWith('/')).map(routeOutputPath),
  );
  for (const redirect of staging.routePlan.redirects) allowedHtml.add(routeOutputPath(redirect.from));
  for (const path of Object.keys(files).filter((path) => path.endsWith('.html'))) {
    if (!allowedHtml.has(path) && !path.startsWith('/tags/')) {
      throw new QuartzOutputAuditError(`Quartz emitted an unplanned HTML page at ${path}.`);
    }
  }

  auditUnlistedDiscovery(files, staging);
  return {
    files: Object.freeze(files),
    assets: Object.freeze(assets),
  };
}

function normalizeQuartzOutputPath(path: string): string {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new QuartzOutputAuditError('Quartz emitted an unsafe output path.');
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
  return source.replace(
    /<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com" crossorigin="anonymous"\s*\/?\s*>/giu,
    '',
  );
}

function auditUnlistedDiscovery(
  files: Readonly<Record<string, string>>,
  staging: Readonly<QuartzStagingCompilation>,
): void {
  const discoveryPaths = Object.keys(files).filter(
    (path) => path === '/sitemap.xml'
      || path === '/index.xml'
      || path === '/static/contentIndex.json'
      || path.startsWith('/tags/'),
  );
  for (const article of staging.routeManifest.articles) {
    if (article.visibility !== 'unlisted') continue;
    const routeToken = article.url.replace(/^\//u, '').replace(/\/$/u, '');
    for (const path of discoveryPaths) {
      if (files[path]?.includes(routeToken)) {
        throw new QuartzOutputAuditError(
          `The unlisted route ${article.url} leaked into Quartz discovery output.`,
        );
      }
    }
  }
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

function remoteExecutableResource(source: string): string | undefined {
  const script = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^>]*>/iu.exec(source)?.[0];
  if (script) return script;
  for (const match of source.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    if (!/\bhref\s*=\s*["']https?:\/\//iu.test(tag)) continue;
    const relation = /\brel\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]?.toLowerCase();
    if (relation !== 'canonical' && relation !== 'alternate') return tag;
  }
  return undefined;
}

function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
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
    || contentType === 'application/xml';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
