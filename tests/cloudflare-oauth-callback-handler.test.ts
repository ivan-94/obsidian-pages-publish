import { describe, expect, it, vi } from 'vitest';
import { CloudflareConnectionError } from '../src/cloudflare/connection';
import { CloudflareOAuthCallbackFailure } from '../src/cloudflare/oauth-callback-failure';
import { completeCloudflareOAuthCallback } from '../src/cloudflare/oauth-callback-handler';

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
});
