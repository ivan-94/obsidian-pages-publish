import { createHash, randomBytes } from 'node:crypto';

export const CLOUD_FLARE_PAGES_SCOPES = [
  'account:read',
  'pages:read',
  'pages:write',
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
  begin(input: {
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
  }): Promise<{ authorizationUrl: string }>;
  exchange(input: {
    code: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string }>;
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
  | 'oauth-exchange-failed';

/** A deliberately non-wrapping error safe to present in the UI or a log. */
export class CloudflareConnectionError extends Error {
  readonly name = 'CloudflareConnectionError';

  constructor(
    readonly code: CloudflareConnectionErrorCode,
    message: string,
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

interface OAuthTransaction {
  state: string;
  codeVerifier: string;
}

interface StoredConnection {
  binding: CloudflareConnectionStatus;
  credential: string;
}

export class CloudflareConnectionService {
  private pendingOAuth: OAuthTransaction | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private recoveryStatus: CloudflareConnectionStatus | undefined;

  constructor(private readonly dependencies: CloudflareConnectionDependencies) {}

  async beginOAuth(): Promise<{ url: string }> {
    return this.runExclusively(async () => {
      const transaction = this.newOAuthTransaction();
      const request = await this.boundary(
        'oauth-begin-failed',
        'Could not start Cloudflare authorization.',
        () => this.dependencies.oauth.begin({
          scopes: CLOUD_FLARE_PAGES_SCOPES,
          state: transaction.state,
          codeChallenge: this.s256(transaction.codeVerifier),
          codeChallengeMethod: 'S256',
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
        }),
      );
      return this.connectVerifiedCredential(credential.accessToken, 'oauth');
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
      return this.listAuthorizedAccounts(stored.credential, stored.binding);
    });
  }

  async selectAccount(accountId: string): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      this.assertRemoteActionsAllowed();
      const stored = await this.readUsableConnection();
      const accounts = await this.listAuthorizedAccounts(stored.credential, stored.binding);
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
      const credential = await this.readCredential();
      if (!credential) return this.markExpired(binding);
      try {
        const verifiedAccount = await this.dependencies.api.verify(credential);
        if (verifiedAccount.id !== binding.account.id) {
          await this.requireRecovery(binding);
          return this.recoveryStatus ?? { state: 'expired' };
        }
      } catch (error) {
        if (error instanceof CloudflareCredentialExpiredError) return this.markExpired(binding);
        throw this.safeError(
          error,
          'api-account-verification-failed',
          'Cloudflare connection verification failed. Retry the connection.',
        );
      }
      return {
        state: 'connected',
        method: binding.method,
        account: binding.account,
      };
    });
  }

  async disconnect(): Promise<CloudflareConnectionStatus> {
    return this.runExclusively(async () => {
      const previousCredential = await this.readCredential();
      const previousBinding = await this.readBinding();
      await this.boundary(
        'credential-storage-failed',
        'The Cloudflare credential could not be removed from Keychain.',
        () => this.dependencies.keychain.remove(keychainService),
      );
      const status: CloudflareConnectionStatus = { state: 'disconnected' };
      try {
        await this.dependencies.bindings.write(status);
      } catch (error) {
        const credentialRestored = await this.restoreCredential(previousCredential);
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
  ): Promise<CloudflareConnectionStatus> {
    const verifiedAccount = await this.boundary(
      'api-account-verification-failed',
      'Cloudflare account verification failed. Check the credential and retry.',
      () => this.dependencies.api.verify(credential),
    );
    const candidates = await this.listAuthorizedAccounts(credential);
    const account = candidates.find((candidate) => candidate.id === verifiedAccount.id)
      ?? candidates[0];
    if (!account) {
      throw new CloudflareConnectionError(
        'api-permissions-insufficient',
        'The credential does not have the required Pages permissions.',
      );
    }
    const status: CloudflareConnectionStatus = { state: 'connected', method, account };
    const previousCredential = await this.readCredential();
    const previousBinding = await this.readBinding();
    await this.boundary(
      'credential-storage-failed',
      'The Cloudflare credential could not be saved in Keychain.',
      () => this.dependencies.keychain.save(keychainService, credential),
    );
    try {
      await this.dependencies.bindings.write(status);
    } catch (error) {
      const credentialRestored = await this.restoreCredential(previousCredential);
      const bindingRestored = await this.restoreBinding(previousBinding);
      if (!credentialRestored || !bindingRestored) {
        await this.requireRecovery(previousBinding ?? status);
        throw this.recoveryRequiredError();
      }
      throw this.safeError(
        error,
        'binding-write-failed',
        'The local Cloudflare connection status could not be saved.',
      );
    }
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
    const credential = await this.readCredential();
    if (!credential) {
      await this.markExpired(binding);
      throw new CloudflareConnectionError(
        'credential-unavailable',
        'The Cloudflare credential is unavailable. Connect Cloudflare again.',
      );
    }
    let verifiedAccount: CloudflareAccount;
    try {
      verifiedAccount = await this.dependencies.api.verify(credential);
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
    if (verifiedAccount.id !== binding.account.id) {
      await this.requireRecovery(binding);
      throw this.recoveryRequiredError();
    }
    return { binding, credential };
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
      'The Cloudflare credential could not be read from Keychain.',
      () => this.dependencies.keychain.read(keychainService),
    );
  }

  private async restoreCredential(previousCredential: string | undefined): Promise<boolean> {
    try {
      if (previousCredential) {
        await this.dependencies.keychain.save(keychainService, previousCredential);
      } else {
        await this.dependencies.keychain.remove(keychainService);
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
    return new CloudflareConnectionError(code, message);
  }

  private newOAuthTransaction(): OAuthTransaction {
    return {
      state: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url'),
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
