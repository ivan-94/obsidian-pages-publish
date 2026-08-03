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
        engineVersion: 'pages-publish-quartz-5.0.0.2',
        quartzVersion: '5.0.0',
        sourceSha256: '69380b2e3acf3590ad144304e4e97be621562b1ab14512c2537ad348d707c3aa',
        lockfileSha256: 'bca1aff728d3257b8ca6989f9a4d9913836ab1f1a034505d3e3c481b3dab3e05',
      });
      expect(manifest.runtimeAssets).toHaveLength(2);
      expect(Object.isFrozen(manifest)).toBe(true);
    },
  );
});
