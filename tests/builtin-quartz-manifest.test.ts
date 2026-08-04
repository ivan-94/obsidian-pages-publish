import { describe, expect, it } from 'vitest';
import { builtinQuartzEngineManifest } from '../src/runtime/builtin-quartz-manifest';
import { validateQuartzEngineManifest } from '../src/runtime/quartz-engine-manifest';

describe('built-in Quartz engine manifest', () => {
  it.each(['darwin-arm64', 'darwin-x64'] as const)(
    'pins an immutable Quartz source and lockfile for %s',
    (platform) => {
      const manifest = builtinQuartzEngineManifest(platform);

      expect(validateQuartzEngineManifest(manifest, platform)).toEqual(manifest);
      expect(manifest).toMatchObject({
        engineVersion: 'pages-publish-quartz-5.0.0.3',
        quartzVersion: '5.0.0',
        sourceSha256: '69380b2e3acf3590ad144304e4e97be621562b1ab14512c2537ad348d707c3aa',
        lockfileSha256: '1f9861ba0628e86f85a4989546d2201b8d3a64c198db5c6d6ca8cdcb9d061e5c',
      });
      expect(manifest.runtimeAssets).toHaveLength(2);
      expect(Object.isFrozen(manifest)).toBe(true);
    },
  );
});
