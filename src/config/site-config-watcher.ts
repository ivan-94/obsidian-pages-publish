import { watch } from 'fs';

export interface SiteConfigWatcherBoundary {
  watch(
    root: string,
    listener: (event: string, filename: string | Buffer | null) => void,
  ): { close(): void };
}

export function watchSiteConfigChanges(
  vaultRoot: string,
  onChange: () => void,
  boundary: SiteConfigWatcherBoundary = {
    watch: (root, listener) =>
      watch(root, { recursive: true }, (event, filename) => {
        listener(event, filename);
      }),
  },
): () => void {
  const watcher = boundary.watch(vaultRoot, (_event, filename) => {
    if (filename === null) return;
    const normalized = filename.toString().replaceAll('\\', '/');
    if (normalized === '.publish/site.yml') onChange();
  });
  return () => watcher.close();
}
