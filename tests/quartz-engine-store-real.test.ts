import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinQuartzEngineManifest } from '../src/runtime/builtin-quartz-manifest';
import { createQuartzEngineSmoke } from '../src/runtime/quartz-engine-smoke';
import { QuartzEngineStore } from '../src/runtime/quartz-engine-store';

const sourceArchive = process.env.PAGES_PUBLISH_QUARTZ_ARCHIVE;
const nodeExecutable = process.env.PAGES_PUBLISH_NODE22;

describe('real Quartz engine installation', () => {
  it.skipIf(!sourceArchive || !nodeExecutable)(
    'installs the pinned lockfile, activates only after smoke, and then reuses it offline',
    async () => {
      const rootDirectory = await mkdtemp(join(tmpdir(), 'pages-real-engine-store-'));
      const archive = new Uint8Array(await readFile(sourceArchive!));
      const runtimeRoot = resolve(dirname(nodeExecutable!), '..');
      const runtime = {
        nodeExecutable: nodeExecutable!,
        nodeVersion: '22.23.1',
        npmCliPath: join(runtimeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        npmVersion: '10.9.8',
        source: 'managed' as const,
      };
      const manifest = builtinQuartzEngineManifest('darwin-arm64');
      const smoke = createQuartzEngineSmoke(join(rootDirectory, 'smoke'));
      const store = new QuartzEngineStore({
        rootDirectory,
        download: async () => archive,
        smoke,
      });

      const installed = await store.ensureReady(manifest, runtime);

      expect(installed.usingFallback).toBe(false);
      await expect(
        access(join(installed.engineDirectory, '.pages-publish-dependencies.json')),
      ).resolves.toBeUndefined();

      const offlineStore = new QuartzEngineStore({
        rootDirectory,
        download: async () => {
          throw new Error('network must not be used');
        },
        smoke,
      });
      await expect(offlineStore.ensureReady(manifest, runtime)).resolves.toMatchObject({
        engineDirectory: installed.engineDirectory,
        usingFallback: false,
      });
    },
    120_000,
  );
});
