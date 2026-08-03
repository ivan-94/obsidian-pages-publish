import { posix } from 'node:path';

export interface QuartzListingArticle {
  sourcePath: string;
  title: string;
  url: string;
  visibility: 'public' | 'unlisted';
  kind: 'article' | 'index';
  date?: string;
  order?: number;
}

export interface QuartzListingSection {
  directoryPath: string;
  url: string;
  sourcePath?: string;
}

export function quartzHomeEntries(
  homeLayout: 'sections' | 'latest',
  contentRoots: readonly { path: string }[],
  sections: readonly QuartzListingSection[],
  articles: readonly QuartzListingArticle[],
): Array<{ title: string; url: string }> {
  const publicArticles = articles.filter((article) => article.visibility === 'public');
  if (homeLayout === 'latest') {
    return publicArticles
      .filter((article) => article.kind === 'article')
      .sort(compareLatestQuartzArticle)
      .map((article) => ({ title: article.title, url: article.url }));
  }
  const entries: Array<{ title: string; url: string }> = [];
  for (const root of contentRoots) {
    const rootSection = sections.find((section) => section.directoryPath === root.path);
    const directChildren = sections.filter((section) => {
      const relative = posix.relative(root.path, section.directoryPath);
      return relative !== ''
        && relative !== '..'
        && !relative.startsWith('../')
        && !relative.includes('/');
    });
    for (const section of directChildren.length > 0
      ? directChildren
      : rootSection ? [rootSection] : []) {
      const sectionIndex = section.sourcePath === undefined
        ? undefined
        : articles.find((article) => article.sourcePath === section.sourcePath);
      if (sectionIndex !== undefined && sectionIndex.visibility !== 'public') continue;
      if (!publicArticles.some((article) => article.url.startsWith(section.url))) continue;
      entries.push({
        title: sectionIndex?.title
          ?? section.directoryPath.split('/').at(-1)
          ?? section.directoryPath,
        url: section.url,
      });
    }
  }
  return entries.sort((left, right) =>
    left.title.localeCompare(right.title) || left.url.localeCompare(right.url));
}

export function compareLatestQuartzArticle(
  left: QuartzListingArticle,
  right: QuartzListingArticle,
): number {
  return dateSortValue(right.date) - dateSortValue(left.date)
    || left.title.localeCompare(right.title)
    || left.sourcePath.localeCompare(right.sourcePath);
}

export function compareQuartzSectionArticle(
  left: QuartzListingArticle,
  right: QuartzListingArticle,
): number {
  if (left.order !== undefined || right.order !== undefined) {
    if (left.order === undefined) return 1;
    if (right.order === undefined) return -1;
    if (left.order !== right.order) return left.order - right.order;
  }
  return compareLatestQuartzArticle(left, right);
}

export function quartzSectionListingMarkdown(
  articles: readonly QuartzListingArticle[],
  sectionUrl: string,
): string {
  return articles
    .filter((article) =>
      article.visibility === 'public'
      && article.kind === 'article'
      && article.url !== sectionUrl
      && article.url.startsWith(sectionUrl))
    .sort(compareQuartzSectionArticle)
    .map((article) => markdownRouteLink(article.title, article.url))
    .join('\n');
}

export function markdownRouteLink(title: string, route: string): string {
  const label = title.replace(/[\\[\]]/gu, '\\$&');
  const destination = route
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `- [${label}](${destination})`;
}

function dateSortValue(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
