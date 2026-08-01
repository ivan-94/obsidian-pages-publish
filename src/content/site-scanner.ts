import { createHash } from 'crypto';
import type { Dirent } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { extname, join, relative, sep } from 'path';
import {
  loadSiteConfigFromDirectory,
  validateSiteConfigForDirectory,
  type SiteConfigV1,
} from '../config/site-config';
import {
  ArticleMetadataValidationError,
  readArticleSnapshotFromSource,
  type ArticleSourceSnapshot,
} from '../publication/article-metadata';
import { inspectNoteReferences } from './note-references';
import {
  collectLocalPreviewAssets,
  type LocalAssetFileSystemBoundary,
} from './local-assets';
import { inspectRawHtml } from './raw-html';
import { inspectMermaid } from './mermaid';
import { inspectUnsupportedSyntax } from './unsupported-syntax';
import type { ExternalLinkCandidate } from './external-link-checker';
import type { WebpDecoderBoundary } from './webp-decoder';
import {
  planSiteRoutes,
  type RouteArticleInput,
  type SiteRoutePlan,
} from '../routing/route-planner';

export interface ScanIssue {
  severity: 'warning' | 'blocker';
  code: string;
  path: string;
  message: string;
  line?: number;
  column?: number;
  impact?: string;
  location?: { path: string; line: number };
  dormant?: boolean;
}

export interface ScanCandidate {
  sourcePath: string;
  contentRootPath: string;
  sourceDigest: string;
}

export interface SiteScanResult {
  configRevision: string;
  digest: string;
  candidates: ScanCandidate[];
  issues: ScanIssue[];
  externalLinks?: ExternalLinkCandidate[];
  routePlan?: SiteRoutePlan;
}

export interface ScanFileSystemBoundary {
  readDirectory(directory: string): Promise<Dirent[]>;
  readTextFile(path: string): Promise<string>;
}

export async function scanSiteFromDirectory(
  vaultRoot: string,
  options: {
    signal?: AbortSignal;
    /** Scans an in-memory setup draft without making it the Vault's config. */
    config?: SiteConfigV1;
    fileSystem?: Partial<ScanFileSystemBoundary>;
    localAssetFileSystem?: Partial<LocalAssetFileSystemBoundary>;
    localAssetWebpDecoder?: WebpDecoderBoundary;
  } = {},
): Promise<SiteScanResult> {
  const fileSystem: ScanFileSystemBoundary = {
    readDirectory: async (directory) =>
      readdir(directory, { withFileTypes: true }),
    readTextFile: async (path) => readFile(path, 'utf8'),
    ...options.fileSystem,
  };
  throwIfAborted(options.signal);
  const loaded = options.config
    ? await loadDraftConfig(vaultRoot, options.config)
    : await loadSiteConfigFromDirectory(vaultRoot);
  throwIfAborted(options.signal);
  if (loaded.status === 'future-version') {
    const issues: ScanIssue[] = [
      {
        severity: 'blocker',
        code: 'future-version-readonly',
        path: 'version',
        message: `Site config version ${loaded.version} is newer than this plugin supports.`,
      },
    ];
    return {
      configRevision: loaded.revision,
      digest: digestScan(loaded.revision, [], issues),
      candidates: [],
      issues,
    };
  }
  const candidates: ScanCandidate[] = [];
  const issues: ScanIssue[] = [];
  const routeInputs: RouteArticleInput[] = [];
  const snapshots = new Map<string, ArticleSourceSnapshot>();

  for (let index = 0; index < loaded.config.contentRoots.length; index += 1) {
    const contentRoot = loaded.config.contentRoots[index] as (typeof loaded.config.contentRoots)[number];
    if (contentRoot.path === '.') {
      issues.push({
        severity: 'warning',
        code: 'vault-root-exposure',
        path: `content_roots[${index}].path`,
        message: 'The whole Vault is in publishing scope.',
      });
    }
    const absoluteRoot = join(vaultRoot, contentRoot.path);
    try {
      const markdownFiles = await findMarkdownFiles(
        absoluteRoot,
        fileSystem,
        options.signal,
      );
      for (const absolutePath of markdownFiles) {
        throwIfAborted(options.signal);
        const source = await fileSystem.readTextFile(absolutePath);
        throwIfAborted(options.signal);
        const sourcePath = toVaultPath(relative(vaultRoot, absolutePath));
        candidates.push({
          sourcePath,
          contentRootPath: contentRoot.path,
          sourceDigest: createHash('sha256').update(source).digest('hex'),
        });
        try {
          const snapshot = readArticleSnapshotFromSource(sourcePath, source);
          const metadata = snapshot.metadata;
          snapshots.set(sourcePath, snapshot);
          routeInputs.push({
            sourcePath,
            visibility: metadata.visibility.value,
            slug: metadata.slug.value,
            kind: metadata.kind.value,
            redirects: metadata.redirects.value,
            onlineUrl: metadata.deployment?.url,
          });
        } catch (error) {
          if (!(error instanceof ArticleMetadataValidationError)) throw error;
          for (const metadataIssue of error.issues) {
            issues.push({
              severity: 'blocker',
              code: metadataIssue.code,
              path: sourcePath,
              message: metadataIssue.message,
            });
          }
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        issues.push({
          severity: 'blocker',
          code: 'content-root-missing',
          path: `content_roots[${index}].path`,
          message: 'Configured content root is missing; publishing is blocked.',
        });
        continue;
      }
      issues.push({
        severity: 'blocker',
        code: 'content-root-unreadable',
        path: `content_roots[${index}].path`,
        message:
          'Configured content root is unreadable or unavailable; publishing is blocked.',
      });
      continue;
    }
  }

  candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  routeInputs.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const routePlan = planSiteRoutes(loaded.config, routeInputs);
  for (const routeIssue of routePlan.issues) {
    issues.push({
      severity: routeIssue.severity,
      code: routeIssue.code,
      path:
        routeIssue.sourcePath ??
        routeIssue.relatedSourcePaths?.[0] ??
        routeIssue.directoryPath ??
        routeIssue.route ??
        'routes',
      message: routeIssue.message,
    });
  }
  const assetPlan = await collectLocalPreviewAssets(
    vaultRoot,
    snapshots,
    loaded.config.assets.exclude,
    new Set(routePlan.articles.map((article) => article.sourcePath)),
    {
      fileSystem: options.localAssetFileSystem,
      signal: options.signal,
      // The bytes are retained only during this scan to derive the stable
      // publish-input digest, then released with the local asset plan.
      retainAssets: true,
      webpDecoder: options.localAssetWebpDecoder,
    },
  );
  for (const referenceIssue of inspectNoteReferences(snapshots, {
    isObsidianAsset: (sourcePath, target) =>
      assetPlan.claimsObsidianAsset(sourcePath, target),
  })) {
    issues.push({
      severity: referenceIssue.severity,
      code: referenceIssue.code,
      path: referenceIssue.sourcePath,
      line: referenceIssue.line,
      column: referenceIssue.column,
      message: referenceIssue.message,
      impact: referenceIssue.impact,
      dormant: referenceIssue.dormant,
      location: {
        path: referenceIssue.sourcePath,
        line: referenceIssue.line,
      },
    });
  }
  for (const assetIssue of assetPlan.issues) {
    issues.push({
      severity: assetIssue.severity,
      code: assetIssue.code,
      path: assetIssue.sourcePath,
      line: assetIssue.line,
      column: assetIssue.column,
      message: assetIssue.message,
      impact: assetIssue.impact,
      dormant: assetIssue.dormant,
      location: { path: assetIssue.sourcePath, line: assetIssue.line },
    });
  }
  for (const htmlIssue of inspectRawHtml(snapshots)) {
    issues.push({
      severity: htmlIssue.severity,
      code: htmlIssue.code,
      path: htmlIssue.sourcePath,
      line: htmlIssue.line,
      column: htmlIssue.column,
      message: htmlIssue.message,
      impact: htmlIssue.impact,
      dormant: htmlIssue.dormant,
      location: { path: htmlIssue.sourcePath, line: htmlIssue.line },
    });
  }
  for (const mermaidIssue of inspectMermaid(snapshots)) {
    issues.push({
      severity: mermaidIssue.severity,
      code: mermaidIssue.code,
      path: mermaidIssue.sourcePath,
      line: mermaidIssue.line,
      column: mermaidIssue.column,
      message: mermaidIssue.message,
      impact: mermaidIssue.impact,
      dormant: mermaidIssue.dormant,
      location: { path: mermaidIssue.sourcePath, line: mermaidIssue.line },
    });
  }
  for (const unsupportedIssue of inspectUnsupportedSyntax(snapshots)) {
    issues.push({
      severity: unsupportedIssue.severity,
      code: unsupportedIssue.code,
      path: unsupportedIssue.sourcePath,
      line: unsupportedIssue.line,
      column: unsupportedIssue.column,
      message: unsupportedIssue.message,
      impact: unsupportedIssue.impact,
      dormant: unsupportedIssue.dormant,
      location: {
        path: unsupportedIssue.sourcePath,
        line: unsupportedIssue.line,
      },
    });
  }
  issues.sort(compareScanIssues);
  const assetDigests = Object.entries(assetPlan.assets)
    .map(([path, asset]) => ({
      path,
      digest: createHash('sha256').update(asset.content).digest('hex'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    configRevision: loaded.revision,
    digest: digestScan(loaded.revision, candidates, issues, assetDigests),
    candidates,
    issues,
    externalLinks: assetPlan.externalLinks,
    routePlan,
  };
}

async function loadDraftConfig(
  vaultRoot: string,
  draft: SiteConfigV1,
): Promise<{
  status: 'editable';
  config: SiteConfigV1;
  revision: string;
  source: string;
}> {
  const config = await validateSiteConfigForDirectory(vaultRoot, draft);
  return {
    status: 'editable',
    config,
    revision: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    source: '',
  };
}

function compareScanIssues(left: ScanIssue, right: ScanIssue): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    left.code.localeCompare(right.code) ||
    left.severity.localeCompare(right.severity) ||
    left.message.localeCompare(right.message)
  );
}

function digestScan(
  configRevision: string,
  candidates: ScanCandidate[],
  issues: ScanIssue[],
  assetDigests: Array<{ path: string; digest: string }> = [],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ configRevision, candidates, issues, assetDigests }))
    .digest('hex');
}

async function findMarkdownFiles(
  directory: string,
  fileSystem: ScanFileSystemBoundary,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const entries = await fileSystem.readDirectory(directory);
  throwIfAborted(signal);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(path, fileSystem, signal)));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(path);
    }
  }
  return files;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Content scan aborted.');
  error.name = 'AbortError';
  throw error;
}

function toVaultPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
