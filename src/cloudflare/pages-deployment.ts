import { blake3 } from '@noble/hashes/blake3.js';
import type { PreviewAsset } from '../content/local-assets';
import type { CloudflarePagesDeploymentBoundary } from '../publication/publish-orchestrator';

export interface CloudflarePagesHttpBoundary {
  request(input: {
    path: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string | FormData;
  }): Promise<unknown>;
}

export class CloudflarePagesDeploymentError extends Error {
  readonly name = 'CloudflarePagesDeploymentError';

  constructor(
    readonly code:
      | 'asset-path-invalid'
      | 'asset-too-large'
      | 'deployment-failed'
      | 'deployment-timeout'
      | 'file-count-exceeded'
      | 'remote-response-invalid',
    message: string,
  ) {
    super(message);
  }
}

interface UploadAsset {
  path: string;
  hash: string;
  content: Uint8Array;
  contentType: string;
}

const maxFileBytes = 25 * 1024 * 1024;
const maxUploadBatchBytes = 40 * 1024 * 1024;
const maxUploadBatchFiles = 2_000;
const defaultMaxFileCount = 20_000;

/**
 * Direct Upload adapter for pre-built Pages assets. `upload()` leaves the
 * existing production deployment untouched while assets are stored and a new
 * deployment is created; `activate()` waits until Cloudflare reports that
 * exact deployment's deploy stage as successful.
 */
export class CloudflarePagesHttpDeploymentAdapter
  implements CloudflarePagesDeploymentBoundary {
  constructor(
    private readonly dependencies: {
      accountId: string;
      projectName: string;
      credential(): Promise<string>;
      http: CloudflarePagesHttpBoundary;
      wait?: (delayMs: number) => Promise<void>;
      maxActivationPolls?: number;
    },
  ) {}

  async validate(): Promise<void> {
    const credential = await this.dependencies.credential();
    await this.authenticatedRequest(
      `/accounts/${encodeURIComponent(this.dependencies.accountId)}/pages/projects/${encodeURIComponent(this.dependencies.projectName)}`,
      credential,
    );
  }

  async upload(input: {
    scanDigest: string;
    files: Readonly<Record<string, string>>;
    assets: Readonly<Record<string, PreviewAsset>>;
  }): Promise<{ deploymentId: string }> {
    const credential = await this.dependencies.credential();
    const assets = collectUploadAssets(input);
    const uploadToken = await this.authenticatedRequest<{ jwt?: unknown }>(
      `/accounts/${encodeURIComponent(this.dependencies.accountId)}/pages/projects/${encodeURIComponent(this.dependencies.projectName)}/upload-token`,
      credential,
    );
    if (typeof uploadToken.jwt !== 'string' || uploadToken.jwt.length === 0) {
      throw new CloudflarePagesDeploymentError(
        'remote-response-invalid',
        'Cloudflare did not return a valid upload token.',
      );
    }
    if (assets.length > fileCountLimit(uploadToken.jwt)) {
      throw new CloudflarePagesDeploymentError(
        'file-count-exceeded',
        'This site has more files than the current Cloudflare Pages deployment limit.',
      );
    }
    const missing = await this.dependencies.http.request({
      path: '/pages/assets/check-missing',
      method: 'POST',
      headers: jsonBearerHeaders(uploadToken.jwt),
      body: JSON.stringify({ hashes: assets.map((asset) => asset.hash) }),
    });
    if (!Array.isArray(missing) || !missing.every((hash) => typeof hash === 'string')) {
      throw new CloudflarePagesDeploymentError(
        'remote-response-invalid',
        'Cloudflare did not return a valid missing-asset response.',
      );
    }
    const missingHashes = new Set(missing);
    for (const batch of batches(
      assets.filter((asset) => missingHashes.has(asset.hash)),
    )) {
      await this.dependencies.http.request({
        path: '/pages/assets/upload',
        method: 'POST',
        headers: jsonBearerHeaders(uploadToken.jwt),
        body: JSON.stringify(batch.map((asset) => ({
          key: asset.hash,
          value: Buffer.from(asset.content).toString('base64'),
          metadata: { contentType: asset.contentType },
          base64: true,
        }))),
      });
    }
    // This is an upload-cache optimization. It does not affect the newly
    // created deployment, so a failure must not turn a successful upload into
    // a failed publication.
    await this.dependencies.http.request({
      path: '/pages/assets/upsert-hashes',
      method: 'POST',
      headers: jsonBearerHeaders(uploadToken.jwt),
      body: JSON.stringify({ hashes: assets.map((asset) => asset.hash) }),
    }).catch(() => undefined);

    const form = new FormData();
    form.set('manifest', JSON.stringify(Object.fromEntries(
      assets.map((asset) => [asset.path, asset.hash]),
    )));
    const deployment = await this.authenticatedRequest<{ id?: unknown }>(
      `/accounts/${encodeURIComponent(this.dependencies.accountId)}/pages/projects/${encodeURIComponent(this.dependencies.projectName)}/deployments`,
      credential,
      { method: 'POST', body: form },
    );
    if (typeof deployment.id !== 'string' || deployment.id.length === 0) {
      throw new CloudflarePagesDeploymentError(
        'remote-response-invalid',
        'Cloudflare did not return a deployment identifier.',
      );
    }
    return { deploymentId: deployment.id };
  }

  async activate(input: {
    deploymentId: string;
  }): Promise<{ deploymentId: string; url: string }> {
    const credential = await this.dependencies.credential();
    const path = `/accounts/${encodeURIComponent(this.dependencies.accountId)}/pages/projects/${encodeURIComponent(this.dependencies.projectName)}/deployments/${encodeURIComponent(input.deploymentId)}`;
    const attempts = this.dependencies.maxActivationPolls ?? 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const deployment = await this.authenticatedRequest<{
        id?: unknown;
        url?: unknown;
        latest_stage?: { name?: unknown; status?: unknown };
      }>(path, credential);
      if (deployment.id !== input.deploymentId || typeof deployment.url !== 'string') {
        throw new CloudflarePagesDeploymentError(
          'remote-response-invalid',
          'Cloudflare returned an unexpected deployment status.',
        );
      }
      const stage = deployment.latest_stage;
      if (stage?.name === 'deploy' && stage.status === 'success') {
        return { deploymentId: input.deploymentId, url: deployment.url };
      }
      if (stage?.name === 'deploy' && stage.status === 'failure') {
        throw new CloudflarePagesDeploymentError(
          'deployment-failed',
          'Cloudflare reported that the new deployment failed before activation.',
        );
      }
      if (attempt + 1 < attempts) {
        await (this.dependencies.wait ?? wait)(Math.min(1_000 * 2 ** attempt, 8_000));
      }
    }
    throw new CloudflarePagesDeploymentError(
      'deployment-timeout',
      'Cloudflare did not confirm deployment activation before the wait limit.',
    );
  }

  private authenticatedRequest<T>(
    path: string,
    credential: string,
    options: { method?: 'GET' | 'POST'; body?: string | FormData } = {},
  ): Promise<T> {
    return this.dependencies.http.request({
      path,
      ...options,
      headers: { Authorization: `Bearer ${credential}` },
    }) as Promise<T>;
  }
}

function collectUploadAssets(input: {
  files: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, PreviewAsset>>;
}): UploadAsset[] {
  const result: UploadAsset[] = [];
  const seen = new Set<string>();
  const append = (path: string, content: Uint8Array, contentType: string): void => {
    validateAssetPath(path);
    if (seen.has(path)) {
      throw new CloudflarePagesDeploymentError(
        'asset-path-invalid',
        'The built site contains two different assets at the same output path.',
      );
    }
    if (content.byteLength > maxFileBytes) {
      throw new CloudflarePagesDeploymentError(
        'asset-too-large',
        'A generated file exceeds the Cloudflare Pages per-file upload limit.',
      );
    }
    seen.add(path);
    result.push({
      path,
      hash: pagesAssetHash(content, path),
      content,
      contentType,
    });
  };
  for (const [path, source] of Object.entries(input.files)) {
    append(path, new TextEncoder().encode(source), contentTypeFor(path));
  }
  for (const [path, asset] of Object.entries(input.assets)) {
    append(path, new Uint8Array(asset.content), asset.contentType);
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function validateAssetPath(path: string): void {
  if (
    !path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new CloudflarePagesDeploymentError(
      'asset-path-invalid',
      'The built site contains an unsafe output path.',
    );
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function fileCountLimit(token: string): number {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return defaultMaxFileCount;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      max_file_count_allowed?: unknown;
    };
    return typeof payload.max_file_count_allowed === 'number' &&
      Number.isSafeInteger(payload.max_file_count_allowed) &&
      payload.max_file_count_allowed > 0
      ? payload.max_file_count_allowed
      : defaultMaxFileCount;
  } catch {
    return defaultMaxFileCount;
  }
}

function jsonBearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function batches(assets: UploadAsset[]): UploadAsset[][] {
  const result: UploadAsset[][] = [];
  let current: UploadAsset[] = [];
  let size = 0;
  for (const asset of assets) {
    if (
      current.length > 0 &&
      (size + asset.content.byteLength > maxUploadBatchBytes ||
        current.length >= maxUploadBatchFiles)
    ) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(asset);
    size += asset.content.byteLength;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function pagesAssetHash(content: Uint8Array, path: string): string {
  return Buffer.from(blake3(new TextEncoder().encode(
    Buffer.from(content).toString('base64') + extensionFor(path),
  ))).toString('hex').slice(0, 32);
}

function extensionFor(path: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1) : '';
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}
