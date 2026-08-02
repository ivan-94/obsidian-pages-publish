import { loadSiteConfigFromDirectory } from '../config/site-config';
import type { ConfiguredCustomDomainStatus } from '../application';
import {
  CloudflarePagesHttpDeploymentAdapter,
  type CloudflarePagesHttpBoundary,
} from './pages-deployment';
import type { PreviewAsset } from '../content/local-assets';
import type {
  CloudflarePagesDeploymentBoundary,
  PublicationActivationTarget,
} from '../publication/publish-orchestrator';
import type { ActivatedDeploymentInspector } from '../publication/deployment-facts';
import {
  CloudflareCredentialExpiredError,
  type CloudflareApiBoundary,
  type CloudflarePublishingConnection,
} from './connection';
import type {
  CloudflarePagesProjectBoundary,
  SetupCustomDomainResult,
  SetupProject,
} from '../setup/site-setup';

interface CloudflareRequestUrlResponse {
  status: number;
  json: unknown;
}

export interface CloudflareRequestUrlBoundary {
  request(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    throw: false;
  }): Promise<CloudflareRequestUrlResponse>;
}

interface ObsidianRequestUrlBoundary {
  requestUrl(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    contentType?: string;
    body?: string | ArrayBuffer;
    throw: false;
  }): Promise<CloudflareRequestUrlResponse>;
}

/** Converts the narrow FormData use in Pages deployment requests for requestUrl. */
export class ObsidianRequestUrlTransport implements CloudflareRequestUrlBoundary {
  constructor(private readonly dependencies: ObsidianRequestUrlBoundary) {}

  request(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    throw: false;
  }): Promise<CloudflareRequestUrlResponse> {
    const body = formDataBody(input.body);
    return this.dependencies.requestUrl({
      url: input.url,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(body === undefined ? {} : { body: body.body }),
      ...(body?.contentType === undefined ? {} : { contentType: body.contentType }),
      throw: false,
    });
  }
}

export class CloudflareV4RequestError extends Error {
  readonly name = 'CloudflareV4RequestError';

  constructor(
    readonly status: number,
    readonly safeDetail?: string,
  ) {
    super('Cloudflare did not accept the API request.');
  }
}

/**
 * The only Cloudflare HTTP entry point used by the desktop host. It removes
 * the API envelope before provider-specific boundaries receive a result.
 */
export class CloudflareV4HttpClient implements CloudflarePagesHttpBoundary {
  constructor(private readonly transport: CloudflareRequestUrlBoundary) {}

  async request(input: {
    path: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string | FormData;
  }): Promise<unknown> {
    const response = await this.transport.request({
      url: `https://api.cloudflare.com/client/v4${input.path}`,
      method: input.method ?? 'GET',
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { body: input.body }),
      throw: false,
    });
    const envelope = response.json;
    if (response.status === 401) {
      throw new CloudflareCredentialExpiredError();
    }
    if (!isSuccessfulEnvelope(envelope)) {
      throw new CloudflareV4RequestError(response.status, cloudflareErrorDetail(envelope));
    }
    return envelope.result;
  }
}

export class CloudflareV4Api implements CloudflareApiBoundary {
  constructor(private readonly http: CloudflareV4HttpClient) {}

  async verify(accessToken: string): Promise<{ id: string; name: string }> {
    const token = await this.http.request({
      path: '/user/tokens/verify',
      headers: bearerHeaders(accessToken),
    });
    if (!isActiveToken(token)) {
      throw new CloudflareCredentialExpiredError();
    }
    const accounts = await this.listAccounts(accessToken);
    const account = accounts[0];
    if (!account) throw new Error('Cloudflare did not return an available account.');
    return account;
  }

  async listAccounts(accessToken: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const result = await this.http.request({
        path: '/memberships',
        headers: bearerHeaders(accessToken),
      });
      return parseMembershipAccounts(result);
    } catch (error) {
      if (!isForbidden(error)) throw error;
      const result = await this.http.request({
        path: '/accounts',
        headers: bearerHeaders(accessToken),
      });
      return parseAccounts(result);
    }
  }

  async verifyPermissions(
    accessToken: string,
    input: { accountId: string; capabilities: readonly string[] },
  ): Promise<boolean> {
    if (!hasRequiredConnectionCapabilities(input.capabilities)) return false;
    try {
      await this.http.request({
        path: `/accounts/${encodeURIComponent(input.accountId)}/pages/projects?per_page=1`,
        headers: bearerHeaders(accessToken),
      });
    } catch (error) {
      if (isForbidden(error)) return false;
      throw error;
    }
    // The available least-privilege API can establish Pages read access but
    // cannot safely introspect Pages Write. Write permission is deliberately
    // verified only by an explicit, user-confirmed create/deploy operation.
    return true;
  }
}

export class CloudflarePagesProjectApi implements CloudflarePagesProjectBoundary {
  constructor(
    private readonly http: CloudflareV4HttpClient,
    private readonly credential: () => Promise<string>,
  ) {}

  async listProjects(input: { accountId: string }): Promise<SetupProject[]> {
    const result = await this.http.request({
      path: `/accounts/${encodeURIComponent(input.accountId)}/pages/projects`,
      headers: bearerHeaders(await this.credential()),
    });
    if (!Array.isArray(result)) throw new Error('Cloudflare returned invalid Pages project data.');
    return result.map((project) => parseProject(project, input.accountId));
  }

  async createProject(input: {
    accountId: string;
    projectName: string;
  }): Promise<SetupProject> {
    try {
      const result = await this.http.request({
        path: `/accounts/${encodeURIComponent(input.accountId)}/pages/projects`,
        method: 'POST',
        headers: {
          ...bearerHeaders(await this.credential()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: input.projectName, production_branch: 'main' }),
      });
      return parseProject(result, input.accountId);
    } catch (error) {
      if (isForbidden(error)) {
        throw new Error('Cloudflare requires Pages Write permission to create a Pages project.');
      }
      throw error;
    }
  }

  async findProject(input: {
    accountId: string;
    projectName: string;
  }): Promise<SetupProject | undefined> {
    try {
      const result = await this.http.request({
        path: `/accounts/${encodeURIComponent(input.accountId)}/pages/projects/${encodeURIComponent(input.projectName)}`,
        headers: bearerHeaders(await this.credential()),
      });
      return parseProject(result, input.accountId);
    } catch (error) {
      if (error instanceof CloudflareV4RequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  async verifyProject(project: SetupProject): Promise<SetupProject> {
    const verified = await this.findProject({
      accountId: project.accountId,
      projectName: project.name,
    });
    if (!verified) throw new Error('Cloudflare could not find the Pages project.');
    return verified;
  }

  async ensureCustomDomain(input: {
    project: SetupProject;
    hostname: string;
  }): Promise<SetupCustomDomainResult> {
    const existing = await this.findCustomDomain(input);
    if (existing) return existing;
    try {
      const result = await this.http.request({
        path: domainPath(input.project),
        method: 'POST',
        headers: {
          ...bearerHeaders(await this.credential()),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: input.hostname }),
      });
      return domainResult(result);
    } catch (error) {
      // A transport failure after POST may still have created the binding.
      // Re-read before offering a retry, so a user never submits it twice.
      const recovered = await this.findCustomDomain(input).catch(() => undefined);
      if (recovered) return recovered;
      if (error instanceof CloudflareV4RequestError) {
        return {
          status: 'failed',
          message: error.safeDetail === undefined
            ? 'Cloudflare rejected the custom-domain request. Check the hostname and Pages permission.'
            : `Cloudflare validation: ${error.safeDetail}`,
        };
      }
      throw new Error('Cloudflare could not confirm the custom-domain request. Retry it before continuing.');
    }
  }

  async inspectCustomDomain(input: {
    project: SetupProject;
    hostname: string;
  }): Promise<SetupCustomDomainResult> {
    const existing = await this.findCustomDomain(input);
    return existing ?? {
      status: 'failed',
      message: 'Cloudflare does not show this custom domain on the selected Pages project.',
    };
  }

  private async findCustomDomain(input: {
    project: SetupProject;
    hostname: string;
  }): Promise<SetupCustomDomainResult | undefined> {
    const result = await this.http.request({
      path: domainPath(input.project),
      headers: bearerHeaders(await this.credential()),
    });
    if (!Array.isArray(result)) {
      throw new Error('Cloudflare returned invalid Pages domain data.');
    }
    for (const candidate of result as unknown[]) {
      if (
        isRecord(candidate) &&
        typeof candidate.name === 'string' &&
        candidate.name.toLowerCase() === input.hostname.toLowerCase()
      ) {
        return domainResult(candidate);
      }
    }
    return undefined;
  }
}

/**
 * Keeps the account/project that passed publication validation pinned through
 * the upload and activation of that deployment. A later account switch must
 * never activate a deployment against a different Pages project.
 */
export class PinnedCloudflarePagesDeploymentAdapter
  implements CloudflarePagesDeploymentBoundary {
  private prepared: CloudflarePagesDeploymentBoundary | undefined;
  private readonly deployments = new Map<string, CloudflarePagesDeploymentBoundary>();

  constructor(
    private readonly dependencies: {
      resolve(): Promise<CloudflarePagesDeploymentBoundary>;
    },
  ) {}

  async validate(): Promise<void> {
    const resolved = await this.dependencies.resolve();
    await resolved.validate();
    this.prepared = resolved;
  }

  getActivationTarget(): PublicationActivationTarget | undefined {
    return this.prepared?.getActivationTarget?.();
  }

  async upload(input: {
    scanDigest: string;
    files: Readonly<Record<string, string>>;
    assets: Readonly<Record<string, PreviewAsset>>;
  }): Promise<{ deploymentId: string }> {
    const adapter = this.prepared;
    if (!adapter) throw new Error('Validate the Cloudflare Pages target before uploading.');
    const deployment = await adapter.upload(input);
    this.deployments.set(deployment.deploymentId, adapter);
    return deployment;
  }

  async activate(input: {
    deploymentId: string;
  }): Promise<{ deploymentId: string; url: string }> {
    const adapter = this.deployments.get(input.deploymentId);
    if (!adapter) throw new Error('The Cloudflare Pages deployment is not available for activation.');
    try {
      return await adapter.activate(input);
    } finally {
      this.deployments.delete(input.deploymentId);
      if (this.prepared === adapter) this.prepared = undefined;
    }
  }
}

export interface CloudflarePublishingConnectionBoundary {
  getPublishingConnection(): Promise<CloudflarePublishingConnection>;
}

/**
 * Reads a configured custom-domain state only after the settings UI asks for
 * it. The Vault configuration supplies the hostname; the current secured
 * connection supplies the selected account and credential.
 */
export function createVaultCloudflarePagesDomainStatusInspector(input: {
  vaultRoot: string;
  connection: CloudflarePublishingConnectionBoundary;
  projectsForCredential(credential: string): Pick<
    CloudflarePagesProjectBoundary,
    'findProject' | 'inspectCustomDomain'
  >;
}): { inspect(): Promise<ConfiguredCustomDomainStatus> } {
  return {
    inspect: async () => {
      const config = await loadSiteConfigFromDirectory(input.vaultRoot);
      if (config.status !== 'editable') {
        throw new Error(`Site config version ${config.version} is read-only and cannot inspect a custom domain.`);
      }
      const hostname = config.config.cloudflare.customDomain;
      if (!hostname) return { state: 'not-configured' };
      const connection = await input.connection.getPublishingConnection();
      const projects = input.projectsForCredential(connection.credential);
      if (!projects.inspectCustomDomain) {
        return { state: 'unavailable' };
      }
      const project = await projects.findProject({
        accountId: connection.account.id,
        projectName: config.config.cloudflare.projectName,
      });
      if (!project) {
        return {
          state: 'failed',
          hostname,
          message: 'Cloudflare could not find the configured Pages project in the selected account.',
        };
      }
      if (
        project.accountId !== connection.account.id ||
        project.name !== config.config.cloudflare.projectName
      ) {
        return {
          state: 'failed',
          hostname,
          message: 'Cloudflare returned a project that does not match the configured publishing target.',
        };
      }
      const result = await projects.inspectCustomDomain({ project, hostname });
      return {
        state: result.status,
        hostname,
        ...(result.message === undefined ? {} : { message: result.message }),
      };
    },
  };
}

/**
 * Resolves the selected account and configured Pages project only at
 * publication validation time, then pins both through upload and activation.
 */
export function createVaultCloudflarePagesDeploymentAdapter(input: {
  vaultRoot: string;
  connection: CloudflarePublishingConnectionBoundary;
  http: CloudflarePagesHttpBoundary;
}): CloudflarePagesDeploymentBoundary {
  return new PinnedCloudflarePagesDeploymentAdapter({
    resolve: async () => {
      const target = await resolvePublishingTarget(input.vaultRoot, input.connection);
      return new CloudflarePagesHttpDeploymentAdapter({
        accountId: target.connection.account.id,
        projectName: target.projectName,
        credential: async () => target.connection.credential,
        http: input.http,
        activationTarget: {
          provider: 'cloudflare-pages',
          accountId: target.connection.account.id,
          projectName: target.projectName,
        },
      });
    },
  });
}

/** Reads a pending deployment during local publication-fact recovery. */
export class CloudflarePagesDeploymentInspector
  implements ActivatedDeploymentInspector {
  constructor(
    private readonly dependencies: {
      vaultRoot: string;
      connection: CloudflarePublishingConnectionBoundary;
      http: CloudflarePagesHttpBoundary;
    },
  ) {}

  async inspect(deploymentId: string): Promise<{
    deploymentId: string;
    url: string;
    status: string;
  }> {
    const target = await resolvePublishingTarget(
      this.dependencies.vaultRoot,
      this.dependencies.connection,
    );
    return this.inspectAtTarget({
      deploymentId,
      accountId: target.connection.account.id,
      projectName: target.projectName,
      credential: target.connection.credential,
    });
  }

  async inspectPending(input: {
    deploymentId: string;
    target: { provider: 'cloudflare-pages'; accountId: string; projectName: string };
  }): Promise<{
    deploymentId: string;
    url: string;
    status: string;
  }> {
    const connection = await this.dependencies.connection.getPublishingConnection();
    return this.inspectAtTarget({
      deploymentId: input.deploymentId,
      accountId: input.target.accountId,
      projectName: input.target.projectName,
      credential: connection.credential,
    });
  }

  private async inspectAtTarget(input: {
    deploymentId: string;
    accountId: string;
    projectName: string;
    credential: string;
  }): Promise<{
    deploymentId: string;
    url: string;
    status: string;
  }> {
    const result = await this.dependencies.http.request({
      path: `/accounts/${encodeURIComponent(input.accountId)}/pages/projects/${encodeURIComponent(input.projectName)}/deployments/${encodeURIComponent(input.deploymentId)}`,
      headers: bearerHeaders(input.credential),
    });
    if (
      !isRecord(result) ||
      typeof result.id !== 'string' ||
      typeof result.url !== 'string' ||
      !isRecord(result.latest_stage) ||
      typeof result.latest_stage.status !== 'string'
    ) {
      throw new Error('Cloudflare returned invalid deployment recovery data.');
    }
    return {
      deploymentId: result.id,
      url: result.url,
      status: result.latest_stage.status,
    };
  }
}

async function resolvePublishingTarget(
  vaultRoot: string,
  connection: CloudflarePublishingConnectionBoundary,
): Promise<{ connection: CloudflarePublishingConnection; projectName: string }> {
  const [config, publishingConnection] = await Promise.all([
    loadSiteConfigFromDirectory(vaultRoot),
    connection.getPublishingConnection(),
  ]);
  if (config.status !== 'editable') {
    throw new Error(`Site config version ${config.version} is read-only and cannot be published.`);
  }
  return {
    connection: publishingConnection,
    projectName: config.config.cloudflare.projectName,
  };
}

function isSuccessfulEnvelope(
  value: unknown,
): value is { success: true; result: unknown } {
  return typeof value === 'object' && value !== null &&
    (value as { success?: unknown }).success === true;
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function parseMembershipAccounts(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) {
    throw new Error('Cloudflare returned invalid membership data.');
  }
  return value.flatMap((membership) => {
    if (!isAcceptedMembership(membership)) return [];
    return [{ id: membership.account.id, name: membership.account.name }];
  });
}

function parseAccounts(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value) || !value.every(isAccount)) {
    throw new Error('Cloudflare returned invalid account data.');
  }
  return value.map((account) => ({ id: account.id, name: account.name }));
}

function isAcceptedMembership(value: unknown): value is {
  status: 'accepted';
  account: { id: string; name: string };
} {
  return isRecord(value) && value.status === 'accepted' && isAccount(value.account);
}

function isAccount(value: unknown): value is { id: string; name: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string';
}

function isActiveToken(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    (value as { status?: unknown }).status === 'active';
}

function parseProject(value: unknown, accountId: string): SetupProject {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw new Error('Cloudflare returned invalid Pages project data.');
  }
  return {
    id: value.id,
    name: value.name,
    accountId,
    pagesDevUrl: pagesDevUrl(value, value.name),
    compatible: isDirectUploadProject(value),
  };
}

function domainResult(value: unknown): SetupCustomDomainResult {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('Cloudflare returned invalid Pages domain data.');
  }
  if (value.status === 'active') return { status: 'active' };
  if (value.status === 'initializing' || value.status === 'pending') {
    return { status: 'pending' };
  }
  const detail = customDomainDetail(value);
  return {
    status: 'failed',
    message: detail === undefined
      ? 'Cloudflare could not activate the custom domain.'
      : `Cloudflare validation: ${detail}`,
  };
}

function domainPath(project: SetupProject): string {
  return `/accounts/${encodeURIComponent(project.accountId)}/pages/projects/${encodeURIComponent(project.name)}/domains`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasRequiredConnectionCapabilities(capabilities: readonly string[]): boolean {
  return ['account-read', 'pages-read', 'pages-write'].every((capability) =>
    capabilities.includes(capability),
  );
}

function isForbidden(error: unknown): error is CloudflareV4RequestError {
  return error instanceof CloudflareV4RequestError && error.status === 403;
}

function pagesDevUrl(project: Record<string, unknown>, name: string): string {
  const subdomain = typeof project.subdomain === 'string' && project.subdomain.length > 0
    ? project.subdomain
    : name;
  return `https://${subdomain.endsWith('.pages.dev') ? subdomain : `${subdomain}.pages.dev`}`;
}

function isDirectUploadProject(project: Record<string, unknown>): boolean {
  return project.source === undefined || project.source === null;
}

function formDataBody(
  body: string | FormData | undefined,
): { body: string | ArrayBuffer; contentType?: string } | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return { body };
  const boundary = `----pages-publish-${crypto.randomUUID().replaceAll('-', '')}`;
  const fields: string[] = [];
  body.forEach((value, name) => {
    if (typeof value !== 'string') {
      throw new Error('Cloudflare Pages deployment forms may only contain text fields.');
    }
    fields.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n${value}\r\n`,
    );
  });
  const source = `${fields.join('')}--${boundary}--\r\n`;
  const encoded = new TextEncoder().encode(source);
  return {
    body: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartValue(value: string): string {
  return value.replaceAll('"', '%22').replaceAll('\r', '').replaceAll('\n', '');
}

function cloudflareErrorDetail(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.errors)) return undefined;
  for (const error of value.errors) {
    if (!isRecord(error) || typeof error.message !== 'string') continue;
    return safeCloudflareDetail(error.message);
  }
  return undefined;
}

function customDomainDetail(value: Record<string, unknown>): string | undefined {
  for (const field of ['validation_data', 'verification_data', 'errors'] as const) {
    const detail = safeCloudflareDetailFromValue(value[field]);
    if (detail !== undefined) return detail;
  }
  return undefined;
}

function safeCloudflareDetailFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return safeCloudflareDetail(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const detail = safeCloudflareDetailFromValue(item);
      if (detail !== undefined) return detail;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const field of ['message', 'error', 'reason'] as const) {
      const detail = safeCloudflareDetailFromValue(value[field]);
      if (detail !== undefined) return detail;
    }
  }
  return undefined;
}

function safeCloudflareDetail(value: string): string | undefined {
  const normalized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bAuthorization\s*[:=]\s*[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\b(?:token|api[-_ ]?key|secret|password)\s*[-:=]\s*[^\s,;]+/gi, '[redacted]')
    .trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, 240);
}
