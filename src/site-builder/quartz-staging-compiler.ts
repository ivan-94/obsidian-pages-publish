import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadSiteConfigFromDirectory, type SiteConfigV1 } from '../config/site-config';
import {
  collectLocalPreviewAssets,
  type PreviewAsset,
} from '../content/local-assets';
import type { WebpDecoderBoundary } from '../content/webp-decoder';
import { createNoteReferenceResolver } from '../content/note-references';
import type {
  ArticleSourceSnapshot,
  PublicationVisibility,
} from '../publication/article-metadata';
import { loadDirectoryRouteSources } from '../routing/directory-route-sources';
import {
  planSiteRoutes,
  RoutePlanningError,
  type SiteRoutePlan,
} from '../routing/route-planner';

export interface QuartzRouteManifestArticle {
  sourcePath: string;
  url: string;
  visibility: Exclude<PublicationVisibility, 'private'>;
}

export interface QuartzStagingCompilation {
  config: Readonly<SiteConfigV1>;
  contentFiles: Readonly<Record<string, string>>;
  assetFiles: Readonly<Record<string, PreviewAsset>>;
  routePlan: Readonly<SiteRoutePlan>;
  routeManifest: Readonly<{
    articles: readonly QuartzRouteManifestArticle[];
    redirects: readonly SiteRoutePlan['redirects'][number][];
  }>;
  sourceDigest: string;
}

export async function compileQuartzStaging(
  vaultRoot: string,
  options: { webpDecoder?: WebpDecoderBoundary; previewSourcePath?: string } = {},
): Promise<Readonly<QuartzStagingCompilation>> {
  const loaded = await loadSiteConfigFromDirectory(vaultRoot);
  if (loaded.status !== 'editable') {
    throw new Error(`Site config version ${loaded.version} is read-only and cannot be staged.`);
  }
  const { snapshots, inputs } = await loadDirectoryRouteSources(vaultRoot, loaded.config);
  const routePlan = planSiteRoutes(
    loaded.config,
    inputs.map((input) => input.sourcePath === options.previewSourcePath
      ? { ...input, visibility: 'unlisted' }
      : input),
  );
  const blockers = routePlan.issues.filter((issue) => issue.severity === 'blocker');
  if (blockers.length > 0) throw new RoutePlanningError(blockers);
  const visiblePaths = new Set(routePlan.articles.map((article) => article.sourcePath));
  const assetPlan = await collectLocalPreviewAssets(
    vaultRoot,
    snapshots,
    loaded.config.assets.exclude,
    visiblePaths,
    {
      retainAssets: true,
      ...(options.webpDecoder === undefined ? {} : { webpDecoder: options.webpDecoder }),
    },
  );
  const assetBlockers = assetPlan.issues.filter(
    (issue) => issue.severity === 'blocker' && !issue.dormant,
  );
  if (assetBlockers.length > 0) {
    throw new Error(assetBlockers.map((issue) => issue.message).join('; '));
  }

  const routesBySource = new Map(
    routePlan.articles.map((article) => [article.sourcePath, article]),
  );
  const contentFiles: Record<string, string> = {};
  const routeArticles: QuartzRouteManifestArticle[] = [];
  for (const sourcePath of [...visiblePaths].sort()) {
    const snapshot = snapshots.get(sourcePath);
    const route = routesBySource.get(sourcePath);
    if (!snapshot || !route) continue;
    const visibility = snapshot.metadata.visibility.value === 'private'
      && sourcePath === options.previewSourcePath
      ? 'unlisted'
      : snapshot.metadata.visibility.value;
    if (visibility === 'private') continue;
    contentFiles[stagingPathForRoute(route.url)] = compileArticle(
      snapshot,
      route.url,
      visibility,
      assetPlan,
      snapshots,
      routePlan,
    );
    routeArticles.push({ sourcePath, url: route.url, visibility });
  }

  const assetEntries: Array<[string, PreviewAsset]> = Object.entries(assetPlan.assets)
    .map(([path, asset]): [string, PreviewAsset] => [
      path.replace(/^\//u, ''),
      Object.freeze({ ...asset }),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const assetFiles: Readonly<Record<string, PreviewAsset>> = Object.freeze(
    Object.fromEntries(assetEntries),
  );
  const routeManifest = Object.freeze({
    articles: Object.freeze(routeArticles.map((article) => Object.freeze(article))),
    redirects: Object.freeze(routePlan.redirects.map((redirect) => Object.freeze({ ...redirect }))),
  });
  const sourceDigest = createHash('sha256')
    .update(loaded.revision)
    .update('\0')
    .update(
      routeArticles
        .map((article) => `${article.sourcePath}\0${snapshots.get(article.sourcePath)?.contentDigest ?? ''}`)
        .join('\0'),
    )
    .update('\0')
    .update(
      Object.entries(assetFiles)
        .map(([path, asset]) => `${path}\0${createHash('sha256').update(asset.content).digest('hex')}`)
        .join('\0'),
    )
    .digest('hex');

  return Object.freeze({
    config: deepFreezeConfig(loaded.config),
    contentFiles: Object.freeze(contentFiles),
    assetFiles,
    routePlan: freezeRoutePlan(routePlan),
    routeManifest,
    sourceDigest,
  });
}

function stagingPathForRoute(url: string): string {
  const routePath = url.replace(/^\//u, '').replace(/\/$/u, '');
  return routePath.length === 0 ? 'index.md' : `${routePath}.md`;
}

function compileArticle(
  snapshot: ArticleSourceSnapshot,
  permalink: string,
  visibility: Exclude<PublicationVisibility, 'private'>,
  assetPlan: Awaited<ReturnType<typeof collectLocalPreviewAssets>>,
  snapshots: Map<string, ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
): string {
  const metadata = snapshot.metadata;
  const frontmatter = {
    title: metadata.title.value,
    permalink,
    ...(metadata.summary === undefined
      ? {}
      : { description: safeStagedDescription(metadata.summary.value) }),
    ...(metadata.date === undefined ? {} : { date: metadata.date.value }),
    ...(metadata.updated === undefined ? {} : { modified: metadata.updated.value }),
    ...(metadata.tags.value.length === 0 ? {} : { tags: metadata.tags.value }),
    ...(visibility === 'unlisted' ? { unlisted: true } : {}),
  };
  const body = rewriteSafeBody(snapshot, assetPlan, snapshots, routePlan);
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body.trimStart()}`;
}

function rewriteSafeBody(
  snapshot: ArticleSourceSnapshot,
  assetPlan: Awaited<ReturnType<typeof collectLocalPreviewAssets>>,
  snapshots: Map<string, ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
): string {
  const sourcePath = snapshot.sourcePath;
  let body = escapeRawHtmlTags(snapshot.body);
  body = body.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu,
    (markup, rawTarget: string, rawAlt: string | undefined) => {
      const target = rawTarget.trim();
      const output = assetPlan.resolveImage(sourcePath, target);
      if (output) return `![${(rawAlt ?? posix.basename(target)).trim()}](${output})`;
      if (assetPlan.shouldDegrade(sourcePath, target)) return rawAlt?.trim() ?? posix.basename(target);
      return markup;
    },
  );
  body = body.replace(
    /(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/gu,
    (markup, prefix: string, rawTarget: string, suffix: string) => {
      const output = assetPlan.resolveImage(sourcePath, rawTarget);
      if (output) return `${prefix}${output}${suffix}`;
      if (assetPlan.shouldDegrade(sourcePath, rawTarget)) return markup.replace(prefix, '').replace(suffix, '');
      return markup;
    },
  );
  const resolveNote = createNoteReferenceResolver(sourcePath, snapshots, routePlan);
  body = body.replace(
    /(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu,
    (_markup, embedMarker: string, target: string, alias: string | undefined) => {
      const resolution = resolveNote(target.trim(), alias?.trim(), embedMarker === '!');
      if (resolution.kind === 'link') {
        return `[${escapeMarkdownLabel(resolution.text)}](${resolution.url})`;
      }
      return escapeMarkdownLabel(resolution.text);
    },
  );
  return body;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/gu, '\\$&');
}

function safeStagedDescription(value: string): string {
  return escapeRawHtmlTags(value)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu, (_match, target: string, alias?: string) =>
      alias?.trim() || posix.basename(target.trim(), '.md'))
    .replace(/!?\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/[*_`>#]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function escapeRawHtmlTags(markdown: string): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/u.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(
        /<!--[\s\S]*?-->|<\s*\/?[A-Za-z][^>]*>/gu,
        (tag) => tag.replace(/</gu, '&lt;'),
      );
    })
    .join('\n');
}

function deepFreezeConfig(config: SiteConfigV1): Readonly<SiteConfigV1> {
  const copy = structuredClone(config);
  Object.freeze(copy.site);
  copy.contentRoots.forEach(Object.freeze);
  Object.freeze(copy.contentRoots);
  Object.freeze(copy.assets.exclude);
  Object.freeze(copy.assets);
  Object.freeze(copy.features);
  Object.freeze(copy.cloudflare);
  return Object.freeze(copy);
}

function freezeRoutePlan(routePlan: SiteRoutePlan): Readonly<SiteRoutePlan> {
  const copy = structuredClone(routePlan);
  copy.articles.forEach(Object.freeze);
  copy.sections.forEach(Object.freeze);
  copy.redirects.forEach(Object.freeze);
  copy.issues.forEach(Object.freeze);
  Object.freeze(copy.articles);
  Object.freeze(copy.sections);
  Object.freeze(copy.systemRoutes);
  Object.freeze(copy.redirects);
  Object.freeze(copy.issues);
  return Object.freeze(copy);
}
