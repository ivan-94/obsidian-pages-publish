import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentFactsCoordinator,
  FileSystemDeploymentStateStore,
  PublicationReconciliationRequiredError,
} from '../src/publication/deployment-facts';
import { readArticleMetadataFromDirectory } from '../src/publication/article-metadata';
import type { PublicationSnapshot } from '../src/publication/publish-center';

const vaults: string[] = [];

afterEach(async () => {
  await Promise.all(vaults.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('deployment facts coordinator', () => {
  it('writes article facts and a complete manifest only after an activated deployment is reconciled', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    await writeArticle(vault, 'notes/private.md', 'private');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const coordinator = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });

    await coordinator.reconcile(activatedDeployment(), snapshot());

    await expect(readArticleMetadataFromDirectory(vault, 'notes/one.md')).resolves.toMatchObject({
      deployment: {
        url: '/notes/one/',
        firstPublishedAt: '2026-08-01T10:20:30+08:00',
        lastPublishedAt: '2026-08-01T10:20:30+08:00',
        sourceDigest: 'article-one',
        deploymentId: 'deployment-1',
      },
    });
    await expect(readArticleMetadataFromDirectory(vault, 'notes/two.md')).resolves.toMatchObject({
      deployment: {
        url: '/notes/two/',
        sourceDigest: 'article-two',
        deploymentId: 'deployment-1',
      },
    });
    expect((await readArticleMetadataFromDirectory(vault, 'notes/private.md')).deployment).toBeUndefined();
    await expect(store.readLatestManifest()).resolves.toEqual({
      deploymentId: 'deployment-1',
      deploymentUrl: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-1',
      publishedAt: '2026-08-01T10:20:30+08:00',
      articles: [
        {
          sourcePath: 'notes/one.md',
          title: 'One',
          url: '/notes/one/',
          visibility: 'public',
          sourceDigest: 'article-one',
          firstPublishedAt: '2026-08-01T10:20:30+08:00',
          lastPublishedAt: '2026-08-01T10:20:30+08:00',
        },
        {
          sourcePath: 'notes/two.md',
          title: 'Two',
          url: '/notes/two/',
          visibility: 'unlisted',
          sourceDigest: 'article-two',
          firstPublishedAt: '2026-08-01T10:20:30+08:00',
          lastPublishedAt: '2026-08-01T10:20:30+08:00',
        },
      ],
    });
    await expect(store.readRecoveryReceipt()).resolves.toBeUndefined();
  });

  it('leaves the previous manifest unchanged and blocks a new publish when a multi-file fact write fails', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    await store.writeLatestManifest({
      deploymentId: 'deployment-old',
      deploymentUrl: 'https://old.pages.dev',
      scanDigest: 'old-scan',
      publishedAt: '2026-07-01T10:00:00+08:00',
      articles: [],
    });
    let writes = 0;
    const coordinator = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
      writeFacts: async (input) => {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
        await input.defaultWrite();
      },
    });

    await expect(coordinator.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    await expect(store.readLatestManifest()).resolves.toMatchObject({
      deploymentId: 'deployment-old',
    });
    await expect(store.readRecoveryReceipt()).resolves.toMatchObject({
      deployment: { deploymentId: 'deployment-1' },
    });
    await expect(coordinator.assertReadyForPublication()).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
  });

  it('preserves unchanged articles\' last publication time while advancing it only for changed articles', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const first = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });
    await first.reconcile(activatedDeployment(), snapshot());
    const second = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-02T04:05:06.000Z'),
    });

    await second.reconcile({
      deploymentId: 'deployment-2',
      url: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-2',
    }, {
      ...snapshot(),
      scanDigest: 'scan-2',
      articles: snapshot().articles.map((article) => article.sourcePath === 'notes/two.md'
        ? { ...article, sourceDigest: 'article-two-updated' }
        : article),
    });

    await expect(readArticleMetadataFromDirectory(vault, 'notes/one.md')).resolves.toMatchObject({
      deployment: {
        firstPublishedAt: '2026-08-01T10:20:30+08:00',
        lastPublishedAt: '2026-08-01T10:20:30+08:00',
        deploymentId: 'deployment-2',
      },
    });
    await expect(readArticleMetadataFromDirectory(vault, 'notes/two.md')).resolves.toMatchObject({
      deployment: {
        firstPublishedAt: '2026-08-01T10:20:30+08:00',
        lastPublishedAt: '2026-08-02T12:05:06+08:00',
        sourceDigest: 'article-two-updated',
        deploymentId: 'deployment-2',
      },
    });
  });

  it('clears deployment facts after a successful private, moved-out-of-root, or deleted-article takedown', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'public');
    await writeArticle(vault, 'notes/three.md', 'public');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const coordinator = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });
    const initial = {
      ...snapshot(),
      articles: [
        ...snapshot().articles.filter((article) => article.sourcePath !== 'notes/two.md'),
        {
          sourcePath: 'notes/two.md',
          title: 'Two',
          url: '/notes/two/',
          visibility: 'public' as const,
          sourceDigest: 'article-two',
        },
        {
          sourcePath: 'notes/three.md',
          title: 'Three',
          url: '/notes/three/',
          visibility: 'public' as const,
          sourceDigest: 'article-three',
        },
      ],
    } satisfies PublicationSnapshot;
    await coordinator.reconcile(activatedDeployment(), initial);

    const onePath = join(vault, 'notes', 'one.md');
    await writeFile(
      onePath,
      (await readFile(onePath, 'utf8')).replace('visibility: public', 'visibility: private'),
      'utf8',
    );
    await unlink(join(vault, 'notes', 'three.md'));
    await coordinator.reconcile({
      deploymentId: 'deployment-2',
      url: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-2',
    }, {
      ...snapshot(),
      scanDigest: 'scan-2',
      articles: [
        {
          sourcePath: 'notes/one.md',
          title: 'One',
          url: '/notes/one/',
          visibility: 'private',
          sourceDigest: 'article-one-private',
        },
      ],
    });

    expect((await readArticleMetadataFromDirectory(vault, 'notes/one.md')).deployment).toEqual({
      firstPublishedAt: '2026-08-01T10:20:30+08:00',
    });
    expect((await readArticleMetadataFromDirectory(vault, 'notes/two.md')).deployment).toEqual({
      firstPublishedAt: '2026-08-01T10:20:30+08:00',
    });
    await expect(store.readLatestManifest()).resolves.toMatchObject({
      deploymentId: 'deployment-2',
      articles: [],
    });
    await expect(store.readRecoveryReceipt()).resolves.toBeUndefined();
  });

  it('retains the original first publication time when a private article is published again', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const first = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });
    await first.reconcile(activatedDeployment(), snapshot());
    const onePath = join(vault, 'notes', 'one.md');
    await writeFile(
      onePath,
      (await readFile(onePath, 'utf8')).replace('visibility: public', 'visibility: private'),
      'utf8',
    );
    await new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-02T04:05:06.000Z'),
    }).reconcile({
      deploymentId: 'deployment-2',
      url: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-2',
    }, {
      ...snapshot(),
      scanDigest: 'scan-2',
      articles: snapshot().articles.map((article) => article.sourcePath === 'notes/one.md'
        ? { ...article, visibility: 'private' as const }
        : article),
    });
    await writeFile(
      onePath,
      (await readFile(onePath, 'utf8')).replace('visibility: private', 'visibility: public'),
      'utf8',
    );

    await new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-03T04:05:06.000Z'),
    }).reconcile({
      deploymentId: 'deployment-3',
      url: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-3',
    }, {
      ...snapshot(),
      scanDigest: 'scan-3',
      articles: snapshot().articles.map((article) => article.sourcePath === 'notes/one.md'
        ? { ...article, sourceDigest: 'article-one-republished' }
        : article),
    });

    await expect(readArticleMetadataFromDirectory(vault, 'notes/one.md')).resolves.toMatchObject({
      deployment: {
        firstPublishedAt: '2026-08-01T10:20:30+08:00',
        lastPublishedAt: '2026-08-03T12:05:06+08:00',
        deploymentId: 'deployment-3',
      },
    });
  });

  it('records a just-deleted snapshot article in the baseline without leaving reconciliation pending', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    await unlink(join(vault, 'notes', 'two.md'));
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const coordinator = new DeploymentFactsCoordinator({ vaultRoot: vault, store });

    await expect(coordinator.reconcile(activatedDeployment(), snapshot())).resolves.toMatchObject({
      deploymentId: 'deployment-1',
    });
    await expect(store.readRecoveryReceipt()).resolves.toBeUndefined();
    const manifest = await store.readLatestManifest();
    expect(manifest?.articles.find((article) => article.sourcePath === 'notes/two.md')).toMatchObject({
      sourcePath: 'notes/two.md',
      title: 'Two',
      url: '/notes/two/',
      visibility: 'unlisted',
      sourceDigest: 'article-two',
    });
  });

  it('verifies the exact remote deployment then resumes an interrupted reconciliation idempotently after restart', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    let writes = 0;
    const interrupted = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
      writeFacts: async (input) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated local failure');
        await input.defaultWrite();
      },
    });
    await expect(interrupted.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    const resumed = new DeploymentFactsCoordinator({ vaultRoot: vault, store });
    const inspect = vi.fn(async (deploymentId: string) => ({
      deploymentId,
      url: 'https://deploy-wiki.pages.dev',
      status: 'success' as const,
    }));

    const recovered = await resumed.recover({ inspect });
    expect(recovered).toMatchObject({
      deploymentId: 'deployment-1',
      deploymentUrl: 'https://deploy-wiki.pages.dev',
      scanDigest: 'scan-1',
      publishedAt: '2026-08-01T10:20:30+08:00',
    });
    expect(recovered?.articles).toHaveLength(2);
    expect(inspect).toHaveBeenCalledWith('deployment-1');
    await expect(resumed.recover({ inspect })).resolves.toBeUndefined();
    await expect(store.readRecoveryReceipt()).resolves.toBeUndefined();
    await expect(store.readLatestManifest()).resolves.toMatchObject({
      deploymentId: 'deployment-1',
    });
    await expect(readArticleMetadataFromDirectory(vault, 'notes/two.md')).resolves.toMatchObject({
      deployment: { deploymentId: 'deployment-1' },
    });
  });

  it('persists the original Pages target before activation and reconciles a later success without rereading current configuration', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const interrupted = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });

    await interrupted.recordPendingActivation({
      deploymentId: 'deployment-unknown',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'original-account',
        projectName: 'original-project',
      },
      snapshot: { ...snapshot(), scanDigest: 'scan-unknown' },
    });
    await expect(interrupted.assertReadyForPublication()).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );

    const resumed = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      now: () => new Date('2026-08-01T02:20:30.000Z'),
    });
    const inspectPending = vi.fn(async () => ({
      deploymentId: 'deployment-unknown',
      url: 'https://deployment-unknown.original-project.pages.dev',
      status: 'success',
    }));

    await expect(resumed.recover({
      inspect: async () => {
        throw new Error('current configuration must not be used');
      },
      inspectPending,
    })).resolves.toMatchObject({ deploymentId: 'deployment-unknown' });
    expect(inspectPending).toHaveBeenCalledWith({
      deploymentId: 'deployment-unknown',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'original-account',
        projectName: 'original-project',
      },
    });
    await expect(store.readPendingActivation()).resolves.toBeUndefined();
    await expect(store.readLatestManifest()).resolves.toMatchObject({
      deploymentId: 'deployment-unknown',
      scanDigest: 'scan-unknown',
    });
  });

  it('blocks publication and automated recovery for an upload-uncertain receipt without a deployment identity', async () => {
    const { vault, stateDirectory } = await createVault();
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const coordinator = new DeploymentFactsCoordinator({ vaultRoot: vault, store });

    await coordinator.recordPendingActivation({
      target: {
        provider: 'cloudflare-pages',
        accountId: 'original-account',
        projectName: 'original-project',
      },
      snapshot: snapshot(),
    });

    await expect(coordinator.assertReadyForPublication()).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    const inspectPending = vi.fn(async () => ({
      deploymentId: 'not-reached',
      url: 'https://not-reached.pages.dev',
      status: 'success',
    }));
    await expect(coordinator.recover({
      inspect: async () => {
        throw new Error('not used');
      },
      inspectPending,
    })).rejects.toBeInstanceOf(PublicationReconciliationRequiredError);
    expect(inspectPending).not.toHaveBeenCalled();

    await coordinator.acknowledgeUploadUncertainActivation();
    await expect(store.readPendingActivation()).resolves.toBeUndefined();
    await expect(coordinator.assertReadyForPublication()).resolves.toBeUndefined();
  });

  it('keeps the receipt and refuses recovery when the remote verifier returns a different deployment', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const interrupted = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      writeFacts: async () => {
        throw new Error('local write unavailable');
      },
    });
    await expect(interrupted.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );

    const restarted = new DeploymentFactsCoordinator({ vaultRoot: vault, store });
    await expect(restarted.recover({
      inspect: async () => ({
        deploymentId: 'different-deployment',
        url: 'https://wrong.pages.dev',
        status: 'success' as const,
      }),
    })).rejects.toBeInstanceOf(PublicationReconciliationRequiredError);
    await expect(store.readRecoveryReceipt()).resolves.toMatchObject({
      deployment: { deploymentId: 'deployment-1' },
    });
  });

  it('keeps the receipt when recovery verification reports a different URL or a non-successful deployment', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const interrupted = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      writeFacts: async () => {
        throw new Error('local write unavailable');
      },
    });
    await expect(interrupted.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    const restarted = new DeploymentFactsCoordinator({ vaultRoot: vault, store });

    await expect(restarted.recover({
      inspect: async () => ({
        deploymentId: 'deployment-1',
        url: 'https://another.pages.dev',
        status: 'success',
      }),
    })).rejects.toBeInstanceOf(PublicationReconciliationRequiredError);
    await expect(restarted.recover({
      inspect: async () => ({
        deploymentId: 'deployment-1',
        url: 'https://deploy-wiki.pages.dev',
        status: 'failed',
      }),
    })).rejects.toBeInstanceOf(PublicationReconciliationRequiredError);
    await expect(store.readRecoveryReceipt()).resolves.toMatchObject({
      deployment: { deploymentId: 'deployment-1' },
    });
  });

  it('rejects a receipt whose deployment identity disagrees with its manifest', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const store = new FileSystemDeploymentStateStore(stateDirectory);
    const interrupted = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store,
      writeFacts: async () => {
        throw new Error('local write unavailable');
      },
    });
    await expect(interrupted.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    const receiptPath = join(stateDirectory, 'deployment-recovery.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      manifest: { deploymentId: string };
    };
    receipt.manifest.deploymentId = 'substituted-deployment';
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');

    await expect(store.readRecoveryReceipt()).rejects.toThrow('unsupported format');
  });

  it('fails safely when the state directory cannot confirm a durable receipt rename', async () => {
    const { vault, stateDirectory } = await createVault();
    await writeArticle(vault, 'notes/one.md', 'public');
    await writeArticle(vault, 'notes/two.md', 'unlisted');
    const syncDirectory = vi.fn(async () => {
      throw new Error('directory fsync unavailable');
    });
    const store = new FileSystemDeploymentStateStore(stateDirectory, { syncDirectory });
    const coordinator = new DeploymentFactsCoordinator({ vaultRoot: vault, store });

    await expect(coordinator.reconcile(activatedDeployment(), snapshot())).rejects.toBeInstanceOf(
      PublicationReconciliationRequiredError,
    );
    expect(syncDirectory).toHaveBeenCalledTimes(1);
    await expect(store.readRecoveryReceipt()).resolves.toMatchObject({
      deployment: { deploymentId: 'deployment-1' },
    });
  });

  it('treats a missing deployment manifest as unknown, not as a request to infer takedowns', async () => {
    const { vault, stateDirectory } = await createVault();
    const coordinator = new DeploymentFactsCoordinator({
      vaultRoot: vault,
      store: new FileSystemDeploymentStateStore(stateDirectory),
    });

    await expect(coordinator.getBaseline()).resolves.toEqual({ status: 'missing' });
  });
});

async function createVault(): Promise<{ vault: string; stateDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'pages-publish-facts-'));
  vaults.push(directory);
  const vault = join(directory, 'vault');
  const stateDirectory = join(directory, 'state');
  await mkdir(join(vault, 'notes'), { recursive: true });
  return { vault, stateDirectory };
}

async function writeArticle(
  vault: string,
  sourcePath: string,
  visibility: 'public' | 'unlisted' | 'private',
): Promise<void> {
  const title = sourcePath.includes('one') ? 'One' : sourcePath.includes('two') ? 'Two' : 'Private';
  await writeFile(join(vault, sourcePath), [
    '---',
    'publication:',
    `  visibility: ${visibility}`,
    '---',
    `# ${title}`,
    '',
  ].join('\n'), 'utf8');
}

function activatedDeployment(): { deploymentId: string; url: string; scanDigest: string } {
  return {
    deploymentId: 'deployment-1',
    url: 'https://deploy-wiki.pages.dev',
    scanDigest: 'scan-1',
  };
}

function snapshot(): PublicationSnapshot {
  return {
    scanDigest: 'scan-1',
    files: {},
    assets: {},
    output: { fileCount: 0, assetCount: 0, assetBytes: 0 },
    timeZone: 'Asia/Shanghai',
    articles: [
      {
        sourcePath: 'notes/one.md',
        title: 'One',
        url: '/notes/one/',
        visibility: 'public',
        sourceDigest: 'article-one',
      },
      {
        sourcePath: 'notes/two.md',
        title: 'Two',
        url: '/notes/two/',
        visibility: 'unlisted',
        sourceDigest: 'article-two',
      },
      {
        sourcePath: 'notes/private.md',
        title: 'Private',
        url: '/notes/private/',
        visibility: 'private',
        sourceDigest: 'article-private',
      },
    ],
  };
}
