import { readdir } from 'fs/promises';
import { extname, join, relative, sep } from 'path';
import MarkdownIt from 'markdown-it';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import { readArticleSnapshotFromDirectory } from '../publication/article-metadata';

export interface PreviewPage {
  sourcePath: string;
  title: string;
  url: string;
}

export interface LocalPreview {
  siteName: string;
  pages: PreviewPage[];
  files: Record<string, string>;
}

export interface ArticleLocalPreview extends LocalPreview {
  articlePath: string;
}

const markdown = new MarkdownIt({ html: false, linkify: true });

export async function prepareLocalPreviewFromDirectory(
  vaultRoot: string,
): Promise<LocalPreview> {
  const loadedConfig = await loadSiteConfigFromDirectory(vaultRoot);
  if (loadedConfig.status !== 'editable') {
    throw new Error(
      `Site config version ${loadedConfig.version} is read-only and cannot be previewed.`,
    );
  }
  const config = loadedConfig.config;
  const renderedPages = [] as Array<PreviewPage & { html: string }>;

  for (const contentRoot of config.contentRoots) {
    const rootPath = join(vaultRoot, contentRoot.path);
    const markdownFiles = await findMarkdownFiles(rootPath);

    for (const absolutePath of markdownFiles) {
      const sourcePath = toVaultPath(relative(vaultRoot, absolutePath));
      const snapshot = await readArticleSnapshotFromDirectory(
        vaultRoot,
        sourcePath,
      );
      if (snapshot.metadata.visibility.value !== 'public') continue;
      const relativeToRoot = toVaultPath(relative(rootPath, absolutePath));
      const slug = snapshot.metadata.slug.value;
      const title = snapshot.metadata.title.value;
      const relativeDirectory = toVaultPath(
        relativeToRoot.slice(0, Math.max(0, relativeToRoot.lastIndexOf('/'))),
      );
      const url = buildUrl(contentRoot.publicRoot, relativeDirectory, slug);

      renderedPages.push({
        sourcePath,
        title,
        url,
        html: renderDocument(config.site.name, title, markdown.render(snapshot.body)),
      });
    }
  }

  renderedPages.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );

  const pages = renderedPages.map(({ html: _html, ...page }) => page);
  const files: Record<string, string> = {
    '/index.html': renderIndex(config.site.name, pages),
  };
  for (const page of renderedPages) {
    files[`${page.url}index.html`] = page.html;
  }

  return { siteName: config.site.name, pages, files };
}

export async function prepareArticlePreviewFromDirectory(
  vaultRoot: string,
  sourcePath: string,
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
  const snapshot = await readArticleSnapshotFromDirectory(vaultRoot, sourcePath);
  const metadata = snapshot.metadata;
  const relativeToRoot = toVaultPath(relative(contentRoot.path, sourcePath));
  const relativeDirectory = toVaultPath(
    relativeToRoot.slice(0, Math.max(0, relativeToRoot.lastIndexOf('/'))),
  );
  const url = buildUrl(
    contentRoot.publicRoot,
    relativeDirectory,
    metadata.slug.value,
  );
  const page: PreviewPage = {
    sourcePath,
    title: metadata.title.value,
    url,
  };
  return {
    siteName: loadedConfig.config.site.name,
    pages: [page],
    articlePath: url,
    files: {
      '/index.html': renderIndex(loadedConfig.config.site.name, [page]),
      [`${url}index.html`]: renderDocument(
        loadedConfig.config.site.name,
        metadata.title.value,
        markdown.render(snapshot.body),
      ),
    },
  };
}

async function findMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(path)));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(path);
    }
  }
  return files;
}

function buildUrl(
  publicRoot: string,
  relativeDirectory: string,
  slug: string,
): string {
  const segments = [publicRoot, relativeDirectory, slug]
    .flatMap((part) => part.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}/`;
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

function renderDocument(siteName: string, title: string, body: string): string {
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
    `<main>${body}</main>`,
    '</body>',
    '</html>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toVaultPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
