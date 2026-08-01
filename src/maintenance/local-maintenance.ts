import type { DataAdapter } from 'obsidian';
import {
  MaintenanceRetentionCoordinator,
  PagesPublishMaintenanceService,
  type DiagnosticSnapshot,
  type RetentionTarget,
} from './maintenance-service';

/**
 * The host-safe subset that can run without OAuth, a release downloader, or
 * an Electron-only shell bridge: cache clearing and confirmed diagnostics.
 */
export function createLocalMaintenanceService(input: {
  directory: string;
  pluginVersion: string;
  platform: string;
  adapter: DataAdapter;
}): PagesPublishMaintenanceService {
  const retention = new MaintenanceRetentionCoordinator({
    policy: {
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxEntries: 20,
      maxBytes: 100 * 1024 * 1024,
    },
    targets: {
      logs: createAdapterRetentionTarget(input.adapter, childPath(input.directory, 'logs')),
      builds: createAdapterRetentionTarget(
        input.adapter,
        childPath(input.directory, 'builds'),
        undefined,
        true,
      ),
      receipts: createAdapterRetentionTarget(
        input.adapter,
        childPath(input.directory, 'receipts'),
        'deployment-recovery.json',
      ),
    },
  });
  const service = new PagesPublishMaintenanceService({
    cache: {
      clear: async () => {
        const cache = childPath(input.directory, 'cache');
        if (await input.adapter.exists(cache)) await input.adapter.rmdir(cache, true);
        await input.adapter.mkdir(cache);
      },
    },
    diagnostics: {
      collect: async (): Promise<DiagnosticSnapshot> => ({
        pluginVersion: input.pluginVersion,
        platform: input.platform,
        logs: [],
      }),
      write: async (source: string): Promise<string> => {
        const directory = childPath(input.directory, 'diagnostics');
        if (!(await input.adapter.exists(directory))) await input.adapter.mkdir(directory);
        const path = childPath(
          directory,
          `diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`,
        );
        await input.adapter.write(path, `${source}\n`);
        await retention.prune();
        return path;
      },
    },
    retention,
  });
  void retention.prune().catch(() => undefined);
  return service;
}

function childPath(directory: string, filename: string): string {
  const segments: string[] = [];
  for (const segment of `${directory}/${filename}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function createAdapterRetentionTarget(
  adapter: DataAdapter,
  directory: string,
  inProgressFilename?: string,
  directoriesAreArtifacts = false,
): RetentionTarget {
  return {
    list: async () => {
      if (!(await adapter.exists(directory))) return [];
      const listed = await adapter.list(directory);
      const paths = directoriesAreArtifacts ? listed.folders : listed.files;
      return (await Promise.all(paths.map(async (path) => {
        if (directoriesAreArtifacts) {
          const aggregate = await collectDirectoryArtifact(adapter, path);
          return {
            id: path,
            createdAt: new Date(aggregate.mtime).toISOString(),
            bytes: aggregate.bytes,
          };
        }
        const stats = await adapter.stat(path);
        if (!stats) return undefined;
        return {
          id: path,
          createdAt: new Date(stats.mtime).toISOString(),
          bytes: stats.size,
          ...(inProgressFilename !== undefined && path.endsWith(`/${inProgressFilename}`)
            ? { inProgress: true }
            : {}),
        };
      }))).filter((entry): entry is {
        id: string;
        createdAt: string;
        bytes: number;
        inProgress?: boolean;
      } => entry !== undefined);
    },
    remove: async (path) => {
      if (directoriesAreArtifacts) await adapter.rmdir(path, true);
      else await adapter.remove(path);
    },
  };
}

async function collectDirectoryArtifact(
  adapter: DataAdapter,
  directory: string,
): Promise<{ bytes: number; mtime: number }> {
  const listed = await adapter.list(directory);
  const fileStats = await Promise.all(listed.files.map((path) => adapter.stat(path)));
  const childStats = await Promise.all(listed.folders.map((path) => collectDirectoryArtifact(adapter, path)));
  const own = await adapter.stat(directory);
  return {
    bytes: fileStats.reduce((total, stats) => total + (stats?.size ?? 0), 0) +
      childStats.reduce((total, stats) => total + stats.bytes, 0),
    mtime: Math.max(
      own?.mtime ?? 0,
      ...fileStats.map((stats) => stats?.mtime ?? 0),
      ...childStats.map((stats) => stats.mtime),
    ),
  };
}
