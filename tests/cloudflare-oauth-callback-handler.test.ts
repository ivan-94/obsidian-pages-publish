import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareConnectionError,
  CloudflareConnectionService,
} from '../src/cloudflare/connection';
import { CloudflareOAuthCallbackFailure } from '../src/cloudflare/oauth-callback-failure';
import { completeCloudflareOAuthCallback } from '../src/cloudflare/oauth-callback-handler';
import { CloudflareDesktopOAuth } from '../src/cloudflare/oauth-host';

describe('Cloudflare OAuth callback completion', () => {
  it('keeps a verified credential successful when opening the publish center later fails', async () => {
    const notify = vi.fn();
    const openPublishCenter = vi.fn(async () => {
      throw new Error('workspace navigation failed');
    });

    await expect(completeCloudflareOAuthCallback({
      callback: { state: 'one-time-state', code: 'authorization-code' },
      application: {
        completeInitialSetupOAuth: async () => ({
          state: 'connected',
          account: { id: 'account-1', name: 'Personal' },
        }),
      },
      notify,
      openPublishCenter,
    })).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith('Cloudflare 已连接：Personal');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith('Cloudflare 已连接，但无法自动打开发布中心。');
    });
  });

  it('turns a rejected authorization-code exchange into a safe, actionable callback failure', async () => {
    const notify = vi.fn();

    const error = await completeCloudflareOAuthCallback({
      callback: { state: 'one-time-state', code: 'authorization-code' },
      application: {
        completeInitialSetupOAuth: async () => {
          throw new CloudflareConnectionError(
            'oauth-exchange-failed',
            'Cloudflare authorization could not be completed. Start authorization again.',
          );
        },
      },
      notify,
      openPublishCenter: async () => undefined,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CloudflareOAuthCallbackFailure);
    expect(error).toMatchObject({
      browserMessage: 'Cloudflare 未接受本次授权码。请在 Obsidian 中重新开始授权；若仍失败，请检查 OAuth client 的授权码与回调地址配置。',
    });
    expect(notify).toHaveBeenCalledWith(
      'Cloudflare 未接受本次授权码。请在 Obsidian 中重新开始授权；若仍失败，请检查 OAuth client 的授权码与回调地址配置。',
    );
  });

  it('preserves a safe invalid_grant diagnosis across the real OAuth callback chain', async () => {
    const notify = vi.fn();
    const service = new CloudflareConnectionService({
      oauth: new CloudflareDesktopOAuth({
        clientId: 'public-client-id',
        redirectUri: 'http://127.0.0.1:47931/oauth/callback',
        request: async () => ({
          status: 400,
          json: {
            error: 'invalid_grant',
            error_description: 'authorization-code-secret and verifier-secret must never reach UI',
          },
        }),
      }),
      api: {
        verify: vi.fn(),
        verifyPermissions: vi.fn(),
        listAccounts: vi.fn(),
      },
      keychain: { save: vi.fn(), read: vi.fn(), remove: vi.fn() },
      bindings: { read: vi.fn(), write: vi.fn() },
    });
    const authorization = await service.beginOAuth({
      redirectUri: 'http://127.0.0.1:47931/oauth/callback',
    });
    const state = new URL(authorization.url).searchParams.get('state') ?? '';

    const error = await completeCloudflareOAuthCallback({
      callback: { state, code: 'authorization-code-secret' },
      application: {
        completeInitialSetupOAuth: (input) => service.completeOAuth(input),
      },
      notify,
      openPublishCenter: async () => undefined,
    }).catch((reason: unknown) => reason);

    const message = 'Cloudflare 拒绝了本次授权事务（invalid_grant）。授权码可能已过期、已使用，或与本次 PKCE/回调不匹配；请从 Obsidian 重新开始一次全新授权。';
    expect(error).toMatchObject({ browserMessage: message });
    expect(notify).toHaveBeenCalledWith(message);
    expect(JSON.stringify(error)).not.toContain('authorization-code-secret');
    expect(JSON.stringify(error)).not.toContain('verifier-secret');
  });

  it('explains when Cloudflare authorizes access without issuing a renewable credential', async () => {
    const notify = vi.fn();

    const error = await completeCloudflareOAuthCallback({
      callback: { state: 'one-time-state', code: 'authorization-code' },
      application: {
        completeInitialSetupOAuth: async () => {
          throw new CloudflareConnectionError(
            'oauth-refresh-unavailable',
            'refresh-token-secret must never reach the UI',
          );
        },
      },
      notify,
      openPublishCenter: async () => undefined,
    }).catch((reason: unknown) => reason);

    const message = 'Cloudflare 已授权，但未签发可自动续期的凭据。请确认 OAuth client 已启用 refresh_token grant，然后重新授权。';
    expect(error).toMatchObject({ browserMessage: message });
    expect(notify).toHaveBeenCalledWith(message);
    expect(JSON.stringify(error)).not.toContain('refresh-token-secret');
  });
});
