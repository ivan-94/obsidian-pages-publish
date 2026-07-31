import { readdir, readFile } from 'fs/promises';
import { basename, extname, join, relative, sep } from 'path';
import MarkdownIt from 'markdown-it';
import { parse as parseYaml } from 'yaml';

interface RawSiteConfig {
  version?: unknown;
  site?: {
    name?: unknown;
    home_layout?: unknown;
  };
  content_roots?: Array<{
    path?: unknown;
    public_root?: unknown;
  }>;
  features?: {
    search?: unknown;
    graph?: unknown;
  };
  cloudflare?: {
    project_name?: unknown;
  };
}

interface RawPublicationFrontmatter {
  publication?: {
    visibility?: unknown;
    slug?: unknown;
    title?: unknown;
  };
}

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

const markdown = new MarkdownIt({ html: false, linkify: true });

export async function prepareLocalPreviewFromDirectory(
  vaultRoot: string,
): Promise<LocalPreview> {
  const config = await readSiteConfig(vaultRoot);
  const renderedPages = [] as Array<PreviewPage & { html: string }>;

  for (const contentRoot of config.contentRoots) {
    const rootPath = join(vaultRoot, contentRoot.path);
    const markdownFiles = await findMarkdownFiles(rootPath);

    for (const absolutePath of markdownFiles) {
      const source = await readFile(absolutePath, 'utf8');
      const document = parseMarkdownDocument(source);
      if (document.frontmatter.publication?.visibility !== 'public') {
        continue;
      }

      const sourcePath = toVaultPath(relative(vaultRoot, absolutePath));
      const relativeToRoot = toVaultPath(relative(rootPath, absolutePath));
      const slug =
        stringValue(document.frontmatter.publication.slug) ??
        basename(relativeToRoot, extname(relativeToRoot));
      const title =
        stringValue(document.frontmatter.publication.title) ??
        firstHeading(document.body) ??
        basename(relativeToRoot, extname(relativeToRoot));
      const relativeDirectory = toVaultPath(
        relativeToRoot.slice(0, Math.max(0, relativeToRoot.lastIndexOf('/'))),
      );
      const url = buildUrl(contentRoot.publicRoot, relativeDirectory, slug);

      renderedPages.push({
        sourcePath,
        title,
        url,
        html: renderDocument(config.siteName, title, markdown.render(document.body)),
      });
    }
  }

  renderedPages.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );

  const pages = renderedPages.map(({ html: _html, ...page }) => page);
  const files: Record<string, string> = {
    '/index.html': renderIndex(config.siteName, pages),
  };
  for (const page of renderedPages) {
    files[`${page.url}index.html`] = page.html;
  }

  return { siteName: config.siteName, pages, files };
}

async function readSiteConfig(vaultRoot: string): Promise<{
  siteName: string;
  contentRoots: Array<{ path: string; publicRoot: string }>;
}> {
  const source = await readFile(join(vaultRoot, '.publish', 'site.yml'), 'utf8');
  const raw = parseYaml(source) as RawSiteConfig;
  const siteName = stringValue(raw.site?.name);
  const homeLayout = raw.site?.home_layout;
  const projectName = stringValue(raw.cloudflare?.project_name);
  if (
    raw.version !== 1 ||
    !siteName ||
    (homeLayout !== 'sections' && homeLayout !== 'latest') ||
    typeof raw.features?.search !== 'boolean' ||
    typeof raw.features.graph !== 'boolean' ||
    !projectName ||
    !Array.isArray(raw.content_roots) ||
    raw.content_roots.length === 0
  ) {
    throw new Error('Invalid Pages Publish site configuration.');
  }

  const contentRoots = raw.content_roots.map((root) => {
    const path = stringValue(root.path);
    const publicRoot = stringValue(root.public_root);
    if (!path || !publicRoot) {
      throw new Error('Invalid Pages Publish content root.');
    }
    return { path, publicRoot };
  });

  return { siteName, contentRoots };
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

function parseMarkdownDocument(source: string): {
  frontmatter: RawPublicationFrontmatter;
  body: string;
} {
  if (!source.startsWith('---\n')) {
    return { frontmatter: {}, body: source };
  }

  const closingMarker = source.indexOf('\n---\n', 4);
  if (closingMarker === -1) {
    return { frontmatter: {}, body: source };
  }

  const frontmatterSource = source.slice(4, closingMarker);
  const body = source.slice(closingMarker + 5);
  return {
    frontmatter: parseYaml(frontmatterSource) as RawPublicationFrontmatter,
    body,
  };
}

function firstHeading(markdownSource: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdownSource);
  return match?.[1]?.trim();
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toVaultPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
