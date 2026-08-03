import { describe, expect, it } from 'vitest';
import {
  validateQuartzEngineManifest,
  type QuartzEngineManifest,
} from '../src/runtime/quartz-engine-manifest';

describe('Quartz engine manifest', () => {
  it('accepts an exact Quartz release for the current native platform', () => {
    const manifest: QuartzEngineManifest = {
      engineVersion: 'pages-publish-quartz-5.0.0.1',
      quartzVersion: '5.0.0',
      sourceUrl:
        'https://github.com/jackyzha0/quartz/archive/0123456789abcdef0123456789abcdef01234567.tar.gz',
      sourceSha256: 'a'.repeat(64),
      lockfileSha256: 'b'.repeat(64),
      nodeRange: '>=22',
      npmVersionRange: '>=10.9.2',
      platform: 'darwin-arm64',
      runtimeAssets: [{
        outputPath: 'static/vendor/example.js',
        sourceUrl: 'https://cdn.jsdelivr.net/npm/example@1.2.3/dist/example.min.js',
        sourceSha256: 'c'.repeat(64),
      }],
    };

    expect(validateQuartzEngineManifest(manifest, 'darwin-arm64')).toEqual(manifest);
  });

  it('rejects mutable or unsafe runtime asset declarations', () => {
    const manifest: QuartzEngineManifest = {
      engineVersion: 'pages-publish-quartz-5.0.0.2',
      quartzVersion: '5.0.0',
      sourceUrl:
        'https://github.com/jackyzha0/quartz/archive/0123456789abcdef0123456789abcdef01234567.tar.gz',
      sourceSha256: 'a'.repeat(64),
      lockfileSha256: 'b'.repeat(64),
      nodeRange: '>=22',
      npmVersionRange: '>=10.9.2',
      platform: 'darwin-arm64',
      runtimeAssets: [{
        outputPath: '../escape.js',
        sourceUrl: 'https://cdn.jsdelivr.net/npm/example@latest/dist/example.js',
        sourceSha256: 'bad',
      }],
    };

    expect(() => validateQuartzEngineManifest(manifest, 'darwin-arm64')).toThrow(
      'runtime assets',
    );
  });

  it('rejects a mutable Quartz source reference', () => {
    const manifest: QuartzEngineManifest = {
      engineVersion: 'pages-publish-quartz-5.0.0.1',
      quartzVersion: '5.0.0',
      sourceUrl: 'https://github.com/jackyzha0/quartz/archive/v5.tar.gz',
      sourceSha256: 'a'.repeat(64),
      lockfileSha256: 'b'.repeat(64),
      nodeRange: '>=22',
      npmVersionRange: '>=10.9.2',
      platform: 'darwin-arm64',
    };

    expect(() => validateQuartzEngineManifest(manifest, 'darwin-arm64')).toThrow(
      'immutable Quartz source archive',
    );
  });

  it('rejects a source archive without exact archive and lockfile checksums', () => {
    const manifest: QuartzEngineManifest = {
      engineVersion: 'pages-publish-quartz-5.0.0.1',
      quartzVersion: '5.0.0',
      sourceUrl:
        'https://github.com/jackyzha0/quartz/archive/0123456789abcdef0123456789abcdef01234567.tar.gz',
      sourceSha256: 'not-a-checksum',
      lockfileSha256: 'b'.repeat(64),
      nodeRange: '>=22',
      npmVersionRange: '>=10.9.2',
      platform: 'darwin-arm64',
    };

    expect(() => validateQuartzEngineManifest(manifest, 'darwin-arm64')).toThrow(
      'SHA-256 checksums',
    );
  });

  it('rejects an engine manifest that can select Node 20 or a floating Quartz version', () => {
    const manifest: QuartzEngineManifest = {
      engineVersion: 'latest',
      quartzVersion: 'v5',
      sourceUrl:
        'https://github.com/jackyzha0/quartz/archive/0123456789abcdef0123456789abcdef01234567.tar.gz',
      sourceSha256: 'a'.repeat(64),
      lockfileSha256: 'b'.repeat(64),
      nodeRange: '>=20.19',
      npmVersionRange: 'latest',
      platform: 'darwin-arm64',
    };

    expect(() => validateQuartzEngineManifest(manifest, 'darwin-arm64')).toThrow(
      'exact engine and runtime versions',
    );
  });
});
