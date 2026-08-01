import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareConnectionError,
  CloudflareConnectionService,
  CloudflareCredentialExpiredError,
  CLOUD_FLARE_PAGES_CAPABILITIES,
  CLOUD_FLARE_PAGES_SCOPES,
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
    }> = [];
    const beginOAuth = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      return { authorizationUrl: 'https://dash.cloudflare.com/oauth/authorize' };
    });
    const exchanges: Array<{ code: string; codeVerifier: string }> = [];
    const exchange = vi.fn(async (input: (typeof exchanges)[number]) => {
      exchanges.push(input);
      return { accessToken: 'oauth-access-secret' };
    });
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService(makeDependencies({
      oauth: { begin: beginOAuth, exchange },
      keychain,
    }));

    const first = await service.beginOAuth();
    const firstRequest = requests[0];
    const second = await service.beginOAuth();
    const secondRequest = requests[1];

    expect(first.url).toContain('https://dash.cloudflare.com/oauth/authorize');
    expect(second.url).toContain('https://dash.cloudflare.com/oauth/authorize');
    expect(firstRequest).toMatchObject({
      scopes: CLOUD_FLARE_PAGES_SCOPES,
      codeChallengeMethod: 'S256',
    });
    expect(firstRequest?.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstRequest?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'oauth-access-secret',
    );
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
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
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

  it('treats a verified account that differs from the stored account as recovery-required', async () => {
    const write = vi.fn(async () => {
      throw new Error('binding storage is temporarily unavailable');
    });
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => work,
        verifyPermissions: async () => true,
        listAccounts: async () => [personal, work],
      },
      keychain: { save: vi.fn(), read: async () => 'replacement-token', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write,
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'expired',
      method: 'oauth',
      account: personal,
    });
    await expect(service.listAvailableAccounts()).rejects.toMatchObject({
      code: 'credential-recovery-required',
    });
    expect(write).toHaveBeenCalledWith({ state: 'expired', method: 'oauth', account: personal });
  });

  it('preflights the stored credential before listing accounts after an app restart', async () => {
    const listAccounts = vi.fn(async () => [personal, work]);
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => work,
        verifyPermissions: async () => true,
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
    expect(listAccounts).not.toHaveBeenCalled();
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
    let savedSecret: string | undefined;
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
        save: async (_service, secret) => { savedSecret = secret; },
        read: async () => savedSecret,
        remove: async () => { savedSecret = undefined; },
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

    expect(savedSecret).toBe('second-token');
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

  it('treats a rejected stored credential as expired without exposing it', async () => {
    const service = new CloudflareConnectionService(makeDependencies({
      api: {
        verify: async () => { throw new CloudflareCredentialExpiredError(); },
        verifyPermissions: async () => true,
        listAccounts: async () => [personal],
      },
      keychain: { save: vi.fn(), read: async () => 'expired-token-secret', remove: vi.fn() },
      bindings: {
        read: async () => ({ state: 'connected', method: 'oauth', account: personal }),
        write: vi.fn(),
      },
    }));

    await expect(service.refreshStatus()).resolves.toEqual({
      state: 'expired',
      method: 'oauth',
      account: personal,
    });
  });
});
