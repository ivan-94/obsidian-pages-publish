import type { SupportedPlatformIdentity } from '../plugin/platform';
import type { QuartzEngineManifest } from './quartz-engine-manifest';

const quartzCommit = '74b3fc9efd0caafea3dbcd846ddf1f06855b6d2a';

export function builtinQuartzEngineManifest(
  platform: SupportedPlatformIdentity,
): Readonly<QuartzEngineManifest> {
  return Object.freeze({
    engineVersion: 'pages-publish-quartz-5.0.0.3',
    quartzVersion: '5.0.0',
    sourceUrl: `https://github.com/jackyzha0/quartz/archive/${quartzCommit}.tar.gz`,
    sourceSha256: '69380b2e3acf3590ad144304e4e97be621562b1ab14512c2537ad348d707c3aa',
    lockfileSha256: '1f9861ba0628e86f85a4989546d2201b8d3a64c198db5c6d6ca8cdcb9d061e5c',
    nodeRange: '>=22',
    npmVersionRange: '>=10.9.2',
    platform,
    runtimeAssets: Object.freeze([{
      outputPath: 'static/vendor/d3-7.9.0.min.js',
      sourceUrl: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
      sourceSha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539',
    }, {
      outputPath: 'static/vendor/pixi-8.8.1.min.js',
      sourceUrl: 'https://cdn.jsdelivr.net/npm/pixi.js@8.8.1/dist/pixi.min.js',
      sourceSha256: '420003e19a8cb3973087178a0b665af06762d3325a1afcbc3bb37cea5370b193',
    }]),
  });
}
