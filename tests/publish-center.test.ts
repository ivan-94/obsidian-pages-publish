import { describe, expect, it } from 'vitest';
import {
  createPublicationSnapshot,
  createPublishCenterState,
  materializePublicationSnapshotAssets,
} from '../src/publication/publish-center';

describe('publish center state', () => {
  it('reports a selected article with a changed source digest as an update from the last successful deployment', () => {
    const state = createPublishCenterState({
      siteName: 'Release wiki',
      scan: {
        configRevision: 'config',
        digest: 'scan-2',
        candidates: [],
        issues: [],
      },
      articles: [
        {
          sourcePath: 'notes/release.md',
          title: 'Release notes',
          url: '/notes/release/',
          visibility: 'public',
          sourceDigest: 'current-digest',
        },
      ],
      baseline: {
        status: 'available',
        articles: [
          {
            sourcePath: 'notes/release.md',
            sourceDigest: 'previous-digest',
            url: '/notes/release/',
            visibility: 'public',
          },
        ],
      },
    });

    expect(state).toMatchObject({
      baseline: 'available',
      canPublish: true,
      summary: { changes: 1, updated: 1 },
      articles: [
        expect.objectContaining({
          sourcePath: 'notes/release.md',
          change: 'updated',
          nextIncluded: true,
        }),
      ],
    });
  });

  it('keeps a complete build available but marks article status unknown when the deployment manifest is missing', () => {
    const state = createPublishCenterState({
      siteName: 'Release wiki',
      scan: {
        configRevision: 'config',
        digest: 'scan-3',
        candidates: [],
        issues: [],
      },
      articles: [
        {
          sourcePath: 'notes/release.md',
          title: 'Release notes',
          url: '/notes/release/',
          visibility: 'public',
          sourceDigest: 'current-digest',
        },
      ],
      baseline: { status: 'missing' },
      output: { fileCount: 9, assetCount: 2, assetBytes: 2048 },
    });

    expect(state).toMatchObject({
      baseline: 'unknown',
      canPublish: true,
      summary: { changes: 1, unknown: 1 },
      output: { fileCount: 9, assetCount: 2, assetBytes: 2048 },
      articles: [expect.objectContaining({ change: 'unknown', nextIncluded: true })],
    });
  });

  it('stores asset bytes as immutable values and returns a fresh deployable copy to each consumer', () => {
    const snapshot = createPublicationSnapshot(
      { configRevision: 'config', digest: 'scan', candidates: [], issues: [] },
      {
        siteName: 'Snapshot',
        pages: [],
        articles: [],
        files: {},
        assets: {
          '/assets/logo.png': {
            content: new Uint8Array([1, 2, 3]),
            contentType: 'image/png',
          },
        },
        routePlan: { articles: [], sections: [], systemRoutes: [], redirects: [], issues: [] },
      },
    );

    expect(snapshot.assets['/assets/logo.png']).toEqual({
      contentBase64: 'AQID',
      contentType: 'image/png',
    });
    expect(Object.isFrozen(snapshot.output)).toBe(true);
    const first = materializePublicationSnapshotAssets(snapshot);
    const firstAsset = first['/assets/logo.png'];
    expect(firstAsset).toBeDefined();
    if (firstAsset) firstAsset.content[0] = 99;
    const second = materializePublicationSnapshotAssets(snapshot);
    expect(second['/assets/logo.png']?.content).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('keeps a baseline-only takedown as a read-only historical item rather than an editable article', () => {
    const state = createPublishCenterState({
      siteName: 'Release wiki',
      scan: { configRevision: 'config', digest: 'scan', candidates: [], issues: [] },
      articles: [],
      baseline: {
        status: 'available',
        articles: [{
          sourcePath: 'notes/deleted.md',
          title: 'Deleted article',
          sourceDigest: 'old',
          url: '/notes/deleted/',
          visibility: 'public',
        }],
      },
    });

    expect(state.articles).toEqual([
      expect.objectContaining({
        change: 'takedown',
        nextIncluded: false,
        availability: 'historical',
      }),
    ]);
  });

  it('distinguishes URL and visibility changes from ordinary content updates', () => {
    const state = createPublishCenterState({
      siteName: 'Release wiki',
      scan: { configRevision: 'config', digest: 'scan', candidates: [], issues: [] },
      articles: [
        {
          sourcePath: 'notes/moved.md', title: 'Moved', url: '/notes/new/',
          visibility: 'public', sourceDigest: 'same',
        },
        {
          sourcePath: 'notes/hidden.md', title: 'Hidden', url: '/notes/hidden/',
          visibility: 'unlisted', sourceDigest: 'same',
        },
      ],
      baseline: {
        status: 'available',
        articles: [
          {
            sourcePath: 'notes/moved.md', sourceDigest: 'same', url: '/notes/old/',
            visibility: 'public',
          },
          {
            sourcePath: 'notes/hidden.md', sourceDigest: 'same', url: '/notes/hidden/',
            visibility: 'public',
          },
        ],
      },
    });

    expect(state.articles.map((article) => article.change)).toEqual([
      'visibility-changed',
      'url-changed',
    ]);
    expect(state.summary).toMatchObject({ urlChanged: 1, visibilityChanged: 1 });
  });
});
