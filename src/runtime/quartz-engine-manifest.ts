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
  signature?: string;
  signingKeyId?: string;
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
  return Object.freeze({ ...manifest });
}
