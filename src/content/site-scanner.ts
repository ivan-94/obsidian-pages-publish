import { createHash } from 'crypto';
import type { Dirent } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { extname, join, relative, sep } from 'path';
import { loadSiteConfigFromDirectory } from '../config/site-config';
import {
  ArticleMetadataValidationError,
  readArticleMetadataFromSource,
} from '../publication/article-metadata';
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
    fileSystem?: Partial<ScanFileSystemBoundary>;
  } = {},
): Promise<SiteScanResult> {
  const fileSystem: ScanFileSystemBoundary = {
    readDirectory: async (directory) =>
      readdir(directory, { withFileTypes: true }),
    readTextFile: async (path) => readFile(path, 'utf8'),
    ...options.fileSystem,
  };
  throwIfAborted(options.signal);
  const loaded = await loadSiteConfigFromDirectory(vaultRoot);
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
          const metadata = readArticleMetadataFromSource(sourcePath, source);
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
  return {
    configRevision: loaded.revision,
    digest: digestScan(loaded.revision, candidates, issues),
    candidates,
    issues,
    routePlan,
  };
}

function digestScan(
  configRevision: string,
  candidates: ScanCandidate[],
  issues: ScanIssue[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ configRevision, candidates, issues }))
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
