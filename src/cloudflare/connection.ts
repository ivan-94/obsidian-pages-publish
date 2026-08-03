import { createHash, randomBytes } from 'node:crypto';

export const CLOUD_FLARE_PAGES_SCOPES = [
  'memberships.read',
  'page.read',
  'page.write',
  'offline_access',
] as const;

/**
 * Provider adapters map these product capabilities to Cloudflare's current
 * API-token permission model. OAuth scopes deliberately remain separate.
 */
export const CLOUD_FLARE_PAGES_CAPABILITIES = [
  'account-read',
  'pages-read',
  'pages-write',
] as const;

const keychainService = 'pages-publish.cloudflare';
const refreshTokenKeychainService = 'pages-publish.cloudflare-refresh';
const oauthRefreshSkewMilliseconds = 60_000;

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareConnectionStatus {
  state: 'disconnected' | 'connected' | 'expired';
  method?: 'oauth' | 'api-token';
  account?: CloudflareAccount;
  /** Non-secret hint used to renew OAuth access before it expires. */
  accessTokenExpiresAt?: string;
}

export interface CloudflareOAuthBoundary {
  readonly available?: boolean;
  begin(input: {
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
    redirectUri?: string;
  }): Promise<{ authorizationUrl: string }>;
  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
  }): Promise<CloudflareOAuthTokens>;
  /** Optional so unsupported OAuth hosts degrade to an explicit reconnect. */
  refresh?(input: { refreshToken: string }): Promise<CloudflareOAuthTokens>;
}

export interface CloudflareOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
}

export interface CloudflareApiBoundary {
  verify(accessToken: string): Promise<CloudflareAccount>;
  verifyPermissions(
    accessToken: string,
    input: {
      accountId: string;
      capabilities: readonly (typeof CLOUD_FLARE_PAGES_CAPABILITIES)[number][];
    },
  ): Promise<boolean>;
  listAccounts(accessToken: string): Promise<CloudflareAccount[]>;
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

/** Credential hand-off restricted to concrete Pages host boundaries. */
export interface CloudflarePublishingConnection {
  account: CloudflareAccount;
  credential: string;
}

export type CloudflareOAuthExchangeRejectionReason =
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_request'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type';

/** A provider rejection reduced to a protocol-defined, non-secret reason. */
export class CloudflareOAuthExchangeRejectedError extends Error {
  readonly name = 'CloudflareOAuthExchangeRejectedError';

  constructor(readonly oauthReason: CloudflareOAuthExchangeRejectionReason) {
    super(`Cloudflare rejected the OAuth token exchange: ${oauthReason}.`);
  }
}

type CloudflareConnectionErrorCode =
  | 'api-account-verification-failed'
  | 'api-accounts-list-failed'
  | 'api-permissions-insufficient'
  | 'api-permissions-verification-failed'
  | 'account-selection-invalid'
  | 'binding-read-failed'
  | 'binding-write-failed'
  | 'credential-recovery-required'
  | 'credential-storage-failed'
  | 'credential-unavailable'
  | 'oauth-begin-failed'
  | 'oauth-callback-invalid'
  | 'oauth-exchange-failed'
  | 'oauth-refresh-failed'
  | 'oauth-refresh-unavailable';

/** A deliberately non-wrapping error safe to present in the UI or a log. */
export class CloudflareConnectionError extends Error {
  readonly name = 'CloudflareConnectionError';

  constructor(
    readonly code: CloudflareConnectionErrorCode,
    message: string,
    readonly oauthReason?: CloudflareOAuthExchangeRejectionReason,
  ) {
    super(message);
  }
}

export class CloudflareCredentialExpiredError extends Error {
  readonly name = 'CloudflareCredentialExpiredError';

  constructor() {
    super('The Cloudflare credential has expired.');
  }
}

/** A rejected refresh grant cannot be recovered without a new authorization. */
export class CloudflareOAuthRefreshRejectedError extends Error {
  readonly name = 'CloudflareOAuthRefreshRejectedError';

  constructor() {
    super('The Cloudflare refresh credential was rejected.');
  }
}

interface OAuthTransaction {
  state: string;
  codeVerifier: string;
  redirectUri?: string;
}

interface StoredConnection {
  binding: CloudflareConnectionStatus;
  credential: string;
  authorizedAccounts: CloudflareAccount[];
}

interface StoredCredentials {
  accessToken: string | undefined;
  refreshToken: string | undefined;
}

export class CloudflareConnectionService {
  private pendingOAuth: OAuthTransaction | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private recoveryStatus: CloudflareConnectionStatus | undefined;

  constructor(private readonly dependencies: CloudflareConnectionDependencies) {}

  isOAuthAvailable(): boolean {
    return this.dependencies.oauth.available !== false;
  }

  async beginOAuth(input: { redirectUri?: string } = {}): Promise<{ url: string }> {
    return this.runExclusively(async () => {
      const transaction = this.newOAuthTransaction(input.redirectUri);
      const request = await this.boundary(
        'oauth-begin-failed',
        'Could not start Cloudflare authorization.',
        () => this.dependencies.oauth.begin({
          scopes: CLOUD_FLARE_PAGES_SCOPES,
          state: transaction.state,
          codeChallenge: this.s256(transaction.codeVerifier),
          codeChallengeMethod: 'S256',
          redirectUri: input.redirectUri,
        }),
      );
      // A new attempt deliberately invalidates every previous callback.
      this.pendingOAuth = transaction;
      return { url: request.authorizationUrl };
    });
  }

  async completeOAuth(input: {
    state: string;
    code: string;
  }): Promise<CloudflareConnectionStatus> {
    const transaction = this.pendingOAuth;
    if (!transaction || input.state !== transaction.state) {
      throw new CloudflareConnectionError(
        'oauth-callback-invalid',
        'The OAuth callback could not be verified. Start authorization again.',
      );
    }
    // Consume before any await so a callback cannot be replayed concurrently.
    this.pendingOAuth = undefined;
    return this.runExclusively(async () => {
      this.assertRemoteActionsAllowed();
      const credential = await this.boundary(
        'oauth-exchange-failed',
        'Cloudflare authorization could not be completed. Start authorization again.',
        () => this.dependencies.oauth.exchange({
          code: input.code,
          codeVerifier: transaction.codeVerifier,
          redirectUri: transaction.redirectUri,
        }),
      );
      if (!credential.refreshToken) {
        throw new CloudflareConnectionError(
          'oauth-refresh-unavailable',
          'Cloudflare did not issue a refresh token. Check the OAuth client refresh-token grant and authorize again.',
        );
      }
      return this.connectVerifiedCredential(credential.accessToken, 'oauth', credential);
    });
  }

  async cancelOAuth(state: string): Promise<boolean> {
    return this.runExclusively(async () => {
      if (!this.pendingOAuth || this.pendingOAuth.state !== state) return false;
      this.pendingOAuth = undefined;
      return true;
    });
  }

  async abandonOAuth(): Promise<void> {
    await this.runExclusively(async () => {
      this.pendingOAuth = undefined;
    });
  }

  async connectApiToken(token: string): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      this.assertRemoteActionsAllowed();
      return this.connectVerifiedCredential(token, 'api-token');
    });
  }

  async listAvailableAccounts(): Promise<CloudflareAccount[]> {
    return this.runExclusively(async () => {
      this.assertRemoteActionsAllowed();
      const stored = await this.readUsableConnection();
      return stored.authorizedAccounts;
    });
  }

  async getPublishingConnection(): Promise<CloudflarePublishingConnection> {
    return this.runExclusively(async () => {
      const stored = await this.readUsableConnection();
      const account = stored.binding.account;
      if (!account) {
        throw new CloudflareConnectionError(
          'credential-unavailable',
          'Connect Cloudflare again before publishing.',
        );
      }
      return { account: { ...account }, credential: stored.credential };
    });
  }

  async selectAccount(accountId: string): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      this.assertRemoteActionsAllowed();
      const stored = await this.readUsableConnection();
      const accounts = stored.authorizedAccounts;
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        throw new CloudflareConnectionError(
          'account-selection-invalid',
          'The selected Cloudflare account is not available for Pages publishing.',
        );
      }
      const status: CloudflareConnectionStatus = {
        state: 'connected',
        method: stored.binding.method,
        account,
        ...(stored.binding.accessTokenExpiresAt
          ? { accessTokenExpiresAt: stored.binding.accessTokenExpiresAt }
          : {}),
      };
      try {
        await this.dependencies.bindings.write(status);
      } catch (error) {
        if (!(await this.restoreBinding(stored.binding))) {
          await this.requireRecovery(stored.binding);
          throw this.recoveryRequiredError();
        }
        throw this.safeError(
          error,
          'binding-write-failed',
          'The local Cloudflare connection status could not be saved.',
        );
      }
      return status;
    });
  }

  async refreshStatus(): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      if (this.recoveryStatus) return this.recoveryStatus;
      const binding = await this.readBinding();
      if (
        !binding ||
        binding.state === 'disconnected' ||
        binding.state === 'expired' ||
        !binding.method ||
        !binding.account
      ) {
        return binding?.state === 'expired' ? binding : { state: 'disconnected' };
      }
      try {
        const stored = await this.readUsableConnection();
        return stored.binding;
      } catch (error) {
        if (
          error instanceof CloudflareConnectionError
          && error.code === 'credential-unavailable'
        ) {
          return this.recoveryStatus
            ?? { state: 'expired', method: binding.method, account: binding.account };
        }
        throw error;
      }
    });
  }

  async disconnect(): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      const previousCredentials = await this.readStoredCredentials();
      const previousBinding = await this.readBinding();
      try {
        await this.dependencies.keychain.remove(keychainService);
        await this.dependencies.keychain.remove(refreshTokenKeychainService);
      } catch (error) {
        if (!(await this.restoreStoredCredentials(previousCredentials))) {
          await this.requireRecovery(previousBinding);
          throw this.recoveryRequiredError();
        }
        throw this.safeError(
          error,
          'credential-storage-failed',
          'The Cloudflare credential could not be removed from SecretStorage.',
        );
      }
      const status: CloudflareConnectionStatus = { state: 'disconnected' };
      try {
        await this.dependencies.bindings.write(status);
      } catch (error) {
        const credentialRestored = await this.restoreStoredCredentials(previousCredentials);
        const bindingRestored = await this.restoreBinding(previousBinding);
        if (!credentialRestored || !bindingRestored) {
          await this.requireRecovery(previousBinding);
          throw this.recoveryRequiredError();
        }
        throw this.safeError(
          error,
          'binding-write-failed',
          'The local Cloudflare connection status could not be saved.',
        );
      }
      this.recoveryStatus = undefined;
      return status;
    });
  }

  private async connectVerifiedCredential(
    credential: string,
    method: 'oauth' | 'api-token',
    oauthTokens?: CloudflareOAuthTokens,
  ): Promise<CloudflareConnectionStatus> {
    const verifiedAccount = method === 'api-token'
      ? await this.boundary(
        'api-account-verification-failed',
        'Cloudflare account verification failed. Check the credential and retry.',
        () => this.dependencies.api.verify(credential),
      )
      : undefined;
    const candidates = await this.listAuthorizedAccounts(credential);
    const account = candidates.find((candidate) => candidate.id === verifiedAccount?.id)
      ?? candidates[0];
    if (!account) {
      throw new CloudflareConnectionError(
        'api-permissions-insufficient',
        'The credential does not have the required Pages permissions.',
      );
    }
    const status = this.connectedStatus(method, account, oauthTokens?.expiresInSeconds);
    await this.persistConnection(
      { accessToken: credential, refreshToken: method === 'oauth' ? oauthTokens?.refreshToken : undefined },
      status,
    );
    return status;
  }

  private async readUsableConnection(): Promise<StoredConnection> {
    const binding = await this.readBinding();
    if (
      !binding ||
      binding.state !== 'connected' ||
      !binding.method ||
      !binding.account
    ) {
      throw new CloudflareConnectionError(
        'credential-unavailable',
        'Connect Cloudflare again before selecting an account.',
      );
    }
    let credential = await this.readCredential();
    if (!credential) {
      await this.markExpired(binding);
      throw new CloudflareConnectionError(
        'credential-unavailable',
        'The Cloudflare credential is unavailable. Connect Cloudflare again.',
      );
    }
    let activeBinding = binding;
    if (binding.method === 'oauth' && this.shouldRefreshOAuthAccessToken(binding)) {
      const refreshed = await this.refreshOAuthCredential(binding);
      activeBinding = refreshed.binding;
      credential = refreshed.credential;
    }
    try {
      const authorizedAccounts = await this.validateStoredConnection(credential, activeBinding);
      return { binding: activeBinding, credential, authorizedAccounts };
    } catch (error) {
      if (!(error instanceof CloudflareCredentialExpiredError) || activeBinding.method !== 'oauth') {
        throw error;
      }
      const refreshed = await this.refreshOAuthCredential(activeBinding);
      const authorizedAccounts = await this.validateStoredConnection(
        refreshed.credential,
        refreshed.binding,
      );
      return { ...refreshed, authorizedAccounts };
    }
  }

  private async validateStoredConnection(
    credential: string,
    binding: CloudflareConnectionStatus,
  ): Promise<CloudflareAccount[]> {
    if (binding.method === 'api-token') {
      try {
        await this.dependencies.api.verify(credential);
      } catch (error) {
        if (error instanceof CloudflareCredentialExpiredError) {
          try {
            await this.markExpired(binding);
          } catch {
            await this.requireRecovery(binding);
            throw this.recoveryRequiredError();
          }
          throw new CloudflareConnectionError(
            'credential-unavailable',
            'The Cloudflare credential has expired. Connect Cloudflare again.',
          );
        }
        throw this.safeError(
          error,
          'api-account-verification-failed',
          'Cloudflare connection verification failed. Retry the connection.',
        );
      }
    }
    const authorizedAccounts = await this.listAuthorizedAccounts(credential, binding);
    if (!binding.account || !authorizedAccounts.some((account) => account.id === binding.account?.id)) {
      await this.requireRecovery(binding);
      throw this.recoveryRequiredError();
    }
    return authorizedAccounts;
  }

  private async listAuthorizedAccounts(
    credential: string,
    binding?: CloudflareConnectionStatus,
  ): Promise<CloudflareAccount[]> {
    let accounts: CloudflareAccount[];
    try {
      accounts = await this.dependencies.api.listAccounts(credential);
    } catch (error) {
      await this.handleExpiredCredential(error, binding);
      throw this.safeError(
        error,
        'api-accounts-list-failed',
        'Cloudflare accounts could not be loaded. Retry the connection.',
      );
    }

    const permitted: CloudflareAccount[] = [];
    for (const account of accounts) {
      try {
        const allowed = await this.dependencies.api.verifyPermissions(credential, {
          accountId: account.id,
          capabilities: CLOUD_FLARE_PAGES_CAPABILITIES,
        });
        if (allowed) permitted.push(account);
      } catch (error) {
        await this.handleExpiredCredential(error, binding);
        throw this.safeError(
          error,
          'api-permissions-verification-failed',
          'Cloudflare Pages permissions could not be verified. Retry the connection.',
        );
      }
    }
    return permitted;
  }

  private async handleExpiredCredential(
    error: unknown,
    binding: CloudflareConnectionStatus | undefined,
  ): Promise<void> {
    if (!(error instanceof CloudflareCredentialExpiredError)) return;
    if (binding?.method === 'oauth') throw error;
    if (binding) {
      try {
        await this.markExpired(binding);
      } catch {
        await this.requireRecovery(binding);
        throw this.recoveryRequiredError();
      }
    }
    throw new CloudflareConnectionError(
      'credential-unavailable',
      'The Cloudflare credential has expired. Connect Cloudflare again.',
    );
  }

  private shouldRefreshOAuthAccessToken(binding: CloudflareConnectionStatus): boolean {
    if (!binding.accessTokenExpiresAt) return false;
    const expiresAt = Date.parse(binding.accessTokenExpiresAt);
    return Number.isFinite(expiresAt)
      && expiresAt <= Date.now() + oauthRefreshSkewMilliseconds;
  }

  private async refreshOAuthCredential(
    binding: CloudflareConnectionStatus,
  ): Promise<Pick<StoredConnection, 'binding' | 'credential'>> {
    const refreshToken = await this.readRefreshToken();
    const oauth = this.dependencies.oauth;
    if (!oauth.refresh || !refreshToken || !binding.account) {
      await this.expireOAuthConnection(binding);
      throw new CloudflareConnectionError(
        'credential-unavailable',
        'Cloudflare authorization needs to be renewed. Connect Cloudflare again.',
      );
    }

    let tokens: CloudflareOAuthTokens;
    try {
      tokens = await oauth.refresh({ refreshToken });
    } catch (error) {
      if (error instanceof CloudflareOAuthRefreshRejectedError) {
        await this.expireOAuthConnection(binding);
        throw new CloudflareConnectionError(
          'credential-unavailable',
          'Cloudflare authorization needs to be renewed. Connect Cloudflare again.',
        );
      }
      throw this.safeError(
        error,
        'oauth-refresh-failed',
        'Cloudflare authorization could not be renewed. Retry publishing.',
      );
    }
    const status = this.connectedStatus('oauth', binding.account, tokens.expiresInSeconds);
    await this.persistConnection(
      { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? refreshToken },
      status,
    );
    return { binding: status, credential: tokens.accessToken };
  }

  private async expireOAuthConnection(binding: CloudflareConnectionStatus): Promise<void> {
    try {
      await this.markExpired(binding);
    } catch {
      await this.requireRecovery(binding);
      throw this.recoveryRequiredError();
    }
  }

  private connectedStatus(
    method: 'oauth' | 'api-token',
    account: CloudflareAccount,
    expiresInSeconds: number | undefined,
  ): CloudflareConnectionStatus {
    const accessTokenExpiresAt = method === 'oauth'
      && typeof expiresInSeconds === 'number'
      && Number.isFinite(expiresInSeconds)
      && expiresInSeconds > 0
      ? new Date(Date.now() + expiresInSeconds * 1_000).toISOString()
      : undefined;
    return {
      state: 'connected',
      method,
      account,
      ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
    };
  }

  private async persistConnection(
    credentials: { accessToken: string; refreshToken: string | undefined },
    status: CloudflareConnectionStatus,
  ): Promise<void> {
    const previousCredentials = await this.readStoredCredentials();
    const previousBinding = await this.readBinding();
    try {
      await this.dependencies.keychain.save(keychainService, credentials.accessToken);
      if (credentials.refreshToken) {
        await this.dependencies.keychain.save(refreshTokenKeychainService, credentials.refreshToken);
      } else if (previousCredentials.refreshToken) {
        await this.dependencies.keychain.remove(refreshTokenKeychainService);
      }
    } catch (error) {
      if (!(await this.restoreStoredCredentials(previousCredentials))) {
        await this.requireRecovery(previousBinding ?? status);
        throw this.recoveryRequiredError();
      }
      throw this.safeError(
        error,
        'credential-storage-failed',
        'The Cloudflare credential could not be saved in SecretStorage.',
      );
    }
    try {
      await this.dependencies.bindings.write(status);
    } catch (error) {
      const credentialsRestored = await this.restoreStoredCredentials(previousCredentials);
      const bindingRestored = await this.restoreBinding(previousBinding);
      if (!credentialsRestored || !bindingRestored) {
        await this.requireRecovery(previousBinding ?? status);
        throw this.recoveryRequiredError();
      }
      throw this.safeError(
        error,
        'binding-write-failed',
        'The local Cloudflare connection status could not be saved.',
      );
    }
  }

  private async readBinding(): Promise<CloudflareConnectionStatus | undefined> {
    return this.boundary(
      'binding-read-failed',
      'The local Cloudflare connection status could not be read.',
      () => this.dependencies.bindings.read(),
    );
  }

  private async writeBinding(status: CloudflareConnectionStatus): Promise<void> {
    return this.boundary(
      'binding-write-failed',
      'The local Cloudflare connection status could not be saved.',
      () => this.dependencies.bindings.write(status),
    );
  }

  private async readCredential(): Promise<string | undefined> {
    return this.boundary(
      'credential-storage-failed',
      'The Cloudflare credential could not be read from SecretStorage.',
      () => this.dependencies.keychain.read(keychainService),
    );
  }

  private async readRefreshToken(): Promise<string | undefined> {
    return this.boundary(
      'credential-storage-failed',
      'The Cloudflare credential could not be read from SecretStorage.',
      () => this.dependencies.keychain.read(refreshTokenKeychainService),
    );
  }

  private async readStoredCredentials(): Promise<StoredCredentials> {
    const [accessToken, refreshToken] = await Promise.all([
      this.readCredential(),
      this.readRefreshToken(),
    ]);
    return { accessToken, refreshToken };
  }

  private async restoreStoredCredentials(previous: StoredCredentials): Promise<boolean> {
    try {
      if (previous.accessToken) {
        await this.dependencies.keychain.save(keychainService, previous.accessToken);
      } else {
        await this.dependencies.keychain.remove(keychainService);
      }
      if (previous.refreshToken) {
        await this.dependencies.keychain.save(refreshTokenKeychainService, previous.refreshToken);
      } else {
        await this.dependencies.keychain.remove(refreshTokenKeychainService);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async restoreBinding(
    previousBinding: CloudflareConnectionStatus | undefined,
  ): Promise<boolean> {
    try {
      await this.dependencies.bindings.write(previousBinding ?? { state: 'disconnected' });
      return true;
    } catch {
      return false;
    }
  }

  private async markExpired(
    binding: CloudflareConnectionStatus,
  ): Promise<CloudflareConnectionStatus> {
    const status: CloudflareConnectionStatus = {
      state: 'expired',
      ...(binding.method ? { method: binding.method } : {}),
      ...(binding.account ? { account: binding.account } : {}),
    };
    await this.writeBinding(status);
    return status;
  }

  private async requireRecovery(
    binding: CloudflareConnectionStatus | undefined,
  ): Promise<void> {
    const status: CloudflareConnectionStatus = {
      state: 'expired',
      ...(binding?.method ? { method: binding.method } : {}),
      ...(binding?.account ? { account: binding.account } : {}),
    };
    this.recoveryStatus = status;
    try {
      await this.dependencies.bindings.write(status);
    } catch {
      // The in-memory guard still prevents remote calls for this session.
    }
  }

  private recoveryRequiredError(): CloudflareConnectionError {
    return new CloudflareConnectionError(
      'credential-recovery-required',
      'Cloudflare credential storage needs repair. Reconnect Cloudflare before publishing.',
    );
  }

  private assertRemoteActionsAllowed(): void {
    if (this.recoveryStatus) throw this.recoveryRequiredError();
  }

  private async boundary<T>(
    code: Exclude<CloudflareConnectionErrorCode, 'api-permissions-insufficient' | 'account-selection-invalid' | 'credential-recovery-required' | 'oauth-callback-invalid'>,
    message: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw this.safeError(error, code, message);
    }
  }

  private safeError(
    error: unknown,
    code: CloudflareConnectionErrorCode,
    message: string,
  ): CloudflareConnectionError {
    const oauthReason = code === 'oauth-exchange-failed' &&
      error instanceof CloudflareOAuthExchangeRejectedError
      ? error.oauthReason
      : undefined;
    return new CloudflareConnectionError(code, message, oauthReason);
  }

  private newOAuthTransaction(redirectUri?: string): OAuthTransaction {
    return {
      state: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url'),
      ...(redirectUri === undefined ? {} : { redirectUri }),
    };
  }

  private s256(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
  }

  private async runExclusively<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release?.();
    }
  }
}
