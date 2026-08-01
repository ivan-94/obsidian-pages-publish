export const CLOUD_FLARE_PAGES_SCOPES = [
  'account:read',
  'pages:read',
  'pages:write',
] as const;

const keychainService = 'pages-publish.cloudflare';

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareConnectionStatus {
  state: 'disconnected' | 'connected' | 'expired';
  method?: 'oauth' | 'api-token';
  account?: CloudflareAccount;
}

export interface CloudflareOAuthBoundary {
  begin(input: { scopes: readonly string[] }): Promise<{
    authorizationUrl: string;
    state: string;
  }>;
  exchange(input: { code: string }): Promise<{ accessToken: string }>;
}

export interface CloudflareApiBoundary {
  verify(accessToken: string): Promise<CloudflareAccount>;
}

export interface CloudflareKeychainBoundary {
  save(service: string, secret: string): Promise<void>;
  read(service: string): Promise<string | undefined>;
  remove(service: string): Promise<void>;
}

export interface CloudflareBindingStore {
  read(): Promise<CloudflareConnectionStatus | undefined>;
  write(status: CloudflareConnectionStatus): Promise<void>;
}

export interface CloudflareConnectionDependencies {
  oauth: CloudflareOAuthBoundary;
  api: CloudflareApiBoundary;
  keychain: CloudflareKeychainBoundary;
  bindings: CloudflareBindingStore;
}

export class CloudflareCredentialExpiredError extends Error {
  readonly name = 'CloudflareCredentialExpiredError';

  constructor() {
    super('The Cloudflare credential has expired.');
  }
}

export class CloudflareConnectionService {
  private pendingOAuthState: string | undefined;

  constructor(private readonly dependencies: CloudflareConnectionDependencies) {}

  async beginOAuth(): Promise<{ url: string }> {
    const request = await this.dependencies.oauth.begin({
      scopes: CLOUD_FLARE_PAGES_SCOPES,
    });
    this.pendingOAuthState = request.state;
    return { url: request.authorizationUrl };
  }

  async completeOAuth(input: {
    state: string;
    code: string;
  }): Promise<CloudflareConnectionStatus> {
    if (!this.pendingOAuthState || input.state !== this.pendingOAuthState) {
      throw new Error('The OAuth callback could not be verified.');
    }
    this.pendingOAuthState = undefined;
    const credential = await this.dependencies.oauth.exchange({ code: input.code });
    return this.connectVerifiedCredential(credential.accessToken, 'oauth');
  }

  async connectApiToken(token: string): Promise<CloudflareConnectionStatus> {
    return this.connectVerifiedCredential(token, 'api-token');
  }

  async refreshStatus(): Promise<CloudflareConnectionStatus> {
    const binding = await this.dependencies.bindings.read();
    if (
      !binding ||
      binding.state === 'disconnected' ||
      !binding.method ||
      !binding.account
    ) {
      return { state: 'disconnected' };
    }
    const credential = await this.dependencies.keychain.read(keychainService);
    if (!credential) return this.expiredStatus(binding);
    try {
      const account = await this.dependencies.api.verify(credential);
      return {
        state: 'connected',
        method: binding.method,
        account,
      };
    } catch (error) {
      if (error instanceof CloudflareCredentialExpiredError) {
        return this.expiredStatus(binding);
      }
      throw error;
    }
  }

  async disconnect(): Promise<CloudflareConnectionStatus> {
    const status: CloudflareConnectionStatus = { state: 'disconnected' };
    await this.dependencies.keychain.remove(keychainService);
    await this.dependencies.bindings.write(status);
    return status;
  }

  private async connectVerifiedCredential(
    credential: string,
    method: 'oauth' | 'api-token',
  ): Promise<CloudflareConnectionStatus> {
    const account = await this.dependencies.api.verify(credential);
    const status: CloudflareConnectionStatus = {
      state: 'connected',
      method,
      account,
    };
    await this.dependencies.keychain.save(keychainService, credential);
    await this.dependencies.bindings.write(status);
    return status;
  }

  private async expiredStatus(
    binding: CloudflareConnectionStatus,
  ): Promise<CloudflareConnectionStatus> {
    const status: CloudflareConnectionStatus = {
      state: 'expired',
      ...(binding.method ? { method: binding.method } : {}),
      ...(binding.account ? { account: binding.account } : {}),
    };
    await this.dependencies.bindings.write(status);
    return status;
  }
}
