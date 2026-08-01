import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import {
  CloudflarePagesHttpDeploymentAdapter,
  type CloudflarePagesHttpBoundary,
} from '../src/cloudflare/pages-deployment';

describe('Cloudflare Pages direct-upload deployment adapter', () => {
  it('loads BLAKE3 when bundled with the same browser target used by the Obsidian plugin', async () => {
    const bundle = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ['src/cloudflare/pages-deployment.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2021',
      write: false,
    });
    const output = bundle.outputFiles[0];
    if (!output) throw new Error('Expected one Pages deployment bundle.');
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(output.text, {
      module,
      exports: module.exports,
      Buffer,
      FormData,
      TextEncoder,
      TextDecoder,
    });
    const BundledAdapter = module.exports.CloudflarePagesHttpDeploymentAdapter as
      typeof CloudflarePagesHttpDeploymentAdapter;
    let manifest: Record<string, string> | undefined;
    const adapter = new BundledAdapter({
      accountId: 'account-1',
      projectName: 'deploy-wiki',
      credential: async () => 'api-token',
      http: {
        request: async (input) => {
          if (input.path.endsWith('/upload-token')) return { jwt: jwt({}) };
          if (input.path === '/pages/assets/check-missing') return [];
          if (input.path === '/pages/assets/upsert-hashes') return {};
          if (input.path.endsWith('/deployments')) {
            const serializedManifest = (input.body as FormData).get('manifest');
            if (typeof serializedManifest !== 'string') {
              throw new Error('Expected the deployment manifest form field.');
            }
            manifest = parseStringRecord(serializedManifest);
            return { id: 'deployment-1' };
          }
          return { id: 'project-1' };
        },
      },
    });

    await adapter.upload({
      scanDigest: 'scan-1',
      files: { '/index.html': '<h1>Hello</h1>' },
      assets: {},
    });

    expect(manifest).toEqual({ '/index.html': '8deb79e268ae1932009657bb3e496c87' });
  });

  it('validates the bound project, uploads only missing immutable assets, then confirms the created deployment', async () => {
    const requests: Array<{ path: string; body?: unknown; authorization?: string }> = [];
    const request = vi.fn(async (input: {
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
    }) => {
      requests.push({
        path: input.path,
        body: input.body,
        authorization: input.headers?.Authorization,
      });
      if (input.path.endsWith('/upload-token')) return { jwt: jwt({ max_file_count_allowed: 20_000 }) };
      if (input.path === '/pages/assets/check-missing') {
        const body = JSON.parse(String(input.body)) as { hashes: string[] };
        return [body.hashes[0]];
      }
      if (input.path === '/pages/assets/upload') return {};
      if (input.path === '/pages/assets/upsert-hashes') return {};
      if (input.path.endsWith('/deployments')) {
        expect(input.body).toBeInstanceOf(FormData);
        const form = input.body as FormData;
        const manifest = form.get('manifest');
        expect(typeof manifest).toBe('string');
        expect(JSON.parse(manifest as string)).toEqual({
          // Known Wrangler BLAKE3 vectors: base64-encoded content plus
          // extension, truncated to the 32-character Pages asset key.
          '/index.html': '8deb79e268ae1932009657bb3e496c87',
          '/assets/logo.png': '5874e84a45babd08c88f57e9db847ee2',
        });
        return { id: 'deployment-1', url: 'https://candidate.deploy-wiki.pages.dev' };
      }
      if (input.path.endsWith('/deployments/deployment-1')) {
        return {
          id: 'deployment-1',
          url: 'https://deploy-wiki.pages.dev',
          latest_stage: { name: 'deploy', status: 'success' },
        };
      }
      return { id: 'project-1' };
    });
    const http: CloudflarePagesHttpBoundary = { request };
    const adapter = new CloudflarePagesHttpDeploymentAdapter({
      accountId: 'account-1',
      projectName: 'deploy-wiki',
      credential: async () => 'api-token-not-to-log',
      http,
      wait: async () => undefined,
    });

    await adapter.validate();
    await expect(adapter.upload({
      scanDigest: 'scan-1',
      files: { '/index.html': '<h1>Hello</h1>' },
      assets: {
        '/assets/logo.png': {
          content: new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
        },
      },
    })).resolves.toEqual({ deploymentId: 'deployment-1' });
    await expect(adapter.activate({ deploymentId: 'deployment-1' })).resolves.toEqual({
      deploymentId: 'deployment-1',
      url: 'https://deploy-wiki.pages.dev',
    });

    expect(requests.map((request) => request.path)).toEqual([
      '/accounts/account-1/pages/projects/deploy-wiki',
      '/accounts/account-1/pages/projects/deploy-wiki/upload-token',
      '/pages/assets/check-missing',
      '/pages/assets/upload',
      '/pages/assets/upsert-hashes',
      '/accounts/account-1/pages/projects/deploy-wiki/deployments',
      '/accounts/account-1/pages/projects/deploy-wiki/deployments/deployment-1',
    ]);
    expect(requests[0]?.authorization).toBe('Bearer api-token-not-to-log');
    expect(requests[2]?.authorization).toMatch(/^Bearer ey/);
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('api-token-not-to-log');
  });

  it('keeps each missing-asset upload batch within the Wrangler 2,000-file limit', async () => {
    const uploadBatches: Array<Array<{ key: string }>> = [];
    const request = vi.fn(async (input: { path: string; body?: unknown }) => {
      if (input.path.endsWith('/upload-token')) return { jwt: jwt({ max_file_count_allowed: 20_000 }) };
      if (input.path === '/pages/assets/check-missing') {
        return (JSON.parse(String(input.body)) as { hashes: string[] }).hashes;
      }
      if (input.path === '/pages/assets/upload') {
        uploadBatches.push(JSON.parse(String(input.body)) as Array<{ key: string }>);
        return {};
      }
      if (input.path === '/pages/assets/upsert-hashes') return {};
      if (input.path.endsWith('/deployments')) return { id: 'deployment-1' };
      return { id: 'project-1' };
    });
    const adapter = new CloudflarePagesHttpDeploymentAdapter({
      accountId: 'account-1',
      projectName: 'deploy-wiki',
      credential: async () => 'api-token',
      http: { request },
    });
    const files = Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [`/pages/${index}.txt`, String(index)]),
    );

    await adapter.upload({ scanDigest: 'scan-1', files, assets: {} });

    expect(uploadBatches.map((batch) => batch.length)).toEqual([2_000, 1]);
  });

  it('starts a new upload batch when missing assets exceed the 40 MiB byte limit', async () => {
    const uploadCounts: number[] = [];
    const request = vi.fn(async (input: { path: string; body?: unknown }) => {
      if (input.path.endsWith('/upload-token')) return { jwt: jwt({ max_file_count_allowed: 20_000 }) };
      if (input.path === '/pages/assets/check-missing') {
        return (JSON.parse(String(input.body)) as { hashes: string[] }).hashes;
      }
      if (input.path === '/pages/assets/upload') {
        uploadCounts.push((String(input.body).match(/"key":/g) ?? []).length);
        return {};
      }
      if (input.path === '/pages/assets/upsert-hashes') return {};
      if (input.path.endsWith('/deployments')) return { id: 'deployment-1' };
      return { id: 'project-1' };
    });
    const adapter = new CloudflarePagesHttpDeploymentAdapter({
      accountId: 'account-1',
      projectName: 'deploy-wiki',
      credential: async () => 'api-token',
      http: { request },
    });
    const twentyMiB = 20 * 1024 * 1024;

    await adapter.upload({
      scanDigest: 'scan-1',
      files: {},
      assets: {
        '/assets/a.bin': { content: new Uint8Array(twentyMiB), contentType: 'application/octet-stream' },
        '/assets/b.bin': { content: new Uint8Array(twentyMiB), contentType: 'application/octet-stream' },
        '/assets/c.bin': { content: new Uint8Array([1]), contentType: 'application/octet-stream' },
      },
    });

    expect(uploadCounts).toEqual([2, 1]);
  });

  it('does not create a deployment after check-missing or asset-upload failures', async () => {
    for (const failurePath of ['/pages/assets/check-missing', '/pages/assets/upload'] as const) {
      const paths: string[] = [];
      const request = vi.fn(async (input: { path: string; body?: unknown }) => {
        paths.push(input.path);
        if (input.path.endsWith('/upload-token')) return { jwt: jwt({}) };
        if (input.path === '/pages/assets/check-missing') {
          if (failurePath === input.path) throw new Error('connection interrupted');
          return (JSON.parse(String(input.body)) as { hashes: string[] }).hashes;
        }
        if (input.path === '/pages/assets/upload' && failurePath === input.path) {
          throw new Error('asset upload interrupted');
        }
        return {};
      });
      const adapter = new CloudflarePagesHttpDeploymentAdapter({
        accountId: 'account-1',
        projectName: 'deploy-wiki',
        credential: async () => 'api-token',
        http: { request },
      });

      await expect(adapter.upload({
        scanDigest: 'scan-1',
        files: { '/index.html': '<h1>Safe</h1>' },
        assets: {},
      })).rejects.toThrow(/interrupted/);
      expect(paths).not.toContain('/accounts/account-1/pages/projects/deploy-wiki/deployments');
    }
  });

  it.each([
    ['unexpected deployment id', {
      id: 'other-deployment',
      url: 'https://other.pages.dev',
      latest_stage: { name: 'deploy', status: 'success' },
    }, 'remote-response-invalid'],
    ['reported deployment failure', {
      id: 'deployment-1',
      url: 'https://deploy-wiki.pages.dev',
      latest_stage: { name: 'deploy', status: 'failure' },
    }, 'deployment-failed'],
    ['activation timeout', {
      id: 'deployment-1',
      url: 'https://deploy-wiki.pages.dev',
      latest_stage: { name: 'deploy', status: 'idle' },
    }, 'deployment-timeout'],
  ] as const)('rejects %s without treating the candidate as activated', async (_scenario, response, code) => {
    const adapter = new CloudflarePagesHttpDeploymentAdapter({
      accountId: 'account-1',
      projectName: 'deploy-wiki',
      credential: async () => 'api-token',
      http: { request: async () => response },
      wait: async () => undefined,
      maxActivationPolls: 1,
    });

    await expect(adapter.activate({ deploymentId: 'deployment-1' })).rejects.toMatchObject({ code });
  });
});

function jwt(payload: object): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function parseStringRecord(serialized: string): Record<string, string> {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  if (!Object.values(value).every((entry) => typeof entry === 'string')) {
    throw new Error('Expected a JSON object with string values.');
  }
  return value as Record<string, string>;
}
