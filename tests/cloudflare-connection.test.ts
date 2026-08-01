import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareConnectionService,
  CLOUD_FLARE_PAGES_SCOPES,
  CloudflareCredentialExpiredError,
} from '../src/cloudflare/connection';

describe('Cloudflare connection service', () => {
  it('uses the minimum OAuth Pages scopes and stores an authorized credential only in Keychain', async () => {
    const beginOAuth = vi.fn(async () => ({
      authorizationUrl: 'https://dash.cloudflare.com/oauth/authorize?state=state-1',
      state: 'state-1',
    }));
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService({
      oauth: {
        begin: beginOAuth,
        exchange: async () => ({ accessToken: 'oauth-access-secret' }),
      },
      api: { verify: async () => ({ id: 'account-1', name: 'Personal account' }) },
      keychain,
      bindings: { read: async () => undefined, write: async () => undefined },
    });

    const authorization = await service.beginOAuth();
    const status = await service.completeOAuth({ state: 'state-1', code: 'code-secret' });

    expect(authorization.url).toContain('https://dash.cloudflare.com/oauth/authorize');
    expect(beginOAuth).toHaveBeenCalledWith({ scopes: CLOUD_FLARE_PAGES_SCOPES });
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'oauth-access-secret',
    );
    expect(status).toEqual({
      state: 'connected',
      method: 'oauth',
      account: { id: 'account-1', name: 'Personal account' },
    });
    expect(JSON.stringify(status)).not.toContain('oauth-access-secret');
  });

  it('validates an advanced API Token before persisting it in Keychain', async () => {
    const verify = vi.fn(async () => ({ id: 'account-2', name: 'Work account' }));
    const keychain = { save: vi.fn(async () => undefined), read: vi.fn(), remove: vi.fn() };
    const service = new CloudflareConnectionService({
      oauth: { begin: vi.fn(), exchange: vi.fn() },
      api: { verify },
      keychain,
      bindings: { read: async () => undefined, write: async () => undefined },
    });

    await expect(service.connectApiToken('advanced-token-secret')).resolves.toEqual({
      state: 'connected',
      method: 'api-token',
      account: { id: 'account-2', name: 'Work account' },
    });
    expect(verify).toHaveBeenCalledWith('advanced-token-secret');
    expect(keychain.save).toHaveBeenCalledWith(
      'pages-publish.cloudflare',
      'advanced-token-secret',
    );
  });

  it('rejects a mismatched OAuth callback before exchanging its authorization code', async () => {
    const exchange = vi.fn();
    const service = new CloudflareConnectionService({
      oauth: {
        begin: async () => ({ authorizationUrl: 'https://example.test', state: 'expected' }),
        exchange,
      },
      api: { verify: vi.fn() },
      keychain: { save: vi.fn(), read: vi.fn(), remove: vi.fn() },
      bindings: { read: async () => undefined, write: async () => undefined },
    });

    await service.beginOAuth();

    await expect(
      service.completeOAuth({ state: 'attacker-state', code: 'attacker-code' }),
    ).rejects.toThrow('OAuth callback could not be verified');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('reports an expired Keychain credential without returning its secret', async () => {
    const service = new CloudflareConnectionService({
      oauth: { begin: vi.fn(), exchange: vi.fn() },
      api: {
        verify: async () => {
          throw new CloudflareCredentialExpiredError();
        },
      },
      keychain: {
        save: vi.fn(),
        read: async () => 'expired-token-secret',
        remove: vi.fn(),
      },
      bindings: {
        read: async () => ({
          state: 'connected',
          method: 'oauth',
          account: { id: 'account-1', name: 'Personal account' },
        }),
        write: vi.fn(),
      },
    });

    const status = await service.refreshStatus();

    expect(status).toEqual({
      state: 'expired',
      method: 'oauth',
      account: { id: 'account-1', name: 'Personal account' },
    });
    expect(JSON.stringify(status)).not.toContain('expired-token-secret');
  });

  it('disconnects by removing the Keychain credential and only retaining a disconnected binding', async () => {
    const remove = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    const service = new CloudflareConnectionService({
      oauth: { begin: vi.fn(), exchange: vi.fn() },
      api: { verify: vi.fn() },
      keychain: { save: vi.fn(), read: vi.fn(), remove },
      bindings: { read: async () => undefined, write },
    });

    await expect(service.disconnect()).resolves.toEqual({ state: 'disconnected' });
    expect(remove).toHaveBeenCalledWith('pages-publish.cloudflare');
    expect(write).toHaveBeenCalledWith({ state: 'disconnected' });
  });
});
