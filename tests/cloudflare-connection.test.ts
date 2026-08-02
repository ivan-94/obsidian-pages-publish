import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareConnectionError,
  CloudflareConnectionService,
  CloudflareCredentialExpiredError,
  CloudflareOAuthRefreshRejectedError,
  CLOUD_FLARE_PAGES_CAPABILITIES,
  type CloudflareAccount,
  type CloudflareConnectionDependencies,
} from '../src/cloudflare/connection';

const personal: CloudflareAccount = { id: 'account-1', name: 'Personal account' };
const work: CloudflareAccount = { id: 'account-2', name: 'Work account' };

function makeDependencies(
  overrides: Partial<CloudflareConnectionDependencies> = {},
): CloudflareConnectionDependencies {
  return {
    oauth: {
      begin: async () => ({ authorizationUrl: 'https://example.test/authorize' }),
      exchange: async () => ({ accessToken: 'oauth-access-secret' }),
    },
    api: {
      verify: async () => personal,
      verifyPermissions: async () => true,
      listAccounts: async () => [personal, work],
    },
    keychain: {
      save: async () => undefined,
      read: async () => undefined,
      remove: async () => undefined,
    },
    bindings: {
      read: async () => undefined,
      write: async () => undefined,
    },
    ...overrides,
  };
}

describe('Cloudflare connection service', () => {
  it('uses minimum OAuth scopes with a unique S256 PKCE transaction and rejects replay', async () => {
    const requests: Array<{
      scopes: readonly string[];
      state: string;
      codeChallenge: string;
      codeChallengeMethod: 'S256';
      redirectUri?: string;
    }> = [];
    const beginOAuth = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      return { authorizationUrl: 'https://dash.cloudflare.com/oauth/authorize' };
    });
    const exchanges: Array<{ code: string; codeVerifier: string; redirectUri?: string }> = [];
    const exchange = vi.fn(async (input: (typeof exchanges)[number]) => {
      exchanges.push(input);
      return { accessToken: 'oauth-access-secret' };
    });
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: { begin: beginOAuth, exchange },
      keychain,
    }));

    const redirectUri = 'http://127.0.0.1:8977/oauth/callback';
    const first = await service.beginOAuth({ redirectUri });
    const firstRequest = requests[0];
    const second = await service.beginOAuth({ redirectUri });
    const secondRequest = requests[1];

    expect(first.url).toContain('https://dash.cloudflare.com/oauth/authorize');
    expect(second.url).toContain('https://dash.cloudflare.com/oauth/authorize');
    expect(firstRequest).toMatchObject({
      scopes: ['memberships.read', 'page.read', 'page.write'],
      codeChallengeMethod: 'S256',
    });
    expect(firstRequest?.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstRequest?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstRequest?.redirectUri).toBe(redirectUri);
    expect(secondRequest?.state).not.toBe(firstRequest?.state);

    await expect(
      service.completeOAuth({ state: firstRequest?.state ?? '', code: 'stale-code' }),
    ).rejects.toMatchObject({ code: 'oauth-callback-invalid' });
    await service.completeOAuth({ state: secondRequest?.state ?? '', code: 'code-secret' });
    await expect(
      service.completeOAuth({ state: secondRequest?.state ?? '', code: 'replayed-code' }),
    ).rejects.toMatchObject({ code: 'oauth-callback-invalid' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe('code-secret');
    expect(exchanges[0]?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanges[0]?.redirectUri).toBe(redirectUri);
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'oauth-access-secret',
    );
  });

  it('cancels only the matching in-flight OAuth transaction', async () => {
    let state = '';
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async (input) => {
          state = input.state;
          return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' };
        },
        exchange: async () => ({ accessToken: 'oauth-access-secret' }),
      },
    }));
    await service.beginOAuth();

    await expect(service.cancelOAuth('stale-state')).resolves.toBe(false);
    await expect(service.cancelOAuth(state)).resolves.toBe(true);
    await expect(service.completeOAuth({
      state,
      code: 'cancelled-code',
    })).rejects.toMatchObject({ code: 'oauth-callback-invalid' });
  });

  it('verifies an OAuth grant through memberships and Pages without the API Token verify endpoint', async () => {
    let state = '';
    const verify = vi.fn(async () => {
      throw new Error('API Token verification must not receive an OAuth credential');
    });
    const listAccounts = vi.fn(async () => [personal]);
    const verifyPermissions = vi.fn(async () => true);
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async (input) => {
          state = input.state;
          return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' };
        },
        exchange: async () => ({ accessToken: 'oauth-access-secret' }),
      },
      api: { verify, listAccounts, verifyPermissions },
    }));

    await service.beginOAuth();

    await expect(service.completeOAuth({ state, code: 'authorization-code' })).resolves.toEqual({
      state: 'connected',
      method: 'oauth',
      account: personal,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(listAccounts).toHaveBeenCalledWith('oauth-access-secret');
    expect(verifyPermissions).toHaveBeenCalledWith('oauth-access-secret', {
      accountId: personal.id,
      capabilities: CLOUD_FLARE_PAGES_CAPABILITIES,
    });
  });

  it('stores OAuth refresh credentials separately and records only the access expiry in local status', async () => {
    let state = '';
    const secrets = new Map<string, string>();
    let persisted: unknown;
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async (input) => {
          state = input.state;
          return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' };
        },
        exchange: async () => ({
          accessToken: 'oauth-access-secret',
          refreshToken: 'oauth-refresh-secret',
          expiresInSeconds: 3600,
        }),
      },
      keychain: {
        save: async (serviceName, secret) => { secrets.set(serviceName, secret); },
        read: async (serviceName) => secrets.get(serviceName),
        remove: async (serviceName) => { secrets.delete(serviceName); },
      },
      bindings: {
        read: async () => undefined,
        write: async (status) => { persisted = status; },
      },
    }));

    await service.beginOAuth();
    await service.completeOAuth({ state, code: 'authorization-code' });

    expect(secrets.get('pages-publish.cloudflare')).toBe('oauth-access-secret');
    expect(secrets.get('pages-publish.cloudflare-refresh')).toBe('oauth-refresh-secret');
    expect(persisted).toMatchObject({
      state: 'connected',
      method: 'oauth',
      account: personal,
    });
    expect(Date.parse((persisted as { accessTokenExpiresAt?: string }).accessTokenExpiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(JSON.stringify(persisted)).not.toContain('oauth-access-secret');
    expect(JSON.stringify(persisted)).not.toContain('oauth-refresh-secret');
  });

  it('refreshes an OAuth access token before expiry and keeps a rotated refresh credential secure', async () => {
    const secrets = new Map([
      ['pages-publish.cloudflare', 'expiring-access-secret'],
      ['pages-publish.cloudflare-refresh', 'previous-refresh-secret'],
    ]);
    const refresh = vi.fn(async () => ({
      accessToken: 'renewed-access-secret',
      refreshToken: 'rotated-refresh-secret',
      expiresInSeconds: 3600,
    }));
    let persisted: unknown;
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async () => ({ authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' }),
        exchange: async () => ({ accessToken: 'unused' }),
        refresh,
      },
      api: {
        verify: async () => personal,
        verifyPermissions: async () => true,
        listAccounts: async (token) => {
          expect(token).toBe('renewed-access-secret');
          return [personal];
        },
      },
      keychain: {
        save: async (serviceName, secret) => { secrets.set(serviceName, secret); },
        read: async (serviceName) => secrets.get(serviceName),
        remove: async (serviceName) => { secrets.delete(serviceName); },
      },
      bindings: {
        read: async () => ({
          state: 'connected',
          method: 'oauth',
          account: personal,
          accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        }),
        write: async (status) => { persisted = status; },
      },
    }));

    await expect(service.getPublishingConnection()).resolves.toEqual({
      account: personal,
      credential: 'renewed-access-secret',
    });
    expect(refresh).toHaveBeenCalledWith({ refreshToken: 'previous-refresh-secret' });
    expect(secrets.get('pages-publish.cloudflare')).toBe('renewed-access-secret');
    expect(secrets.get('pages-publish.cloudflare-refresh')).toBe('rotated-refresh-secret');
    expect(JSON.stringify(persisted)).not.toContain('renewed-access-secret');
    expect(JSON.stringify(persisted)).not.toContain('rotated-refresh-secret');
  });

  it('refreshes and retries once when Cloudflare rejects an OAuth access token early', async () => {
    const secrets = new Map([
      ['pages-publish.cloudflare', 'rejected-access-secret'],
      ['pages-publish.cloudflare-refresh', 'refresh-secret'],
    ]);
    const listAccounts = vi.fn(async (token: string) => {
      if (token === 'rejected-access-secret') throw new CloudflareCredentialExpiredError();
      return [personal];
    });
    const refresh = vi.fn(async () => ({ accessToken: 'replacement-access-secret' }));
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async () => ({ authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' }),
        exchange: async () => ({ accessToken: 'unused' }),
        refresh,
      },
      api: { verify: async () => personal, verifyPermissions: async () => true, listAccounts },
      keychain: {
        save: async (serviceName, secret) => { secrets.set(serviceName, secret); },
        read: async (serviceName) => secrets.get(serviceName),
        remove: async (serviceName) => { secrets.delete(serviceName); },
      },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.getPublishingConnection()).resolves.toEqual({
      account: personal,
      credential: 'replacement-access-secret',
    });
    expect(refresh).toHaveBeenCalledWith({ refreshToken: 'refresh-secret' });
    expect(listAccounts).toHaveBeenNthCalledWith(1, 'rejected-access-secret');
    expect(listAccounts).toHaveBeenNthCalledWith(2, 'replacement-access-secret');
  });

  it('requires reauthorization only when Cloudflare rejects the refresh grant', async () => {
    const write = vi.fn(async () => undefined);
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async () => ({ authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' }),
        exchange: async () => ({ accessToken: 'unused' }),
        refresh: async () => { throw new CloudflareOAuthRefreshRejectedError(); },
      },
      keychain: {
        save: vi.fn(),
        read: async (serviceName) => serviceName === 'pages-publish.cloudflare'
          ? 'expired-access-secret'
          : 'rejected-refresh-secret',
        remove: vi.fn(),
      },
      bindings: {
        read: async () => ({
          state: 'connected',
          method: 'oauth',
          account: personal,
          accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        write,
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'expired',
      method: 'oauth',
      account: personal,
    });
    expect(write).toHaveBeenCalledWith({ state: 'expired', method: 'oauth', account: personal });
  });

  it('validates an advanced API Token for generic Pages capabilities before persisting it', async () => {
    const verify = vi.fn(async () => work);
    const verifyPermissions = vi.fn(async () => true);
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      api: { verify, verifyPermissions, listAccounts: async () => [work] },
      keychain,
    }));

    await expect(service.connectApiToken('advanced-token-secret')).resolves.toEqual({
      state: 'connected',
      method: 'api-token',
      account: work,
    });
    expect(verify).toHaveBeenCalledWith('advanced-token-secret');
    expect(verifyPermissions).toHaveBeenCalledWith('advanced-token-secret', {
      accountId: 'account-2',
      capabilities: CLOUD_FLARE_PAGES_CAPABILITIES,
    });
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'advanced-token-secret',
    );
  });

  it('rejects an API Token without Pages permissions before it reaches Keychain', async () => {
    const keychain = { save: vi.fn(), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => work,
        verifyPermissions: async () => false,
        listAccounts: async () => [work],
      },
      keychain,
    }));

    await expect(service.connectApiToken('insufficient-token')).rejects.toMatchObject({
      code: 'api-permissions-insufficient',
    });
    expect(keychain.save).not.toHaveBeenCalled();
  });

  it('does not persist an OAuth credential when membership discovery fails', async () => {
    let state = '';
    const keychain = { save: vi.fn(), read: vi.fn(), remove: vi.fn() };
    const bindings = { read: vi.fn(), write: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: {
        begin: async (input) => {
          state = input.state;
          return { authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' };
        },
        exchange: async () => ({ accessToken: 'oauth-access-secret' }),
      },
      api: {
        verify: vi.fn(),
        verifyPermissions: vi.fn(),
        listAccounts: async () => { throw new Error('membership discovery failed'); },
      },
      keychain,
      bindings,
    }));

    await service.beginOAuth();

    await expect(service.completeOAuth({ state, code: 'authorization-code' })).rejects.toMatchObject({
      code: 'api-accounts-list-failed',
    });
    expect(keychain.save).not.toHaveBeenCalled();
    expect(bindings.write).not.toHaveBeenCalled();
  });

  it('uses another authorized account when the verified default account lacks Pages access', async () => {
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => personal,
        verifyPermissions: async (_token, input) => input.accountId === work.id,
        listAccounts: async () => [personal, work],
      },
      keychain,
    }));

    await expect(service.connectApiToken('multi-account-token')).resolves.toEqual({
      state: 'connected',
      method: 'api-token',
      account: work,
    });
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'multi-account-token',
    );
  });

  it('lists authorized accounts and persists only the selected account ID and nonsecret status', async () => {
    let savedSecret = 'oauth-access-secret';
    let persisted: unknown;
    const verifyPermissions = vi.fn(async (_token: string, input: { accountId?: string }) => input.accountId === work.id);
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => personal,
        verifyPermissions,
        listAccounts: async () => [personal, work],
      },
      keychain: {
        save: async (_service, secret) => { savedSecret = secret; },
        read: async () => savedSecret,
        remove: async () => { savedSecret = ''; },
      },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: work }),
        write: async (status) => { persisted = status; },
      },
    }));

    await expect(service.listAvailableAccounts()).resolves.toEqual([work]);
    await expect(service.selectAccount(work.id)).resolves.toEqual({
      state: 'connected',
      method: 'oauth',
      account: work,
    });
    expect(verifyPermissions).toHaveBeenLastCalledWith('oauth-access-secret', {
      accountId: work.id,
      capabilities: CLOUD_FLARE_PAGES_CAPABILITIES,
    });
    expect(JSON.stringify(persisted)).not.toContain('oauth-access-secret');
  });

  it('reports an expired Keychain credential without returning its secret or calling the remote API', async () => {
    const verify = vi.fn();
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify,
        verifyPermissions: async () => true,
        listAccounts: async () => [personal],
      },
      keychain: {
        save: vi.fn(),
        read: async () => undefined,
        remove: vi.fn(),
      },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: vi.fn(),
      },
    }));

    const status = await service.refreshStatus();

    expect(status).toEqual({ state: 'expired', method: 'oauth', account: personal });
    expect(verify).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain('oauth-access-secret');
  });

  it('keeps a non-default selected account connected when it still has Pages access', async () => {
    const write = vi.fn(async () => undefined);
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => personal,
        verifyPermissions: async () => true,
        listAccounts: async () => [personal, work],
      },
      keychain: { save: vi.fn(), read: async () => 'replacement-token', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: work }),
        write,
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'connected',
      method: 'oauth',
      account: work,
    });
    await expect(service.getPublishingConnection()).resolves.toEqual({
      account: work,
      credential: 'replacement-token',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('requires recovery when the selected account loses Pages access after an app restart', async () => {
    const listAccounts = vi.fn(async () => [personal, work]);
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => personal,
        verifyPermissions: async (_token, input) => input.accountId === work.id,
        listAccounts,
      },
      keychain: { save: vi.fn(), read: async () => 'replacement-token', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.listAvailableAccounts()).rejects.toMatchObject({
      code: 'credential-recovery-required',
    });
    expect(listAccounts).toHaveBeenCalledOnce();
  });

  it('marks the connection expired when account listing reports an expired credential', async () => {
    const write = vi.fn(async () => undefined);
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => personal,
        verifyPermissions: async () => true,
        listAccounts: async () => { throw new CloudflareCredentialExpiredError(); },
      },
      keychain: { save: vi.fn(), read: async () => 'expired-token', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write,
      },
    }));

    await expect(service.listAvailableAccounts()).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
    expect(write).toHaveBeenCalledWith({ state: 'expired', method: 'oauth', account: personal });
  });

  it('serializes credential changes so the final binding and Keychain credential agree', async () => {
    const savedSecrets = new Map<string, string>();
    let persisted: unknown;
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let unblockFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      unblockFirstWrite = resolve;
    });
    let writeCount = 0;
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async (token) => ({ id: token, name: token }),
        verifyPermissions: async () => true,
        listAccounts: async (token) => [{ id: token, name: token }],
      },
      keychain: {
        save: async (service, secret) => { savedSecrets.set(service, secret); },
        read: async (service) => savedSecrets.get(service),
        remove: async (service) => { savedSecrets.delete(service); },
      },
      bindings: {
        read: async () => undefined,
        write: async (status) => {
          writeCount += 1;
          if (writeCount === 1) {
            releaseFirstWrite?.();
            await firstWriteBlocked;
          }
          persisted = status;
        },
      },
    }));

    const first = service.connectApiToken('first-token');
    await firstWriteStarted;
    const second = service.connectApiToken('second-token');
    unblockFirstWrite?.();
    await Promise.all([first, second]);

    expect(savedSecrets.get('pages-publish.cloudflare')).toBe('second-token');
    expect(persisted).toEqual({
      state: 'connected',
      method: 'api-token',
      account: { id: 'second-token', name: 'second-token' },
    });
  });

  it('restores the previous credential if disconnect cannot persist its disconnected binding', async () => {
    let savedSecret: string | undefined = 'previous-token';
    let persisted: unknown;
    let writeCount = 0;
    const service = new CloudflareConnectionService(makeDependencies({
      keychain: {
        save: async (_service, secret) => { savedSecret = secret; },
        read: async () => savedSecret,
        remove: async () => { savedSecret = undefined; },
      },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: async (status) => {
          writeCount += 1;
          if (writeCount === 1) throw new Error('binding contained previous-token');
          persisted = status;
        },
      },
    }));

    await expect(service.disconnect()).rejects.toMatchObject({ code: 'binding-write-failed' });
    expect(savedSecret).toBe('previous-token');
    expect(persisted).toEqual({ state: 'connected', method: 'oauth', account: personal });
  });

  it('restores both prior local records when saving a new connection binding fails', async () => {
    let savedSecret: string | undefined = 'previous-token';
    let persisted: unknown;
    let writeCount = 0;
    const previous = { state: 'connected' as const, method: 'oauth' as const, account: personal };
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => work,
        verifyPermissions: async () => true,
        listAccounts: async () => [work],
      },
      keychain: {
        save: async (_service, secret) => { savedSecret = secret; },
        read: async () => savedSecret,
        remove: async () => { savedSecret = undefined; },
      },
      bindings: {
        read: async () => previous,
        write: async (status) => {
          writeCount += 1;
          if (writeCount === 1) throw new Error('binding contained new-token');
          persisted = status;
        },
      },
    }));

    await expect(service.connectApiToken('new-token')).rejects.toMatchObject({
      code: 'binding-write-failed',
    });
    expect(savedSecret).toBe('previous-token');
    expect(persisted).toEqual(previous);
  });

  it('marks recovery required and prevents remote actions if credential rollback fails', async () => {
    let savedSecret: string | undefined = 'previous-token';
    let persisted: unknown;
    let writeCount = 0;
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => work,
        verifyPermissions: async () => true,
        listAccounts: async () => [work],
      },
      keychain: {
        save: async (_service, secret) => {
          if (secret === 'previous-token') throw new Error('restore previous-token failed');
          savedSecret = secret;
        },
        read: async () => savedSecret,
        remove: async () => { savedSecret = undefined; },
      },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: async (status) => {
          writeCount += 1;
          if (writeCount === 1) throw new Error('binding write failed');
          persisted = status;
        },
      },
    }));

    await expect(service.connectApiToken('new-token')).rejects.toMatchObject({
      code: 'credential-recovery-required',
    });
    await expect(service.listAvailableAccounts()).rejects.toMatchObject({
      code: 'credential-recovery-required',
    });
    expect(persisted).toEqual({ state: 'expired', method: 'oauth', account: personal });
  });

  it('redacts adapter errors that contain credentials', async () => {
    const secret = 'api-token-secret';
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => {
          throw new CloudflareConnectionError(
            'oauth-exchange-failed',
            `Authorization: Bearer ${secret}`,
          );
        },
        verifyPermissions: async () => true,
        listAccounts: async () => [personal],
      },
    }));

    const error = await service.connectApiToken(secret).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CloudflareConnectionError);
    expect(error).toMatchObject({ code: 'api-account-verification-failed' });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('refreshes a stored OAuth connection through memberships and Pages without API Token verification', async () => {
    const verify = vi.fn(async () => {
      throw new Error('API Token verification must not receive an OAuth credential');
    });
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify,
        verifyPermissions: async () => true,
        listAccounts: async () => [personal],
      },
      keychain: { save: vi.fn(), read: async () => 'oauth-access-secret', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'connected',
      method: 'oauth',
      account: personal,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('treats a rejected stored credential as expired without exposing it', async () => {
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => { throw new CloudflareCredentialExpiredError(); },
        verifyPermissions: async () => true,
        listAccounts: async () => [personal],
      },
      keychain: { save: vi.fn(), read: async () => 'expired-token-secret', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'api-token', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'expired',
      method: 'api-token',
      account: personal,
    });
  });

  it('provides a verified Keychain credential only to the active Pages host boundary', async () => {
    const service = new CloudflareConnectionService(makeDependencies({
      keychain: { save: vi.fn(), read: async () => 'stored-token-secret', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'api-token', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.getPublishingConnection()).resolves.toEqual({
      account: personal,
      credential: 'stored-token-secret',
    });
  });
});
