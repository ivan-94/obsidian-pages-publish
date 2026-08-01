import type { SiteConfigV1 } from '../config/site-config';
import {
  collectPublicNoteLinks,
  type PublicNoteLink,
} from '../content/note-references';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';

export interface PublicDiscoveryPage {
  sourcePath: string;
  title: string;
  url: string;
  text: string;
}

export interface PublicGraphEdge {
  from: string;
  to: string;
}

export interface SiteDiscoveryProjection {
  canonicalOrigin: string;
  pages: PublicDiscoveryPage[];
  graphEdges: PublicGraphEdge[];
  sitemapXml: string;
}

export function createSiteDiscoveryProjection(
  config: SiteConfigV1,
  snapshots: Map<string, ArticleSourceSnapshot>,
  pages: readonly PublicDiscoveryPage[],
  indexablePaths: readonly string[] = pages.map((page) => page.url),
): SiteDiscoveryProjection {
  const publicPages = [...pages].sort(
    (left, right) => left.url.localeCompare(right.url),
  );
  const routes = new Map(publicPages.map((page) => [page.sourcePath, page.url]));
  const graphEdges = publicGraphEdges(collectPublicNoteLinks(snapshots), routes);
  const canonicalOrigin = siteCanonicalOrigin(config);
  return {
    canonicalOrigin,
    pages: publicPages,
    graphEdges,
    sitemapXml: renderSitemapXml(canonicalOrigin, indexablePaths),
  };
}

export function siteCanonicalOrigin(config: SiteConfigV1): string {
  return `https://${config.cloudflare.customDomain ?? `${config.cloudflare.projectName}.pages.dev`}`;
}

export function canonicalUrl(origin: string, path: string): string {
  return `${origin}${path === '/' ? '/' : path}`;
}

function publicGraphEdges(
  links: readonly PublicNoteLink[],
  routes: ReadonlyMap<string, string>,
): PublicGraphEdge[] {
  const seen = new Set<string>();
  const edges: PublicGraphEdge[] = [];
  for (const link of links) {
    const from = routes.get(link.sourcePath);
    const to = routes.get(link.targetPath);
    if (!from || !to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function renderSitemapXml(
  canonicalOrigin: string,
  paths: readonly string[],
): string {
  const urls = [...new Set(paths)]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => `  <url><loc>${escapeXml(canonicalUrl(canonicalOrigin, path))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
