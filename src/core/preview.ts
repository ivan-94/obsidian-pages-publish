import { relative, sep } from 'path';
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
import { loadDirectoryRouteSources } from '../routing/directory-route-sources';
import {
  planSiteRoutes,
  RoutePlanningError,
  type PlannedArticleRoute,
  type SiteRoutePlan,
} from '../routing/route-planner';

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
    PreviewPage & { html: string; listed: boolean }
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
      html: renderDocument(
        config.site.name,
        title,
        renderArticleBody(article.sourcePath, snapshots, routePlan, assetPlan),
        renderRouteSummary(article),
      ),
    });
  }

  renderedPages.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );

  const pages = renderedPages
    .filter((page) => page.listed)
    .map(({ html: _html, listed: _listed, ...page }) => page);
  const files: Record<string, string> = {
    '/index.html': renderIndex(config.site.name, pages),
  };
  for (const page of renderedPages) {
    files[`${page.url}index.html`] = page.html;
  }
  for (const section of routePlan.sections) {
    const filePath = `${section.url}index.html`;
    if (files[filePath] !== undefined) continue;
    const members = pages.filter(
      (page) => page.url !== section.url && page.url.startsWith(section.url),
    );
    files[filePath] = renderSection(
      config.site.name,
      section.directoryPath.split('/').at(-1) ?? config.site.name,
      members,
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
      '/index.html': renderIndex(loadedConfig.config.site.name, [page]),
      [`${url}index.html`]: renderDocument(
        loadedConfig.config.site.name,
        metadata.title.value,
        renderArticleBody(sourcePath, snapshots, routePlan, assetPlan),
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
    snapshot.body,
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

function renderIndex(siteName: string, pages: PreviewPage[]): string {
  const links = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`,
    )
    .join('');
  return renderDocument(siteName, siteName, `<h1>${escapeHtml(siteName)}</h1><ul>${links}</ul>`);
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
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    '</head>',
    '<body>',
    '<aside data-pages-preview="local" role="status">本地预览 · 尚未发布</aside>',
    routeSummary,
    `<main>${body}</main>`,
    '</body>',
    '</html>',
  ].join('');
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
    `<h1>${escapeHtml(title)}</h1><p>此栏目由目录结构自动生成。</p><ul>${links}</ul>`,
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
