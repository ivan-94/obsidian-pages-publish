import { readdir } from 'fs/promises';
import { extname, join, relative, sep } from 'path';
import type { SiteConfigV1 } from '../config/site-config';
import {
  ArticleMetadataValidationError,
  readArticleSnapshotFromDirectory,
  type ArticleSourceSnapshot,
} from '../publication/article-metadata';
import {
  RoutePlanningError,
  type RouteArticleInput,
  type RouteIssue,
} from './route-planner';

export interface DirectoryRouteSources {
  snapshots: Map<string, ArticleSourceSnapshot>;
  inputs: RouteArticleInput[];
}

export interface CollectedDirectoryRouteSources extends DirectoryRouteSources {
  issues: RouteIssue[];
}

export async function loadDirectoryRouteSources(
  vaultRoot: string,
  config: SiteConfigV1,
): Promise<DirectoryRouteSources> {
  const collected = await collectDirectoryRouteSources(vaultRoot, config);
  if (collected.issues.length > 0) {
    throw new RoutePlanningError(collected.issues);
  }
  return { snapshots: collected.snapshots, inputs: collected.inputs };
}

export async function collectDirectoryRouteSources(
  vaultRoot: string,
  config: SiteConfigV1,
): Promise<CollectedDirectoryRouteSources> {
  const snapshots = new Map<string, ArticleSourceSnapshot>();
  const issues: RouteIssue[] = [];
  for (const contentRoot of config.contentRoots) {
    let markdownFiles: string[];
    try {
      markdownFiles = await findMarkdownFiles(join(vaultRoot, contentRoot.path));
    } catch (error) {
      issues.push({
        severity: 'blocker',
        code: isErrno(error, 'ENOENT')
          ? 'content-root-missing'
          : 'content-root-unreadable',
        directoryPath: contentRoot.path,
        message: isErrno(error, 'ENOENT')
          ? 'Configured content root is missing; publishing is blocked.'
          : 'Configured content root is unreadable or unavailable; publishing is blocked.',
      });
      continue;
    }
    for (const absolutePath of markdownFiles) {
      const sourcePath = toVaultPath(relative(vaultRoot, absolutePath));
      try {
        snapshots.set(
          sourcePath,
          await readArticleSnapshotFromDirectory(vaultRoot, sourcePath),
        );
      } catch (error) {
        if (error instanceof ArticleMetadataValidationError) {
          for (const metadataIssue of error.issues) {
            issues.push({
              severity: 'blocker',
              code: metadataIssue.code,
              sourcePath,
              message: metadataIssue.message,
            });
          }
          continue;
        }
        issues.push({
          severity: 'blocker',
          code: 'article-source-unreadable',
          sourcePath,
          message: 'Article source is unreadable or unsafe.',
        });
      }
    }
  }
  const inputs = [...snapshots.values()]
    .map((snapshot) => ({
      sourcePath: snapshot.sourcePath,
      visibility: snapshot.metadata.visibility.value,
      slug: snapshot.metadata.slug.value,
      kind: snapshot.metadata.kind.value,
      redirects: snapshot.metadata.redirects.value,
      onlineUrl: snapshot.metadata.deployment?.url,
    }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return { snapshots, inputs, issues };
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

function toVaultPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
