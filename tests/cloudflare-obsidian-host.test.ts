import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudflareCredentialExpiredError } from '../src/cloudflare/connection';
import {
  CloudflarePagesDeploymentInspector,
  CloudflarePagesProjectApi,
  CloudflareV4Api,
  CloudflareV4HttpClient,
  CloudflareV4RequestError,
  createVaultCloudflarePagesDomainStatusInspector,
  createVaultCloudflarePagesDeploymentAdapter,
  ObsidianRequestUrlTransport,
  PinnedCloudflarePagesDeploymentAdapter,
} from '../src/cloudflare/obsidian-host';

describe('Cloudflare Obsidian HTTP host', () => {
  it('returns only a successful Cloudflare API result through the Pages HTTP boundary', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { success: true, result: { id: 'project-1' }, errors: [] },
    }));
    const client = new CloudflareV4HttpClient({ request });

    await expect(client.request({
      path: '/accounts/account-1/pages/projects/project-1',
      headers: { Authorization: 'Bearer token-secret' },
    })).resolves.toEqual({ id: 'project-1' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/project-1',
      method: 'GET',
      headers: { Authorization: 'Bearer token-secret' },
      throw: false,
    }));
  });

  it('maps only unauthenticated credentials to the connection service expiration signal without exposing API details', async () => {
    const client = new CloudflareV4HttpClient({
      request: async () => ({
        status: 401,
        json: {
          success: false,
          errors: [{ code: 10000, message: 'token-secret is bad' }],
        },
      }),
    });

    await expect(client.request({ path: '/user/tokens/verify' }))
      .rejects.toBeInstanceOf(CloudflareCredentialExpiredError);
  });

  it('keeps an account authorization denial distinct from an expired credential', async () => {
    const client = new CloudflareV4HttpClient({
      request: async () => ({
        status: 403,
        json: { success: false, errors: [{ code: 1001, message: 'forbidden' }] },
      }),
    });

    await expect(client.request({ path: '/accounts/account-1/pages/projects' }))
      .rejects.toBeInstanceOf(CloudflareV4RequestError);
  });

  it('lists only accepted membership accounts through the Memberships Read endpoint', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        success: true,
        result: [
          { status: 'accepted', account: { id: 'account-1', name: 'Personal' } },
          { status: 'pending', account: { id: 'account-2', name: 'Pending' } },
          { status: 'rejected', account: { id: 'account-3', name: 'Rejected' } },
          { status: 'accepted', account: { id: 4, name: 'Malformed' } },
        ],
      },
    }));
    const api = new CloudflareV4Api(new CloudflareV4HttpClient({ request }));

    await expect(api.listAccounts('token-secret')).resolves.toEqual([
      { id: 'account-1', name: 'Personal' },
    ]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/memberships',
      headers: { Authorization: 'Bearer token-secret' },
    }));
  });

  it('falls back to the account directory only when the OAuth credential is forbidden from membership discovery', async () => {
    const request = vi.fn(async (input: { url: string }) => {
      if (input.url.endsWith('/memberships')) {
        return {
          status: 403,
          json: { success: false, errors: [{ code: 1001, message: 'forbidden' }] },
        };
      }
      return {
        status: 200,
        json: {
          success: true,
          result: [{ id: 'account-1', name: 'Fallback account' }],
        },
      };
    });
    const api = new CloudflareV4Api(new CloudflareV4HttpClient({ request }));

    await expect(api.listAccounts('oauth-token')).resolves.toEqual([
      { id: 'account-1', name: 'Fallback account' },
    ]);
    expect(request.mock.calls.map(([input]) => input.url)).toEqual([
      'https://api.cloudflare.com/client/v4/memberships',
      'https://api.cloudflare.com/client/v4/accounts',
    ]);
  });

  it('verifies an active token before choosing its first available account', async () => {
    const request = vi.fn(async (input: { url: string }) => {
      if (input.url.endsWith('/user/tokens/verify')) {
        return { status: 200, json: { success: true, result: { status: 'active' } } };
      }
      return {
        status: 200,
        json: {
          success: true,
          result: [{ status: 'accepted', account: { id: 'account-1', name: 'Personal' } }],
        },
      };
    });
    const api = new CloudflareV4Api(new CloudflareV4HttpClient({ request }));

    await expect(api.verify('token-secret')).resolves.toEqual({
      id: 'account-1',
      name: 'Personal',
    });
    expect(request.mock.calls.map(([input]) => input.url)).toEqual([
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      'https://api.cloudflare.com/client/v4/memberships',
    ]);
  });

  it('confirms Pages read access without mutating a remote project during connection', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { success: true, result: [] },
    }));
    const api = new CloudflareV4Api(new CloudflareV4HttpClient({ request }));

    await expect(api.verifyPermissions('token-secret', {
      accountId: 'account-1',
      capabilities: ['account-read', 'pages-read', 'pages-write'],
    })).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects?per_page=1',
      headers: { Authorization: 'Bearer token-secret' },
    }));
  });

  it('accepts a read-only Pages connection and defers write validation to an approved remote action', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { success: true, result: [] },
    }));
    const api = new CloudflareV4Api(new CloudflareV4HttpClient({ request }));

    await expect(api.verifyPermissions('read-only-token', {
      accountId: 'account-1',
      capabilities: ['account-read', 'pages-read', 'pages-write'],
    })).resolves.toBe(true);
  });

  it('projects Cloudflare Pages projects into the nonsecret setup contract', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        success: true,
        result: [{ id: 'project-1', name: 'knowledge-base', subdomain: 'knowledge-base' }],
      },
    }));
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.listProjects({ accountId: 'account-1' })).resolves.toEqual([
      {
        id: 'project-1',
        name: 'knowledge-base',
        accountId: 'account-1',
        pagesDevUrl: 'https://knowledge-base.pages.dev',
        compatible: true,
      },
    ]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects',
      headers: { Authorization: 'Bearer token-secret' },
    }));
  });

  it('rejects Git-connected Pages projects as incompatible with Direct Upload publishing', async () => {
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({
        request: async () => ({
          status: 200,
          json: {
            success: true,
            result: [{
              id: 'project-1',
              name: 'git-project',
              subdomain: 'git-preview.pages.dev',
              source: { type: 'github' },
            }],
          },
        }),
      }),
      async () => 'token-secret',
    );

    await expect(projects.listProjects({ accountId: 'account-1' })).resolves.toEqual([
      expect.objectContaining({
        name: 'git-project',
        pagesDevUrl: 'https://git-preview.pages.dev',
        compatible: false,
      }),
    ]);
  });

  it('creates a Pages project only when the setup confirmation asks it to', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        success: true,
        result: { id: 'project-1', name: 'knowledge-base' },
      },
    }));
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.createProject({
      accountId: 'account-1',
      projectName: 'knowledge-base',
    })).resolves.toEqual({
      id: 'project-1',
      name: 'knowledge-base',
      accountId: 'account-1',
      pagesDevUrl: 'https://knowledge-base.pages.dev',
      compatible: true,
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects',
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'knowledge-base', production_branch: 'main' }),
    }));
  });

  it('treats a missing named Pages project as a bindable absence rather than a remote failure', async () => {
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({
        request: async () => ({
          status: 404,
          json: { success: false, result: null, errors: [{ code: 8000007 }] },
        }),
      }),
      async () => 'token-secret',
    );

    await expect(projects.findProject({
      accountId: 'account-1',
      projectName: 'missing-project',
    })).resolves.toBeUndefined();
  });

  it('returns the Cloudflare custom-domain state without treating pending verification as a failure', async () => {
    const request = vi.fn(async (input: { method?: string }) => input.method === 'POST'
      ? {
        status: 200,
        json: { success: true, result: { name: 'docs.example.test', status: 'pending' } },
      }
      : { status: 200, json: { success: true, result: [] } });
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.ensureCustomDomain({
      project: {
        id: 'project-1',
        name: 'knowledge-base',
        accountId: 'account-1',
        pagesDevUrl: 'https://knowledge-base.pages.dev',
        compatible: true,
      },
      hostname: 'docs.example.test',
    })).resolves.toEqual({ status: 'pending' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/knowledge-base/domains',
      method: 'GET',
    }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/knowledge-base/domains',
      method: 'POST',
      body: JSON.stringify({ name: 'docs.example.test' }),
    }));
  });

  it('returns an existing custom domain without repeating its mutation request', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: { success: true, result: [{ name: 'docs.example.test', status: 'active' }] },
    }));
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.ensureCustomDomain({
      project: {
        id: 'project-1',
        name: 'knowledge-base',
        accountId: 'account-1',
        pagesDevUrl: 'https://knowledge-base.pages.dev',
        compatible: true,
      },
      hostname: 'docs.example.test',
    })).resolves.toEqual({ status: 'active' });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
  });

  it('reads a configured custom-domain status without issuing a domain mutation', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        success: true,
        result: [{ name: 'docs.example.com', status: 'active' }],
      },
    }));
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.inspectCustomDomain({
      project: {
        id: 'project-1',
        name: 'docs-project',
        accountId: 'account-1',
        pagesDevUrl: 'https://docs-project.pages.dev',
        compatible: true,
      },
      hostname: 'docs.example.com',
    })).resolves.toEqual({ status: 'active' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/docs-project/domains',
      method: 'GET',
    }));
  });

  it('recovers a pending custom-domain result after an ambiguous POST failure', async () => {
    let reads = 0;
    const request = vi.fn(async (input: { method?: string }) => {
      if (input.method === 'POST') throw new Error('connection interrupted');
      reads += 1;
      return {
        status: 200,
        json: {
          success: true,
          result: reads === 1 ? [] : [{ name: 'docs.example.test', status: 'pending' }],
        },
      };
    });
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({ request }),
      async () => 'token-secret',
    );

    await expect(projects.ensureCustomDomain({
      project: {
        id: 'project-1',
        name: 'knowledge-base',
        accountId: 'account-1',
        pagesDevUrl: 'https://knowledge-base.pages.dev',
        compatible: true,
      },
      hostname: 'docs.example.test',
    })).resolves.toEqual({ status: 'pending' });
  });

  it('keeps Cloudflare custom-domain validation guidance while excluding credential material', async () => {
    const projects = new CloudflarePagesProjectApi(
      new CloudflareV4HttpClient({
        request: async (input) => input.method === 'POST'
          ? {
            status: 400,
            json: {
              success: false,
              errors: [{
                code: 1004,
                message: 'Add the required CNAME record before retrying. token-secret; Authorization: token-secret',
              }],
            },
          }
          : { status: 200, json: { success: true, result: [] } },
      }),
      async () => 'token-secret',
    );

    await expect(projects.ensureCustomDomain({
      project: {
        id: 'project-1',
        name: 'docs-project',
        accountId: 'account-1',
        pagesDevUrl: 'https://docs-project.pages.dev',
        compatible: true,
      },
      hostname: 'docs.example.com',
    })).resolves.toEqual({
      status: 'failed',
      message: 'Cloudflare validation: Add the required CNAME record before retrying. [redacted]; Authorization: [redacted]',
    });
  });

  it('pins the validated project for upload and activation even if the active connection changes later', async () => {
    const first = {
      validate: vi.fn(async () => undefined),
      upload: vi.fn(async () => ({ deploymentId: 'deployment-1' })),
      activate: vi.fn(async () => ({
        deploymentId: 'deployment-1',
        url: 'https://deployment-1.pages.dev',
      })),
    };
    const second = {
      validate: vi.fn(async () => undefined),
      upload: vi.fn(async () => ({ deploymentId: 'deployment-2' })),
      activate: vi.fn(async () => ({
        deploymentId: 'deployment-2',
        url: 'https://deployment-2.pages.dev',
      })),
    };
    const resolve = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const adapter = new PinnedCloudflarePagesDeploymentAdapter({ resolve });

    await adapter.validate();
    await adapter.upload({ scanDigest: 'scan-1', files: {}, assets: {} });
    await expect(adapter.activate({ deploymentId: 'deployment-1' })).resolves.toEqual({
      deploymentId: 'deployment-1',
      url: 'https://deployment-1.pages.dev',
    });

    expect(first.validate).toHaveBeenCalledOnce();
    expect(first.upload).toHaveBeenCalledOnce();
    expect(first.activate).toHaveBeenCalledOnce();
    expect(second.validate).not.toHaveBeenCalled();
  });

  it('resolves the validated vault configuration and selected connection into a pinned Pages target', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-publish-host-'));
    await mkdir(join(vaultRoot, '.publish'));
    await mkdir(join(vaultRoot, 'notes'));
    await writeFile(join(vaultRoot, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Test site',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: docs-project',
      '',
    ].join('\n'));
    const request = vi.fn(async () => ({ id: 'project-1', name: 'docs-project' }));
    const adapter = createVaultCloudflarePagesDeploymentAdapter({
      vaultRoot,
      connection: {
        getPublishingConnection: async () => ({
          account: { id: 'account-1', name: 'Personal' },
          credential: 'token-secret',
        }),
      },
      http: { request },
    });

    try {
      await adapter.validate();
      expect(request).toHaveBeenCalledWith({
        path: '/accounts/account-1/pages/projects/docs-project',
        headers: { Authorization: 'Bearer token-secret' },
      });
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('checks the configured custom domain against the selected account without creating a remote binding', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-publish-domain-status-'));
    await mkdir(join(vaultRoot, '.publish'));
    await writeFile(join(vaultRoot, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Test site',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: docs-project',
      '  custom_domain: docs.example.com',
      '',
    ].join('\n'));
    const findProject = vi.fn(async () => ({
      id: 'project-1',
      name: 'docs-project',
      accountId: 'account-1',
      pagesDevUrl: 'https://docs-project.pages.dev',
      compatible: true,
    }));
    const inspectCustomDomain = vi.fn(async () => ({ status: 'pending' as const }));
    const projects = { findProject, inspectCustomDomain };
    const projectsForCredential = vi.fn(() => projects);
    const inspector = createVaultCloudflarePagesDomainStatusInspector({
      vaultRoot,
      connection: {
        getPublishingConnection: async () => ({
          account: { id: 'account-1', name: 'Personal' },
          credential: 'token-secret',
        }),
      },
      projectsForCredential,
    });

    try {
      await expect(inspector.inspect()).resolves.toEqual({
        state: 'pending',
        hostname: 'docs.example.com',
      });
      expect(findProject).toHaveBeenCalledWith({
        accountId: 'account-1',
        projectName: 'docs-project',
      });
      expect(inspectCustomDomain).toHaveBeenCalledWith({
        project: {
          id: 'project-1',
          name: 'docs-project',
          accountId: 'account-1',
          pagesDevUrl: 'https://docs-project.pages.dev',
          compatible: true,
        },
        hostname: 'docs.example.com',
      });
      expect(projectsForCredential).toHaveBeenCalledTimes(1);
      expect(projectsForCredential).toHaveBeenCalledWith('token-secret');
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a custom-domain project lookup does not match the selected account and configured project', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-publish-domain-mismatch-'));
    await mkdir(join(vaultRoot, '.publish'));
    await writeFile(join(vaultRoot, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Test site',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: docs-project',
      '  custom_domain: docs.example.com',
      '',
    ].join('\n'));
    const inspectCustomDomain = vi.fn(async () => ({ status: 'active' as const }));
    const inspector = createVaultCloudflarePagesDomainStatusInspector({
      vaultRoot,
      connection: {
        getPublishingConnection: async () => ({
          account: { id: 'account-1', name: 'Personal' },
          credential: 'token-secret',
        }),
      },
      projectsForCredential: () => ({
        findProject: async () => ({
          id: 'wrong-project',
          name: 'other-project',
          accountId: 'other-account',
          pagesDevUrl: 'https://other-project.pages.dev',
          compatible: true,
        }),
        inspectCustomDomain,
      }),
    });

    try {
      await expect(inspector.inspect()).resolves.toEqual({
        state: 'failed',
        hostname: 'docs.example.com',
        message: 'Cloudflare returned a project that does not match the configured publishing target.',
      });
      expect(inspectCustomDomain).not.toHaveBeenCalled();
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('inspects a deployment against the current configured target for restart recovery', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'pages-publish-inspector-'));
    await mkdir(join(vaultRoot, '.publish'));
    await mkdir(join(vaultRoot, 'notes'));
    await writeFile(join(vaultRoot, '.publish', 'site.yml'), [
      'version: 1',
      'site:',
      '  name: Test site',
      '  home_layout: sections',
      'content_roots:',
      '  - path: notes',
      '    public_root: /notes',
      'assets:',
      '  exclude: []',
      'features:',
      '  search: true',
      '  graph: true',
      'cloudflare:',
      '  project_name: docs-project',
      '',
    ].join('\n'));
    const request = vi.fn(async () => ({
      id: 'deployment-1',
      url: 'https://deployment-1.docs-project.pages.dev',
      latest_stage: { name: 'deploy', status: 'success' },
    }));
    const inspector = new CloudflarePagesDeploymentInspector({
      vaultRoot,
      connection: {
        getPublishingConnection: async () => ({
          account: { id: 'account-1', name: 'Personal' },
          credential: 'token-secret',
        }),
      },
      http: { request },
    });

    try {
      await expect(inspector.inspect('deployment-1')).resolves.toEqual({
        deploymentId: 'deployment-1',
        url: 'https://deployment-1.docs-project.pages.dev',
        status: 'success',
      });
      expect(request).toHaveBeenCalledWith({
        path: '/accounts/account-1/pages/projects/docs-project/deployments/deployment-1',
        headers: { Authorization: 'Bearer token-secret' },
      });
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('inspects an activation-pending deployment against its saved target instead of current site configuration', async () => {
    const request = vi.fn(async () => ({
      id: 'deployment-1',
      url: 'https://deployment-1.original-project.pages.dev',
      latest_stage: { name: 'deploy', status: 'success' },
    }));
    const inspector = new CloudflarePagesDeploymentInspector({
      vaultRoot: '/not-read-for-pending-recovery',
      connection: {
        getPublishingConnection: async () => ({
          account: { id: 'new-account', name: 'New account' },
          credential: 'token-secret',
        }),
      },
      http: { request },
    });

    await expect(inspector.inspectPending({
      deploymentId: 'deployment-1',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'original-account',
        projectName: 'original-project',
      },
    })).resolves.toMatchObject({ deploymentId: 'deployment-1', status: 'success' });
    expect(request).toHaveBeenCalledWith({
      path: '/accounts/original-account/pages/projects/original-project/deployments/deployment-1',
      headers: { Authorization: 'Bearer token-secret' },
    });
  });

  it('serializes a Pages deployment FormData body for Obsidian requestUrl without falling back to browser CORS', async () => {
    type RequestUrlInput = {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      contentType?: string;
      body?: string | ArrayBuffer;
      throw: false;
    };
    const calls: RequestUrlInput[] = [];
    const requestUrl = vi.fn(async (input: RequestUrlInput) => {
      calls.push(input);
      return {
      status: 200,
      json: { success: true, result: { id: 'deployment-1' } },
      };
    });
    const transport = new ObsidianRequestUrlTransport({ requestUrl });
    const form = new FormData();
    form.set('manifest', '{"/index.html":"hash"}');

    await transport.request({
      url: 'https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/project-1/deployments',
      method: 'POST',
      headers: { Authorization: 'Bearer token-secret' },
      body: form,
      throw: false,
    });

    const input = calls[0];
    expect(input).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer token-secret' },
      throw: false,
    });
    expect(input?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(input?.body).toBeInstanceOf(ArrayBuffer);
    const contentType = input?.contentType;
    const body = input?.body;
    if (!contentType || !(body instanceof ArrayBuffer)) throw new Error('Expected serialized multipart body.');
    const boundary = contentType.slice('multipart/form-data; boundary='.length);
    const serialized = new TextDecoder().decode(body);
    expect(serialized).toContain(`--${boundary}\r\n`);
    expect(serialized).toContain('Content-Disposition: form-data; name="manifest"');
    expect(serialized).toContain('{"/index.html":"hash"}');
    expect(serialized).toContain(`--${boundary}--\r\n`);
  });
});
