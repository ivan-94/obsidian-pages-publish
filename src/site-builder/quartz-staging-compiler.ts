import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadSiteConfigFromDirectory, type SiteConfigV1 } from '../config/site-config';
import {
  collectLocalPreviewAssets,
  type PreviewAsset,
} from '../content/local-assets';
import { renderSafeMermaid } from '../content/mermaid';
import type { WebpDecoderBoundary } from '../content/webp-decoder';
import {
  createNoteReferenceResolver,
  NOTE_EMBED_LIMITS,
} from '../content/note-references';
import { removeUnsupportedSyntax } from '../content/unsupported-syntax';
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
import { quartzRouteForContentPath, quartzSlugRoute } from './quartz-route-bridge';
import { quartzSectionListingMarkdown } from './quartz-listing';

export interface QuartzRouteManifestArticle {
  sourcePath: string;
  title: string;
  url: string;
  visibility: Exclude<PublicationVisibility, 'private'>;
  kind: 'article' | 'index';
  date?: string;
  order?: number;
  /** Internal Quartz URL before the output bridge restores the planned URL. */
  quartzRoute?: string;
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
  options: {
    webpDecoder?: WebpDecoderBoundary;
    previewSourcePath?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Readonly<QuartzStagingCompilation>> {
  options.signal?.throwIfAborted();
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.webpDecoder === undefined ? {} : { webpDecoder: options.webpDecoder }),
    },
  );
  const assetBlockers = assetPlan.issues.filter(
    (issue) => issue.severity === 'blocker' && !issue.dormant,
  );
  if (assetBlockers.length > 0) {
    throw new Error(assetBlockers.map((issue) => issue.message).join('; '));
  }
  options.signal?.throwIfAborted();

  const routesBySource = new Map(
    routePlan.articles.map((article) => [article.sourcePath, article]),
  );
  const sectionIndexSources = new Set(
    routePlan.sections.flatMap((section) =>
      section.sourcePath === undefined ? [] : [section.sourcePath]),
  );
  const sectionRoutes = new Set(routePlan.sections.map((section) => section.url));
  const contentFiles: Record<string, string> = {};
  const generatedAssets: Record<string, PreviewAsset> = {};
  const routeArticles: QuartzRouteManifestArticle[] = [];
  const stagingPathsBySource = new Map<string, string>();
  const quartzRouteCounts = new Map<string, number>();
  for (const route of routePlan.articles) {
    const quartzRoute = quartzSlugRoute(route.url);
    quartzRouteCounts.set(quartzRoute, (quartzRouteCounts.get(quartzRoute) ?? 0) + 1);
  }
  for (const sourcePath of [...visiblePaths].sort()) {
    const snapshot = snapshots.get(sourcePath);
    const route = routesBySource.get(sourcePath);
    if (!snapshot || !route) continue;
    const visibility = snapshot.metadata.visibility.value === 'private'
      && sourcePath === options.previewSourcePath
      ? 'unlisted'
      : snapshot.metadata.visibility.value;
    if (visibility === 'private') continue;
    const kind = sectionIndexSources.has(sourcePath)
      ? 'index'
      : snapshot.metadata.kind.value;
    const defaultStagingPath = stagingPathForRoute(route.url, sectionRoutes);
    const stagingPath = (quartzRouteCounts.get(quartzSlugRoute(route.url)) ?? 0) > 1
      && kind !== 'index'
      ? collisionSafeStagingPath(sourcePath, route.url)
      : defaultStagingPath;
    contentFiles[stagingPath] = compileArticle(
      snapshot,
      route.url,
      visibility,
      assetPlan,
      snapshots,
      routePlan,
      generatedAssets,
    );
    stagingPathsBySource.set(sourcePath, stagingPath);
    routeArticles.push({
      sourcePath,
      title: snapshot.metadata.title.value,
      url: route.url,
      visibility,
      kind,
      quartzRoute: quartzRouteForContentPath(stagingPath),
      ...(snapshot.metadata.date === undefined
        ? {}
        : { date: snapshot.metadata.date.value }),
      ...(snapshot.metadata.order === undefined
        ? {}
        : { order: snapshot.metadata.order.value }),
    });
  }

  for (const article of routeArticles) {
    if (article.kind !== 'index') continue;
    const stagingPath = stagingPathsBySource.get(article.sourcePath);
    if (stagingPath === undefined) continue;
    const listing = quartzSectionListingMarkdown(routeArticles, article.url);
    if (listing.length === 0) continue;
    contentFiles[stagingPath] = `${contentFiles[stagingPath]?.trimEnd()}\n\n${listing}\n`;
  }

  const assetEntries: Array<[string, PreviewAsset]> = Object.entries({
    ...assetPlan.assets,
    ...generatedAssets,
  })
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

function collisionSafeStagingPath(sourcePath: string, route: string): string {
  const digest = createHash('sha256')
    .update(sourcePath)
    .update('\0')
    .update(route)
    .digest('hex');
  return `pages-publish-route-${digest}.md`;
}

function stagingPathForRoute(url: string, sectionRoutes: ReadonlySet<string>): string {
  const routePath = url.replace(/^\//u, '').replace(/\/$/u, '');
  if (routePath.length === 0) return 'index.md';
  return sectionRoutes.has(url) ? `${routePath}/index.md` : `${routePath}.md`;
}

function compileArticle(
  snapshot: ArticleSourceSnapshot,
  permalink: string,
  visibility: Exclude<PublicationVisibility, 'private'>,
  assetPlan: Awaited<ReturnType<typeof collectLocalPreviewAssets>>,
  snapshots: Map<string, ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  generatedAssets: Record<string, PreviewAsset>,
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
    ...(metadata.cover === undefined
      ? {}
      : { cover: assetPlan.resolveImage(snapshot.sourcePath, metadata.cover.value) }),
    ...(visibility === 'unlisted' ? { unlisted: true } : {}),
  };
  const body = rewriteSafeBody(
    snapshot,
    visibility,
    assetPlan,
    snapshots,
    routePlan,
    generatedAssets,
    {
      ancestors: new Set(),
      depth: 0,
      budget: { expansions: 0, outputCharacters: 0 },
    },
  );
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body.trimStart()}`;
}

function rewriteSafeBody(
  snapshot: ArticleSourceSnapshot,
  effectiveVisibility: Exclude<PublicationVisibility, 'private'>,
  assetPlan: Awaited<ReturnType<typeof collectLocalPreviewAssets>>,
  snapshots: Map<string, ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  generatedAssets: Record<string, PreviewAsset>,
  state: EmbedRewriteState,
): string {
  const sourcePath = snapshot.sourcePath;
  const nextAncestors = new Set(state.ancestors);
  nextAncestors.add(sourcePath);
  let body = rewriteControlledMermaid(
    removeUnsupportedSyntax(snapshot.body),
    generatedAssets,
  );
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
  const resolveNote = createNoteReferenceResolver(sourcePath, snapshots, routePlan, {
    renderEmbed: (targetPath) => {
      const target = snapshots.get(targetPath);
      if (
        !target
        || target.metadata.visibility.value === 'private'
        || effectiveVisibility === 'public'
          && target.metadata.visibility.value !== 'public'
        || nextAncestors.has(targetPath)
        || state.depth >= NOTE_EMBED_LIMITS.maxDepth
        || state.budget.expansions >= NOTE_EMBED_LIMITS.maxExpansions
      ) {
        return undefined;
      }
      state.budget.expansions += 1;
      const rendered = rewriteSafeBody(
        target,
        target.metadata.visibility.value,
        assetPlan,
        snapshots,
        routePlan,
        generatedAssets,
        {
          ancestors: nextAncestors,
          depth: state.depth + 1,
          budget: state.budget,
        },
      );
      if (
        state.budget.outputCharacters + rendered.length
        > NOTE_EMBED_LIMITS.maxOutputCharacters
      ) {
        return undefined;
      }
      state.budget.outputCharacters += rendered.length;
      return quoteEmbeddedMarkdown(target.metadata.title.value, rendered);
    },
  });
  body = body.replace(
    /(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu,
    (_markup, embedMarker: string, target: string, alias: string | undefined) => {
      const resolution = resolveNote(target.trim(), alias?.trim(), embedMarker === '!');
      if (resolution.kind === 'embed') return resolution.html ?? resolution.text;
      if (resolution.kind === 'link') {
        return `[${escapeMarkdownLabel(resolution.text)}](${resolution.url})`;
      }
      return escapeMarkdownLabel(resolution.text);
    },
  );
  return body;
}

interface EmbedRewriteState {
  ancestors: ReadonlySet<string>;
  depth: number;
  budget: { expansions: number; outputCharacters: number };
}

function quoteEmbeddedMarkdown(title: string, source: string): string {
  return [
    '',
    `> [!note] ${escapeMarkdownLabel(title)}`,
    ...source.trim().split('\n').map((line) => `> ${line}`),
    '',
  ].join('\n');
}

function rewriteControlledMermaid(
  source: string,
  generatedAssets: Record<string, PreviewAsset>,
): string {
  const lines = source.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)(`{3,}|~{3,})\s*mermaid(?:\s.*)?$/iu.exec(lines[index] ?? '');
    if (!opener) {
      output.push(lines[index] ?? '');
      continue;
    }
    const marker = opener[2] ?? '```';
    const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`, 'u');
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end] ?? '')) end += 1;
    if (end >= lines.length) {
      output.push(lines[index] ?? '');
      continue;
    }
    const diagramSource = lines.slice(index + 1, end).join('\n');
    const svg = renderSafeMermaid(diagramSource);
    if (svg === undefined) {
      output.push('```text', diagramSource, '```');
    } else {
      const digest = createHash('sha256').update(svg).digest('hex');
      const assetPath = `/assets/pages-publish/mermaid-${digest}.svg`;
      generatedAssets[assetPath] = {
        content: new TextEncoder().encode(svg),
        contentType: 'image/svg+xml',
      };
      output.push(`![Mermaid diagram](${assetPath})`);
    }
    index = end;
  }
  return output.join('\n');
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
