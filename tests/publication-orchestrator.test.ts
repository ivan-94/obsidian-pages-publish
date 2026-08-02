import { describe, expect, it, vi } from 'vitest';
import {
  PublicationOrchestrator,
  type CloudflarePagesDeploymentBoundary,
} from '../src/publication/publish-orchestrator';
import { PublicationReconciliationRequiredError } from '../src/publication/deployment-facts';
import type { PublicationSnapshot } from '../src/publication/publish-center';

function snapshot(scanDigest = 'scan-1'): PublicationSnapshot {
  return {
    scanDigest,
    files: Object.freeze({
      '/index.html': '<h1>Release notes</h1>',
      '/notes/release/index.html': '<article>Ready</article>',
    }),
    assets: Object.freeze({}),
    articles: Object.freeze([]),
    output: Object.freeze({ fileCount: 2, assetCount: 0, assetBytes: 0 }),
  };
}

describe('publication orchestrator', () => {
  it('does not expose its internal safe-error type to deployment adapters', async () => {
    const publicationModule = await import('../src/publication/publish-orchestrator');

    expect(publicationModule).not.toHaveProperty('PublicationOrchestrationError');
  });

  it('revalidates, builds, uploads, and activates one frozen site snapshot', async () => {
    const stages: string[] = [];
    const adapter: CloudflarePagesDeploymentBoundary = {
      validate: async () => undefined,
      upload: async (input) => {
        stages.push(`upload:${input.files['/notes/release/index.html']}`);
        return { deploymentId: 'staged-1' };
      },
      activate: async (input) => {
        stages.push(`activate:${input.deploymentId}`);
        return { deploymentId: input.deploymentId, url: 'https://release.pages.dev' };
      },
    };
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => {
        stages.push('prepare');
        return snapshot();
      },
      build: async (input) => {
        stages.push(`build:${input.scanDigest}`);
        return input;
      },
      adapter,
    });

    await expect(orchestrator.publish()).resolves.toEqual({
      deploymentId: 'staged-1',
      url: 'https://release.pages.dev',
      scanDigest: 'scan-1',
      output: { fileCount: 2, assetCount: 0, assetBytes: 0 },
    });
    expect(stages).toEqual([
      'prepare',
      'build:scan-1',
      'upload:<article>Ready</article>',
      'activate:staged-1',
    ]);
    expect(orchestrator.getStatus()).toEqual({
      state: 'succeeded',
      stage: 'activate',
      deployment: {
        deploymentId: 'staged-1',
        url: 'https://release.pages.dev',
        scanDigest: 'scan-1',
        output: { fileCount: 2, assetCount: 0, assetBytes: 0 },
      },
    });
  });

  it('rejects an activation response for a deployment other than the uploaded candidate', async () => {
    const adapter: CloudflarePagesDeploymentBoundary = {
      validate: async () => undefined,
      upload: async () => ({ deploymentId: 'staged-1' }),
      activate: async () => ({
        deploymentId: 'other-deployment',
        url: 'https://wrong.pages.dev',
      }),
    };
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter,
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'Cloudflare activated an unexpected deployment.',
    );
    expect(orchestrator.getLastDeployment()).toBeUndefined();
    expect(orchestrator.getStatus()).toEqual({
      state: 'failed',
      stage: 'activate',
      message: 'Cloudflare activated an unexpected deployment.',
    });
  });

  it('durably records the target before the remote deployment POST and leaves it recoverable on an interrupted poll', async () => {
    const events: string[] = [];
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        getActivationTarget: () => ({
          provider: 'cloudflare-pages' as const,
          accountId: 'account-original',
          projectName: 'project-original',
        }),
        upload: async () => {
          events.push('upload');
          return { deploymentId: 'staged-1' };
        },
        activate: async () => {
          events.push('activate');
          throw new Error('poll interrupted');
        },
      },
      facts: {
        assertReadyForPublication: async () => undefined,
        reconcile: async () => undefined,
        recordPendingActivation: async (input) => {
          events.push(`pending:${input.deploymentId ?? 'unknown'}:${input.target.accountId}:${input.target.projectName}:${input.snapshot.scanDigest}`);
        },
        clearPendingActivation: async () => {
          events.push('clear');
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'Cloudflare activation failed. The current site remains active. Retry after checking the deployment.',
    );
    expect(events).toEqual([
      'pending:unknown:account-original:project-original:scan-1',
      'upload',
      'pending:staged-1:account-original:project-original:scan-1',
      'activate',
    ]);
  });

  it('does not send a deployment request when its pre-upload recovery receipt cannot be persisted', async () => {
    const upload = vi.fn(async () => ({ deploymentId: 'not-reached' }));
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        getActivationTarget: () => ({
          provider: 'cloudflare-pages',
          accountId: 'account-1',
          projectName: 'project-1',
        }),
        upload,
        activate: async () => ({ deploymentId: 'not-reached', url: 'https://not-reached.pages.dev' }),
      },
      facts: {
        assertReadyForPublication: async () => undefined,
        reconcile: async () => undefined,
        recordPendingActivation: async () => {
          throw new Error('state storage unavailable');
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'Cloudflare upload failed. The current site remains active. Retry after checking the connection.',
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('checks the connected Pages target before it creates a fresh publish snapshot', async () => {
    const stages: string[] = [];
    const adapter: CloudflarePagesDeploymentBoundary = {
      validate: async () => {
        stages.push('validate');
      },
      upload: async () => {
        stages.push('upload');
        return { deploymentId: 'staged-1' };
      },
      activate: async () => {
        stages.push('activate');
        return { deploymentId: 'staged-1', url: 'https://release.pages.dev' };
      },
    };
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => {
        stages.push('prepare');
        return snapshot();
      },
      build: async (input) => {
        stages.push('build');
        return input;
      },
      adapter,
    });

    await orchestrator.publish();
    expect(stages).toEqual(['validate', 'prepare', 'build', 'upload', 'activate']);
  });

  it('reports an upload failure without exposing an adapter secret or recording a deployment', async () => {
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => {
          throw new Error('Authorization: Bearer top-secret-token');
        },
        activate: async () => {
          throw new Error('not reached');
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'Cloudflare upload failed. The current site remains active. Retry after checking the connection.',
    );
    expect(orchestrator.getLastDeployment()).toBeUndefined();
    expect(orchestrator.getStatus()).toEqual({
      state: 'failed',
      stage: 'upload',
      message: 'Cloudflare upload failed. The current site remains active. Retry after checking the connection.',
    });
    expect(JSON.stringify(orchestrator.getStatus())).not.toContain('top-secret-token');
  });

  it('gives a clear safe next step when the user-approved upload lacks Pages Write permission', async () => {
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => {
          throw Object.assign(new Error('forbidden'), { code: 'permission-denied' });
        },
        activate: async () => {
          throw new Error('not reached');
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'Cloudflare requires Pages Write permission to upload this site. Update the API token and reconnect.',
    );
  });

  it('stores an immutable deployment receipt independent from a builder-owned snapshot object', async () => {
    const built = {
      ...snapshot(),
      output: { fileCount: 2, assetCount: 0, assetBytes: 0 },
    };
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async () => built,
      adapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: 'staged-1' }),
        activate: async () => ({
          deploymentId: 'staged-1',
          url: 'https://release.pages.dev',
        }),
      },
    });

    const deployment = await orchestrator.publish();
    built.output.fileCount = 999;

    expect(deployment.output).toEqual({ fileCount: 2, assetCount: 0, assetBytes: 0 });
    expect(orchestrator.getLastDeployment()?.output).toEqual({
      fileCount: 2,
      assetCount: 0,
      assetBytes: 0,
    });
  });

  it('does not allow a status reader to overwrite the observed publication state', async () => {
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: 'staged-1' }),
        activate: async () => ({
          deploymentId: 'staged-1',
          url: 'https://release.pages.dev',
        }),
      },
    });

    await orchestrator.publish();
    const observed = orchestrator.getStatus() as { state: string };
    observed.state = 'failed';

    expect(orchestrator.getStatus()).toMatchObject({
      state: 'succeeded',
      deployment: { deploymentId: 'staged-1' },
    });
  });

  it('coalesces concurrent publish requests into one remote deployment transaction', async () => {
    let releaseValidation: (() => void) | undefined;
    let validations = 0;
    let uploads = 0;
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => {
          validations += 1;
          await new Promise<void>((resolve) => {
            releaseValidation = resolve;
          });
        },
        upload: async () => {
          uploads += 1;
          return { deploymentId: 'staged-1' };
        },
        activate: async () => ({
          deploymentId: 'staged-1',
          url: 'https://release.pages.dev',
        }),
      },
    });

    const first = orchestrator.publish();
    const second = orchestrator.publish();
    expect(second).toBe(first);
    expect(validations).toBe(1);
    releaseValidation?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ deploymentId: 'staged-1' }),
      expect.objectContaining({ deploymentId: 'staged-1' }),
    ]);
    expect(validations).toBe(1);
    expect(uploads).toBe(1);
  });

  it('reprepares and rebuilds from a fresh snapshot after a failed attempt', async () => {
    let prepares = 0;
    let builds = 0;
    let uploads = 0;
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => {
        prepares += 1;
        return snapshot(`scan-${prepares}`);
      },
      build: async (input) => {
        builds += 1;
        if (builds === 1) throw new Error('simulated build failure');
        return input;
      },
      adapter: {
        validate: async () => undefined,
        upload: async () => {
          uploads += 1;
          return { deploymentId: 'staged-2' };
        },
        activate: async (input) => ({
          deploymentId: input.deploymentId,
          url: 'https://release.pages.dev',
        }),
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow('Site build and checks failed');
    await expect(orchestrator.publish()).resolves.toMatchObject({
      deploymentId: 'staged-2',
      scanDigest: 'scan-2',
    });

    expect({ prepares, builds, uploads }).toEqual({ prepares: 2, builds: 2, uploads: 1 });
  });

  it('reports remote success with local reconciliation pending and blocks a second publish', async () => {
    let uploads = 0;
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => {
          uploads += 1;
          return { deploymentId: 'staged-1' };
        },
        activate: async () => ({
          deploymentId: 'staged-1',
          url: 'https://release.pages.dev',
        }),
      },
      facts: {
        assertReadyForPublication: async () => undefined,
        reconcile: async () => {
          throw new Error('disk full while writing facts');
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'The site is online, but local publishing facts need repair before another publish can start.',
    );
    expect(orchestrator.getStatus()).toEqual({
      state: 'reconciliation-required',
      reconciliation: 'activation-confirmed',
      deployment: {
        deploymentId: 'staged-1',
        url: 'https://release.pages.dev',
        scanDigest: 'scan-1',
        output: { fileCount: 2, assetCount: 0, assetBytes: 0 },
      },
      message: 'The site is online, but local publishing facts need repair before another publish can start.',
    });
    await expect(orchestrator.publish()).rejects.toThrow(
      'The site is online, but local publishing facts need repair before another publish can start.',
    );
    expect(uploads).toBe(1);
  });

  it('blocks a publish before remote validation when a prior reconciliation receipt is pending', async () => {
    const validate = vi.fn(async () => undefined);
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate,
        upload: async () => ({ deploymentId: 'not-reached' }),
        activate: async () => ({
          deploymentId: 'not-reached',
          url: 'https://not-reached.pages.dev',
        }),
      },
      facts: {
        assertReadyForPublication: async () => {
          throw new Error('pending receipt');
        },
        reconcile: async () => undefined,
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow(
      'The site is online, but local publishing facts need repair before another publish can start.',
    );
    expect(validate).not.toHaveBeenCalled();
    expect(orchestrator.getStatus()).toEqual({
      state: 'reconciliation-required',
      reconciliation: 'activation-confirmed',
      message: 'The site is online, but local publishing facts need repair before another publish can start.',
    });
  });

  it('marks an upload-uncertain recovery as unknown rather than claiming the site is online', async () => {
    const pending = new PublicationReconciliationRequiredError(undefined, {
      provider: 'cloudflare-pages',
      accountId: 'account-original',
      projectName: 'project-original',
    });
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: 'not-reached' }),
        activate: async () => ({ deploymentId: 'not-reached', url: 'https://not-reached.pages.dev' }),
      },
      facts: {
        assertReadyForPublication: async () => {
          throw pending;
        },
        reconcile: async () => undefined,
      },
    });

    await expect(orchestrator.refreshPublicationFacts()).rejects.toThrow(
      'A Cloudflare upload outcome could not be confirmed.',
    );
    expect(orchestrator.getStatus()).toEqual({
      state: 'reconciliation-required',
      reconciliation: 'upload-uncertain',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'account-original',
        projectName: 'project-original',
      },
      message: 'A Cloudflare upload outcome could not be confirmed. Verify the saved Pages target before another publish can start.',
    });
  });

  it('unlocks a completed recovery and permits the next publish in the same process', async () => {
    let receiptPending = false;
    let reconciliations = 0;
    let uploads = 0;
    const orchestrator = new PublicationOrchestrator({
      prepare: async () => snapshot(),
      build: async (input) => input,
      adapter: {
        validate: async () => undefined,
        upload: async () => ({ deploymentId: `staged-${++uploads}` }),
        activate: async ({ deploymentId }) => ({
          deploymentId,
          url: 'https://release.pages.dev',
        }),
      },
      facts: {
        assertReadyForPublication: async () => {
          if (receiptPending) throw new Error('pending receipt');
        },
        reconcile: async () => {
          reconciliations += 1;
          if (reconciliations === 1) {
            receiptPending = true;
            throw new Error('local fact write interrupted');
          }
        },
      },
    });

    await expect(orchestrator.publish()).rejects.toThrow('local publishing facts need repair');
    receiptPending = false; // The application has just completed durable recovery.

    await expect(orchestrator.refreshPublicationFacts()).resolves.toBeUndefined();
    expect(orchestrator.getStatus()).toEqual({ state: 'idle' });
    await expect(orchestrator.publish()).resolves.toMatchObject({ deploymentId: 'staged-2' });
    expect(uploads).toBe(2);
  });
});
