import { posix, relative, sep } from 'path';
import MarkdownIt from 'markdown-it';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import {
  collectLocalPreviewAssets,
  installLocalAssetRule,
  localAssetEnvironment,
  type LocalAssetPlan,
  type PreviewAsset,
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

export interface PreviewPage {
  sourcePath: string;
  title: string;
  url: string;
}

export interface LocalPreview {
  siteName: string;
  pages: PreviewPage[];
  files: Record<string, string>;
  assets: Record<string, PreviewAsset>;
  routePlan: SiteRoutePlan;
}

export interface ArticleLocalPreview extends LocalPreview {
  articlePath: string;
}

const markdown = new MarkdownIt({ html: true, linkify: true });
installDefaultMarkdownRules(markdown);
installUnsupportedSyntaxRule(markdown);
installNoteReferenceRule(markdown);
installLocalAssetRule(markdown);
installRawHtmlSafetyRule(markdown);

export async function prepareLocalPreviewFromDirectory(
  vaultRoot: string,
  options: { webpDecoder?: WebpDecoderBoundary } = {},
): Promise<LocalPreview> {
  const loadedConfig = await loadSiteConfigFromDirectory(vaultRoot);
  if (loadedConfig.status !== 'editable') {
    throw new Error(
      `Site config version ${loadedConfig.version} is read-only and cannot be previewed.`,
    );
  }
  const config = loadedConfig.config;
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
      date?: string;
      order?: number;
    }
  >;
  for (const article of routePlan.articles) {
    const snapshot = snapshots.get(article.sourcePath);
    if (!snapshot) continue;
    const title = snapshot.metadata.title.value;
    renderedPages.push({
      sourcePath: article.sourcePath,
      title,
      url: article.url,
      listed: snapshot.metadata.visibility.value === 'public',
      kind: snapshot.metadata.kind.value,
      ...(snapshot.metadata.date
        ? { date: snapshot.metadata.date.value }
        : {}),
      ...(snapshot.metadata.order !== undefined
        ? { order: snapshot.metadata.order.value }
        : {}),
      html: renderDocument(
        config.site.name,
        title,
        renderArticleContent(
          title,
          renderArticleBody(article.sourcePath, snapshots, routePlan, assetPlan),
        ),
        renderRouteSummary(article),
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
        date: _date,
        order: _order,
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
  const files: Record<string, string> = {
    [defaultThemePath]: defaultThemeCss,
    '/index.html': renderIndex(
      config.site.name,
      config.site.homeLayout === 'sections' ? sectionHomePages : latestPages,
      config.site.description,
    ),
    '/404/index.html': renderNotFound(config.site.name),
    '/privacy/index.html': renderPrivacy(config.site.name),
  };
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
          )}${renderRouteSummary(sectionArticle)}`
        : undefined,
    );
  }
  for (const redirect of routePlan.redirects) {
    files[`${redirect.from}index.html`] = renderRedirect(
      config.site.name,
      redirect.from,
      redirect.to,
    );
  }

  return {
    siteName: config.site.name,
    pages,
    files,
    assets: assetPlan.assets,
    routePlan,
  };
}

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
  const preview: ArticleLocalPreview = {
    siteName: loadedConfig.config.site.name,
    pages: [page],
    articlePath: url,
    assets: assetPlan.assets,
    files: {
      [defaultThemePath]: defaultThemeCss,
      '/index.html': renderIndex(loadedConfig.config.site.name, [page]),
      [`${url}index.html`]: renderDocument(
        loadedConfig.config.site.name,
        metadata.title.value,
        renderArticleContent(
          metadata.title.value,
          renderArticleBody(sourcePath, snapshots, routePlan, assetPlan),
        ),
        renderRouteSummary(articleProjection),
      ),
    },
    routePlan,
  };
  for (const redirect of articleProjection.redirects) {
    preview.files[`${redirect.from}index.html`] = renderRedirect(
      loadedConfig.config.site.name,
      redirect.from,
      redirect.to,
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
  const nextAncestors = new Set(state.ancestors);
  nextAncestors.add(sourcePath);
  return markdown.render(
    degradeUnsupportedSyntax(snapshot.body),
    {
      ...localAssetEnvironment(sourcePath, assetPlan),
      ...noteReferenceEnvironment(
        createNoteReferenceResolver(sourcePath, snapshots, routePlan, {
          renderEmbed: (targetPath) => {
            const targetSnapshot = snapshots.get(targetPath);
            if (
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
        }),
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
  );
}

function renderDocument(
  siteName: string,
  title: string,
  body: string,
  routeSummary = '',
): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<link rel="stylesheet" href="${defaultThemePath}">`,
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    '</head>',
    '<body>',
    '<a class="skip-link" href="#content">跳到正文</a>',
    '<aside data-pages-preview="local" role="status">本地预览 · 尚未发布</aside>',
    `<header class="site-header"><a href="/">${escapeHtml(siteName)}</a><nav aria-label="主要导航"><a href="/">首页</a><a href="/privacy/">隐私</a></nav></header>`,
    `<main id="content">${body}${routeSummary}</main>`,
    `<footer><p>由 ${escapeHtml(siteName)} 发布</p></footer>`,
    '</body>',
    '</html>',
  ].join('');
}

function renderNotFound(siteName: string): string {
  return renderDocument(
    siteName,
    '页面未找到',
    '<h1>页面未找到</h1><p>这个地址没有对应的公开内容。</p><p><a href="/">返回首页</a></p>',
  );
}

function renderPrivacy(siteName: string): string {
  return renderDocument(
    siteName,
    '隐私说明',
    '<h1>隐私说明</h1><p>本站默认不启用评论或访问统计，也不会由发布插件代理外部资源。</p>',
  );
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

function renderRedirect(siteName: string, from: string, to: string): string {
  return renderDocument(
    siteName,
    '永久重定向',
    `<p><code>${escapeHtml(from)}</code> → <a href="${escapeHtml(to)}">${escapeHtml(to)}</a></p>`,
  );
}

function renderSection(
  siteName: string,
  title: string,
  pages: PreviewPage[],
  introduction?: string,
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
