import { posix, relative, sep } from 'path';
import MarkdownIt from 'markdown-it';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import {
  collectLocalPreviewAssets,
  installLocalAssetRule,
  localAssetEnvironment,
  type LocalAssetPlan,
} from '../content/local-assets';
import type { WebpDecoderBoundary } from '../content/webp-decoder';
import {
  createNoteReferenceResolver,
  installNoteReferenceRule,
  NOTE_EMBED_LIMITS,
  noteReferenceEnvironment,
} from '../content/note-references';
import { installRawHtmlSafetyRule } from '../content/raw-html';
import {
  degradeUnsupportedSyntax,
  installUnsupportedSyntaxRule,
} from '../content/unsupported-syntax';
import { loadDirectoryRouteSources } from '../routing/directory-route-sources';
import {
  planSiteRoutes,
  RoutePlanningError,
  type PlannedArticleRoute,
  type SiteRoutePlan,
} from '../routing/route-planner';
import { installDefaultMarkdownRules } from '../site/markdown-rules';
import {
  defaultThemeCss,
  defaultThemePath,
} from '../site/default-theme';
import {
  canonicalUrl,
  createSiteDiscoveryProjection,
  siteCanonicalOrigin,
  type PublicGraphEdge,
  type PublicDiscoveryPage,
} from '../site/discovery';
import type {
  ArticleLocalPreview,
  LocalPreview,
  PreviewArticle,
  PreviewPage,
  SiteBuilder,
} from '../site-builder/site-builder';

export type {
  ArticleLocalPreview,
  LocalPreview,
  PreviewArticle,
  PreviewPage,
} from '../site-builder/site-builder';

const markdown = new MarkdownIt({ html: true, linkify: true });
installDefaultMarkdownRules(markdown);
installUnsupportedSyntaxRule(markdown);
installNoteReferenceRule(markdown);
installLocalAssetRule(markdown);
installRawHtmlSafetyRule(markdown);

export async function prepareLocalPreviewFromDirectory(
  vaultRoot: string,
  options: {
    webpDecoder?: WebpDecoderBoundary;
    /** Production publication omits local-only review affordances. */
    renderMode?: 'local' | 'published';
  } = {},
): Promise<LocalPreview> {
  const loadedConfig = await loadSiteConfigFromDirectory(vaultRoot);
  if (loadedConfig.status !== 'editable') {
    throw new Error(
      `Site config version ${loadedConfig.version} is read-only and cannot be previewed.`,
    );
  }
  const config = loadedConfig.config;
  const renderMode = options.renderMode ?? 'local';
  const canonicalOrigin = siteCanonicalOrigin(config);
  const { snapshots, inputs } = await loadDirectoryRouteSources(
    vaultRoot,
    config,
  );
  const routePlan = planSiteRoutes(config, inputs);
  const blockers = routePlan.issues.filter((issue) => issue.severity === 'blocker');
  if (blockers.length > 0) throw new RoutePlanningError(blockers);
  const assetPlan = await collectLocalPreviewAssets(
    vaultRoot,
    snapshots,
    config.assets.exclude,
    new Set(routePlan.articles.map((article) => article.sourcePath)),
    { webpDecoder: options.webpDecoder },
  );
  const renderedPages = [] as Array<
    PreviewPage & {
      html: string;
      listed: boolean;
      kind: 'article' | 'index';
      visibility: 'public' | 'unlisted';
      date?: string;
      order?: number;
      searchText: string;
    }
  >;
  for (const article of routePlan.articles) {
    const snapshot = snapshots.get(article.sourcePath);
    if (!snapshot) continue;
    const title = snapshot.metadata.title.value;
    const visibility = snapshot.metadata.visibility.value;
    if (visibility === 'private') continue;
    const content = renderArticleContent(
      title,
      renderArticleBody(article.sourcePath, snapshots, routePlan, assetPlan),
    );
    const description = safeArticleDescription(
      article.sourcePath,
      snapshot.metadata.summary?.value,
      config.site.description,
      snapshots,
      routePlan,
      assetPlan,
    );
    renderedPages.push({
      sourcePath: article.sourcePath,
      title,
      url: article.url,
      listed: visibility === 'public',
      kind: snapshot.metadata.kind.value,
      visibility,
      ...(snapshot.metadata.date
        ? { date: snapshot.metadata.date.value }
        : {}),
      ...(snapshot.metadata.order !== undefined
        ? { order: snapshot.metadata.order.value }
        : {}),
      html: renderDocument(
        config.site.name,
        title,
        content,
        renderMode === 'local' ? renderRouteSummary(article) : '',
        {
          canonicalUrl: canonicalUrl(canonicalOrigin, article.url),
          ...(visibility === 'unlisted'
            ? { robots: 'noindex, nofollow' }
            : {}),
          description,
          features: config.features,
          renderMode,
        },
      ),
      searchText: renderSafeArticleText(
        article.sourcePath,
        snapshot.body,
        snapshots,
        routePlan,
        assetPlan,
      ),
    });
  }

  renderedPages.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );

  const pages = renderedPages
    .filter((page) => page.listed)
    .map(
      ({
        html: _html,
        listed: _listed,
        kind: _kind,
        visibility: _visibility,
        date: _date,
        order: _order,
        searchText: _searchText,
        ...page
      }) => page,
    );
  const latestPages = renderedPages
    .filter((page) => page.listed && page.kind === 'article')
    .sort(compareNewestPage)
    .map(toPreviewPage);
  const sectionHomePages = homeSectionPages(
    config.contentRoots,
    routePlan,
    snapshots,
  );
  const discovery = createSiteDiscoveryProjection(
    config,
    snapshots,
    renderedPages
      .filter((page) => page.visibility === 'public')
      .map(
        (page): PublicDiscoveryPage => ({
          sourcePath: page.sourcePath,
          title: page.title,
          url: page.url,
          text: page.searchText,
        }),
      ),
    indexableSitePaths(config, routePlan, snapshots, renderedPages),
  );
  const files: Record<string, string> = {
    [defaultThemePath]: defaultThemeCss,
    '/index.html': renderIndex(
      config.site.name,
      config.site.homeLayout === 'sections' ? sectionHomePages : latestPages,
      config.site.description,
      {
        canonicalUrl: canonicalUrl(canonicalOrigin, '/'),
        features: config.features,
        renderMode,
      },
    ),
    '/404/index.html': renderNotFound(config.site.name, config.features, renderMode),
    '/privacy/index.html': renderPrivacy(
      config.site.name,
      config.features,
      canonicalUrl(canonicalOrigin, '/privacy/'),
      renderMode,
    ),
    '/sitemap.xml': discovery.sitemapXml,
  };
  if (config.features.search) {
    files['/search/index.html'] = renderSearch(config.site.name, discovery.pages, {
        canonicalUrl: canonicalUrl(canonicalOrigin, '/search/'),
        features: config.features,
        renderMode,
    });
  }
  if (config.features.graph) {
    files['/graph/index.html'] = renderGraph(
      config.site.name,
      discovery.pages,
      discovery.graphEdges,
      {
        canonicalUrl: canonicalUrl(canonicalOrigin, '/graph/'),
        features: config.features,
        renderMode,
      },
    );
  }
  for (const page of renderedPages) {
    files[`${page.url}index.html`] = page.html;
  }
  for (const section of routePlan.sections) {
    const filePath = `${section.url}index.html`;
    const members = renderedPages
      .filter(
        (page) =>
          page.listed &&
          page.kind === 'article' &&
          page.url !== section.url &&
          page.url.startsWith(section.url),
      )
      .sort(compareSectionPage)
      .map(toPreviewPage);
    const sectionSnapshot = section.sourcePath
      ? snapshots.get(section.sourcePath)
      : undefined;
    const sectionArticle = section.sourcePath
      ? routePlan.articles.find(
          (article) => article.sourcePath === section.sourcePath,
        )
      : undefined;
    const description = safeArticleDescription(
      sectionSnapshot?.sourcePath ?? section.directoryPath,
      sectionSnapshot?.metadata.summary?.value,
      config.site.description,
      snapshots,
      routePlan,
      assetPlan,
    );
    files[filePath] = renderSection(
      config.site.name,
      sectionSnapshot?.metadata.title.value ??
        section.directoryPath.split('/').at(-1) ??
        config.site.name,
      members,
      sectionSnapshot && sectionArticle
        ? `${renderArticleContent(
            sectionSnapshot.metadata.title.value,
            renderArticleBody(
              sectionSnapshot.sourcePath,
              snapshots,
              routePlan,
              assetPlan,
            ),
          )}${renderMode === 'local' ? renderRouteSummary(sectionArticle) : ''}`
        : undefined,
      {
        canonicalUrl: canonicalUrl(canonicalOrigin, section.url),
        ...(sectionSnapshot?.metadata.visibility.value === 'unlisted'
          ? { robots: 'noindex, nofollow' }
          : {}),
        description,
        features: config.features,
        renderMode,
      },
    );
  }
  for (const redirect of routePlan.redirects) {
    files[`${redirect.from}index.html`] = renderRedirect(
      config.site.name,
      redirect.from,
      redirect.to,
      { features: config.features, renderMode },
    );
  }

  const routesBySource = new Map(
    routePlan.articles.map((article) => [article.sourcePath, article]),
  );
  const articles = [...snapshots.values()]
    .map((snapshot): PreviewArticle => {
      const route = routesBySource.get(snapshot.sourcePath);
      return {
        sourcePath: snapshot.sourcePath,
        title: snapshot.metadata.title.value,
        visibility: snapshot.metadata.visibility.value,
        sourceDigest: snapshot.contentDigest ?? snapshot.revision,
        ...(route?.url ? { url: route.url } : {}),
        ...(snapshot.metadata.deployment?.url
          ? { onlineUrl: snapshot.metadata.deployment.url }
          : route?.onlineUrl
            ? { onlineUrl: route.onlineUrl }
            : {}),
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
    siteName: config.site.name,
    ...(config.site.timezone === undefined ? {} : { timeZone: config.site.timezone }),
    pages,
    articles,
    files,
    assets: assetPlan.assets,
    routePlan,
  };
}

/** Compatibility implementation retained while Quartz is introduced. */
export const legacySiteBuilder: SiteBuilder = {
  build: ({ vaultRoot, renderMode, webpDecoder, focusSourcePath }) =>
    focusSourcePath === undefined
      ? prepareLocalPreviewFromDirectory(vaultRoot, {
        renderMode,
        ...(webpDecoder === undefined ? {} : { webpDecoder }),
      })
      : prepareArticlePreviewFromDirectory(vaultRoot, focusSourcePath, {
        ...(webpDecoder === undefined ? {} : { webpDecoder }),
      }),
};

interface OrderedPreviewPage extends PreviewPage {
  date?: string;
  order?: number;
}

function compareNewestPage(
  left: OrderedPreviewPage,
  right: OrderedPreviewPage,
): number {
  return (
    dateSortValue(right.date) - dateSortValue(left.date) ||
    left.title.localeCompare(right.title) ||
    left.sourcePath.localeCompare(right.sourcePath)
  );
}

function compareSectionPage(
  left: OrderedPreviewPage,
  right: OrderedPreviewPage,
): number {
  if (left.order !== undefined || right.order !== undefined) {
    if (left.order === undefined) return 1;
    if (right.order === undefined) return -1;
    if (left.order !== right.order) return left.order - right.order;
  }
  return compareNewestPage(left, right);
}

function dateSortValue(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function toPreviewPage(page: OrderedPreviewPage): PreviewPage {
  return {
    sourcePath: page.sourcePath,
    title: page.title,
    url: page.url,
  };
}

function homeSectionPages(
  contentRoots: readonly { path: string; publicRoot: string }[],
  routePlan: SiteRoutePlan,
  snapshots: Map<
    string,
    import('../publication/article-metadata').ArticleSourceSnapshot
  >,
): PreviewPage[] {
  const pages: PreviewPage[] = [];
  for (const root of contentRoots) {
    const rootSection = routePlan.sections.find(
      (section) => section.directoryPath === root.path,
    );
    const directChildren = routePlan.sections.filter((section) => {
      const relativeDirectory = posix.relative(root.path, section.directoryPath);
      return (
        relativeDirectory !== '' &&
        relativeDirectory !== '..' &&
        !relativeDirectory.startsWith('../') &&
        !relativeDirectory.includes('/')
      );
    });
    for (const section of directChildren.length > 0
      ? directChildren
      : rootSection
        ? [rootSection]
        : []) {
      const snapshot = section.sourcePath
        ? snapshots.get(section.sourcePath)
        : undefined;
      if (
        snapshot &&
        snapshot.metadata.visibility.value !== 'public'
      ) {
        continue;
      }
      pages.push({
        sourcePath: section.sourcePath ?? section.directoryPath,
        title:
          snapshot?.metadata.title.value ??
          section.directoryPath.split('/').at(-1) ??
          section.directoryPath,
        url: section.url,
      });
    }
  }
  return pages.sort(
    (left, right) =>
      left.title.localeCompare(right.title) || left.url.localeCompare(right.url),
  );
}

function indexableSitePaths(
  config: import('../config/site-config').SiteConfigV1,
  routePlan: SiteRoutePlan,
  snapshots: Map<string, import('../publication/article-metadata').ArticleSourceSnapshot>,
  pages: ReadonlyArray<{
    url: string;
    visibility: 'public' | 'unlisted';
  }>,
): string[] {
  const paths = new Set<string>(['/privacy/']);
  const rootSection = routePlan.sections.find((section) => section.url === '/');
  if (
    !rootSection?.sourcePath ||
    snapshots.get(rootSection.sourcePath)?.metadata.visibility.value === 'public'
  ) {
    paths.add('/');
  }
  if (config.features.search) paths.add('/search/');
  if (config.features.graph) paths.add('/graph/');
  for (const page of pages) {
    if (page.visibility === 'public') paths.add(page.url);
  }
  for (const section of routePlan.sections) {
    const visibility = section.sourcePath
      ? snapshots.get(section.sourcePath)?.metadata.visibility.value
      : 'public';
    if (visibility === 'public') paths.add(section.url);
  }
  return [...paths];
}

export async function prepareArticlePreviewFromDirectory(
  vaultRoot: string,
  sourcePath: string,
  options: { webpDecoder?: WebpDecoderBoundary } = {},
): Promise<ArticleLocalPreview> {
  const loadedConfig = await loadSiteConfigFromDirectory(vaultRoot);
  if (loadedConfig.status !== 'editable') {
    throw new Error(
      `Site config version ${loadedConfig.version} is read-only and cannot be previewed.`,
    );
  }
  const contentRoot = loadedConfig.config.contentRoots.find((candidate) => {
    const pathFromRoot = relative(candidate.path, sourcePath);
    return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`);
  });
  if (!contentRoot) throw new Error('Article is outside configured content roots.');
  const { snapshots, inputs } = await loadDirectoryRouteSources(
    vaultRoot,
    loadedConfig.config,
  );
  const snapshot = snapshots.get(sourcePath);
  if (!snapshot) throw new Error('Article is missing from the configured content roots.');
  const metadata = snapshot.metadata;
  const canonicalOrigin = siteCanonicalOrigin(loadedConfig.config);
  const routePlan = planSiteRoutes(
    loadedConfig.config,
    inputs.map((input) =>
      input.sourcePath === sourcePath ? { ...input, visibility: 'public' } : input,
    ),
  );
  const blockers = routePlan.issues.filter((issue) => issue.severity === 'blocker');
  if (blockers.length > 0) throw new RoutePlanningError(blockers);
  const assetPlan = await collectLocalPreviewAssets(
    vaultRoot,
    snapshots,
    loadedConfig.config.assets.exclude,
    new Set(routePlan.articles.map((article) => article.sourcePath)),
    { webpDecoder: options.webpDecoder },
  );
  const plannedArticle = routePlan.articles.find(
    (article) => article.sourcePath === sourcePath,
  );
  if (!plannedArticle) throw new Error('Article did not produce a preview route.');
  const articleProjection: PlannedArticleRoute = {
    ...plannedArticle,
    redirects: routePlan.redirects.filter(
      (redirect) => redirect.to === plannedArticle.url,
    ),
  };
  const url = plannedArticle.url;
  const page: PreviewPage = {
    sourcePath,
    title: metadata.title.value,
    url,
  };
  const description = safeArticleDescription(
    sourcePath,
    metadata.summary?.value,
    loadedConfig.config.site.description,
    snapshots,
    routePlan,
    assetPlan,
  );
  const preview: ArticleLocalPreview = {
    siteName: loadedConfig.config.site.name,
    pages: [page],
    articles: [
      {
        sourcePath,
        title: metadata.title.value,
        url,
        visibility: metadata.visibility.value,
        sourceDigest: snapshot.contentDigest ?? snapshot.revision,
        ...(metadata.deployment?.url
          ? { onlineUrl: metadata.deployment.url }
          : plannedArticle.onlineUrl
            ? { onlineUrl: plannedArticle.onlineUrl }
          : {}),
        ...(metadata.deployment?.firstPublishedAt === undefined
          ? {}
          : { firstPublishedAt: metadata.deployment.firstPublishedAt }),
        ...(metadata.deployment?.lastPublishedAt === undefined
          ? {}
          : { lastPublishedAt: metadata.deployment.lastPublishedAt }),
      },
    ],
    articlePath: url,
    assets: assetPlan.assets,
    files: {
      [defaultThemePath]: defaultThemeCss,
      '/index.html': renderIndex(loadedConfig.config.site.name, [page], undefined, {
        canonicalUrl: canonicalUrl(canonicalOrigin, '/'),
        features: loadedConfig.config.features,
      }),
      [`${url}index.html`]: renderDocument(
        loadedConfig.config.site.name,
        metadata.title.value,
        renderArticleContent(
          metadata.title.value,
          renderArticleBody(sourcePath, snapshots, routePlan, assetPlan),
        ),
        renderRouteSummary(articleProjection),
        {
          canonicalUrl: canonicalUrl(canonicalOrigin, url),
          ...(metadata.visibility.value === 'public'
            ? {}
            : { robots: 'noindex, nofollow' }),
          description,
          features: loadedConfig.config.features,
        },
      ),
    },
    routePlan,
  };
  for (const redirect of articleProjection.redirects) {
    preview.files[`${redirect.from}index.html`] = renderRedirect(
      loadedConfig.config.site.name,
      redirect.from,
      redirect.to,
      { features: loadedConfig.config.features },
    );
  }
  return preview;
}

function renderArticleBody(
  sourcePath: string,
  snapshots: Map<string, import('../publication/article-metadata').ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  assetPlan: LocalAssetPlan,
  state: EmbedRenderState = {
    ancestors: new Set(),
    depth: 0,
    budget: { expansions: 0, outputCharacters: 0 },
  },
): string {
  const snapshot = snapshots.get(sourcePath);
  if (!snapshot) return '';
  return renderSourceMarkdown(
    sourcePath,
    snapshot.body,
    snapshots,
    routePlan,
    assetPlan,
    state,
  );
}

function renderSafeArticleText(
  sourcePath: string,
  source: string,
  snapshots: Map<string, import('../publication/article-metadata').ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  assetPlan: LocalAssetPlan,
): string {
  return plainTextFromHtml(
    renderSourceMarkdown(
      sourcePath,
      source,
      snapshots,
      routePlan,
      assetPlan,
      {
        ancestors: new Set(),
        depth: 0,
        budget: { expansions: 0, outputCharacters: 0 },
      },
      false,
    ),
  );
}

function safeArticleDescription(
  sourcePath: string,
  summary: string | undefined,
  fallback: string | undefined,
  snapshots: Map<string, import('../publication/article-metadata').ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  assetPlan: LocalAssetPlan,
): string | undefined {
  // An embed can expand to a very large public note. Its rendered article is
  // already searchable, so preserve the site-level fallback instead of
  // duplicating that expansion in metadata.
  if (!summary || summary.includes('![[')) return fallback;
  return (
    renderSafeArticleText(sourcePath, summary, snapshots, routePlan, assetPlan) ||
    fallback
  );
}

function renderSourceMarkdown(
  sourcePath: string,
  source: string,
  snapshots: Map<string, import('../publication/article-metadata').ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  assetPlan: LocalAssetPlan,
  state: EmbedRenderState = {
    ancestors: new Set(),
    depth: 0,
    budget: { expansions: 0, outputCharacters: 0 },
  },
  includeEmbeds = true,
): string {
  const nextAncestors = new Set(state.ancestors);
  nextAncestors.add(sourcePath);
  const referenceResolver = createNoteReferenceResolver(
    sourcePath,
    snapshots,
    routePlan,
    {
      renderEmbed: (targetPath) => {
        const targetSnapshot = snapshots.get(targetPath);
        if (
          !includeEmbeds ||
          !targetSnapshot ||
          nextAncestors.has(targetPath) ||
          state.depth >= NOTE_EMBED_LIMITS.maxDepth ||
          state.budget.expansions >= NOTE_EMBED_LIMITS.maxExpansions ||
          state.budget.outputCharacters + targetSnapshot.body.length >
            NOTE_EMBED_LIMITS.maxOutputCharacters
        ) {
          return undefined;
        }
        state.budget.expansions += 1;
        state.budget.outputCharacters += targetSnapshot.body.length;
        return renderArticleBody(
          targetPath,
          snapshots,
          routePlan,
          assetPlan,
          {
            ancestors: nextAncestors,
            depth: state.depth + 1,
            budget: state.budget,
          },
        );
      },
    },
  );
  return markdown.render(
    degradeUnsupportedSyntax(source),
    {
      ...localAssetEnvironment(sourcePath, assetPlan),
      ...noteReferenceEnvironment(
        (target, alias, embed) =>
          !includeEmbeds && embed
            ? { kind: 'text', text: '' }
            : referenceResolver(target, alias, embed),
      ),
    },
  );
}

interface EmbedRenderState {
  ancestors: Set<string>;
  depth: number;
  budget: {
    expansions: number;
    outputCharacters: number;
  };
}

function renderArticleContent(title: string, renderedBody: string): string {
  const leadingHeading = /^\s*<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>\s*/iu.exec(
    renderedBody,
  );
  const body = leadingHeading
    ? renderedBody.slice(leadingHeading[0].length)
    : renderedBody;
  return `<article><header><h1>${escapeHtml(title)}</h1></header>${body}</article>`;
}

function renderIndex(
  siteName: string,
  pages: PreviewPage[],
  description?: string,
  options: RenderDocumentOptions = {},
): string {
  const links = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`,
    )
    .join('');
  return renderDocument(
    siteName,
    siteName,
    `<section class="site-hero"><h1>${escapeHtml(siteName)}</h1>${
      description ? `<p>${escapeHtml(description)}</p>` : ''
    }</section><ul>${links}</ul>`,
    '',
    options,
  );
}

interface RenderDocumentOptions {
  canonicalUrl?: string;
  robots?: 'noindex, nofollow';
  description?: string;
  features?: { search: boolean; graph: boolean };
  renderMode?: 'local' | 'published';
}

function renderDocument(
  siteName: string,
  title: string,
  body: string,
  routeSummary = '',
  options: RenderDocumentOptions = {},
): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    options.description
      ? `<meta name="description" content="${escapeHtml(options.description)}">`
      : '',
    options.robots ? `<meta name="robots" content="${options.robots}">` : '',
    options.canonicalUrl
      ? `<link rel="canonical" href="${escapeHtml(options.canonicalUrl)}">`
      : '',
    `<link rel="stylesheet" href="${defaultThemePath}">`,
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    '</head>',
    '<body>',
    '<a class="skip-link" href="#content">跳到正文</a>',
    options.renderMode === 'published'
      ? ''
      : '<aside data-pages-preview="local" role="status">本地预览 · 尚未发布</aside>',
    `<header class="site-header"><a href="/">${escapeHtml(siteName)}</a>${renderNavigation(
      options.features,
    )}</header>`,
    `<main id="content">${body}${routeSummary}</main>`,
    `<footer><p>由 ${escapeHtml(siteName)} 发布</p></footer>`,
    '</body>',
    '</html>',
  ].join('');
}

function renderNavigation(features: RenderDocumentOptions['features']): string {
  return `<nav aria-label="主要导航"><a href="/">首页</a>${
    features?.search ? '<a href="/search/">搜索</a>' : ''
  }${features?.graph ? '<a href="/graph/">图谱</a>' : ''}<a href="/privacy/">隐私</a></nav>`;
}

function renderNotFound(
  siteName: string,
  features: RenderDocumentOptions['features'],
  renderMode: RenderDocumentOptions['renderMode'],
): string {
  return renderDocument(
    siteName,
    '页面未找到',
    '<h1>页面未找到</h1><p>这个地址没有对应的公开内容。</p><p><a href="/">返回首页</a></p>',
    '',
    { robots: 'noindex, nofollow', features, renderMode },
  );
}

function renderPrivacy(
  siteName: string,
  features: RenderDocumentOptions['features'],
  canonical: string,
  renderMode: RenderDocumentOptions['renderMode'],
): string {
  return renderDocument(
    siteName,
    '隐私说明',
    '<h1>隐私说明</h1><p>本站默认不启用评论或访问统计，也不会由发布插件代理外部资源。</p>',
    '',
    { canonicalUrl: canonical, features, renderMode },
  );
}

function renderSearch(
  siteName: string,
  pages: readonly PublicDiscoveryPage[],
  options: RenderDocumentOptions,
): string {
  const initialResults = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a><p>${escapeHtml(
          searchExcerpt(page.text),
        )}</p></li>`,
    )
    .join('');
  const index = safeJsonForHtml(
    pages.map((page) => ({ title: page.title, url: page.url, text: page.text })),
  );
  return renderDocument(
    siteName,
    '搜索',
    `<section data-pages-search><h1>搜索</h1><form role="search"><label for="pages-search-query">搜索公开内容</label><input id="pages-search-query" name="q" type="search" autocomplete="off"><button type="submit">搜索</button></form><p data-pages-search-status aria-live="polite"></p><ol data-pages-search-results>${initialResults}</ol><script type="application/json" data-pages-search-index>${index}</script><script>${searchClientScript}</script></section>`,
    '',
    options,
  );
}

function renderGraph(
  siteName: string,
  pages: readonly PublicDiscoveryPage[],
  edges: readonly PublicGraphEdge[],
  options: RenderDocumentOptions,
): string {
  const titlesByUrl = new Map(pages.map((page) => [page.url, page.title]));
  const nodes = pages
    .map(
      (page) => `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`,
    )
    .join('');
  const relations = edges
    .map(
      (edge) =>
        `<li><a href="${escapeHtml(edge.from)}">${escapeHtml(
          titlesByUrl.get(edge.from) ?? edge.from,
        )}</a> → <a href="${escapeHtml(edge.to)}">${escapeHtml(
          titlesByUrl.get(edge.to) ?? edge.to,
        )}</a></li>`,
    )
    .join('');
  return renderDocument(
    siteName,
    '知识图谱',
    `<section data-pages-graph><h1>知识图谱</h1><p>仅包含公开文章及其公开引用关系。</p><section aria-label="图谱节点"><h2>文章</h2><ul>${nodes}</ul></section><section aria-label="图谱关系"><h2>引用关系</h2><ul>${relations || '<li>暂无公开引用关系。</li>'}</ul></section></section>`,
    '',
    options,
  );
}

const searchClientScript = `(() => {
  const root = document.querySelector('[data-pages-search]');
  if (!root) return;
  const form = root.querySelector('form');
  const input = root.querySelector('input[type="search"]');
  const results = root.querySelector('[data-pages-search-results]');
  const status = root.querySelector('[data-pages-search-status]');
  const payload = root.querySelector('[data-pages-search-index]');
  if (!form || !input || !results || !status || !payload) return;
  const pages = JSON.parse(payload.textContent || '[]');
  const render = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const matches = query ? pages.filter((page) => (page.title + ' ' + page.text).toLocaleLowerCase().includes(query)) : pages;
    results.replaceChildren(...matches.map((page) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = page.url;
      link.textContent = page.title;
      item.append(link);
      return item;
    }));
    status.textContent = query ? '找到 ' + matches.length + ' 篇公开文章。' : '';
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); render(); });
  input.addEventListener('input', render);
})();`;

function searchExcerpt(value: string): string {
  return value.length <= 180 ? value : `${value.slice(0, 177)}…`;
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function renderRouteSummary(article: PlannedArticleRoute): string {
  const redirects = article.redirects
    .map(
      (redirect) =>
        `<li>${escapeHtml(redirect.from)} → ${escapeHtml(redirect.to)}</li>`,
    )
    .join('');
  return [
    '<section data-pages-route-summary>',
    '<h2>URL 预览</h2>',
    `<p>待发布 URL：<code>${escapeHtml(article.url)}</code></p>`,
    `<p>当前线上 URL：<code>${escapeHtml(article.onlineUrl ?? '尚未上线')}</code></p>`,
    redirects ? `<ul>${redirects}</ul>` : '<p>没有待发布重定向</p>',
    '</section>',
  ].join('');
}

function renderRedirect(
  siteName: string,
  from: string,
  to: string,
  options: RenderDocumentOptions,
): string {
  return renderDocument(
    siteName,
    '永久重定向',
    `<p><code>${escapeHtml(from)}</code> → <a href="${escapeHtml(to)}">${escapeHtml(to)}</a></p>`,
    '',
    { ...options, robots: 'noindex, nofollow' },
  );
}

function renderSection(
  siteName: string,
  title: string,
  pages: PreviewPage[],
  introduction?: string,
  options: RenderDocumentOptions = {},
): string {
  const links = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`,
    )
    .join('');
  return renderDocument(
    siteName,
    title,
    `${
      introduction ??
      `<h1>${escapeHtml(title)}</h1><p>此栏目由目录结构自动生成。</p>`
    }<section aria-label="栏目文章"><ul>${links}</ul></section>`,
    '',
    options,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
