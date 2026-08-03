import type { SupportedPlatformIdentity } from '../plugin/platform';

export interface QuartzEngineManifest {
  engineVersion: string;
  quartzVersion: string;
  sourceUrl: string;
  sourceSha256: string;
  lockfileSha256: string;
  nodeRange: string;
  npmVersionRange: string;
  platform: SupportedPlatformIdentity;
  runtimeAssets?: readonly QuartzRuntimeAssetManifest[];
  signature?: string;
  signingKeyId?: string;
}

export interface QuartzRuntimeAssetManifest {
  outputPath: string;
  sourceUrl: string;
  sourceSha256: string;
}

export function validateQuartzEngineManifest(
  manifest: QuartzEngineManifest,
  platform: SupportedPlatformIdentity,
): Readonly<QuartzEngineManifest> {
  if (manifest.platform !== platform) {
    throw new Error('The Quartz engine manifest targets a different platform.');
  }
  let source: URL;
  try {
    source = new URL(manifest.sourceUrl);
  } catch {
    throw new Error('The Quartz engine manifest requires an immutable Quartz source archive.');
  }
  if (
    source.origin !== 'https://github.com'
    || source.search.length > 0
    || source.hash.length > 0
    || !/^\/jackyzha0\/quartz\/archive\/[a-f0-9]{40}\.tar\.gz$/u.test(source.pathname)
  ) {
    throw new Error('The Quartz engine manifest requires an immutable Quartz source archive.');
  }
  if (
    !/^[a-f0-9]{64}$/iu.test(manifest.sourceSha256)
    || !/^[a-f0-9]{64}$/iu.test(manifest.lockfileSha256)
  ) {
    throw new Error('The Quartz engine manifest requires exact SHA-256 checksums.');
  }
  if (
    !/^pages-publish-quartz-\d+\.\d+\.\d+\.\d+$/u.test(manifest.engineVersion)
    || !/^\d+\.\d+\.\d+$/u.test(manifest.quartzVersion)
    || manifest.nodeRange !== '>=22'
    || manifest.npmVersionRange !== '>=10.9.2'
  ) {
    throw new Error(
      'The Quartz engine manifest requires exact engine and runtime versions.',
    );
  }
  const runtimeAssets = manifest.runtimeAssets?.map((asset) => {
    let source: URL;
    try {
      source = new URL(asset.sourceUrl);
    } catch {
      throw new Error('The Quartz engine manifest requires immutable runtime assets.');
    }
    if (
      !/^static\/vendor\/[A-Za-z0-9._-]+\.js$/u.test(asset.outputPath)
      || source.origin !== 'https://cdn.jsdelivr.net'
      || source.search.length > 0
      || source.hash.length > 0
      || !/^\/npm\/[A-Za-z0-9@._/-]+@\d+\.\d+\.\d+\/[A-Za-z0-9._/-]+\.js$/u.test(source.pathname)
      || !/^[a-f0-9]{64}$/iu.test(asset.sourceSha256)
    ) {
      throw new Error('The Quartz engine manifest requires immutable, safe runtime assets.');
    }
    return Object.freeze({ ...asset, sourceSha256: asset.sourceSha256.toLowerCase() });
  });
  if (runtimeAssets && new Set(runtimeAssets.map((asset) => asset.outputPath)).size !== runtimeAssets.length) {
    throw new Error('The Quartz engine manifest requires unique runtime assets.');
  }
  return Object.freeze({
    ...manifest,
    ...(runtimeAssets === undefined ? {} : { runtimeAssets: Object.freeze(runtimeAssets) }),
  });
}
