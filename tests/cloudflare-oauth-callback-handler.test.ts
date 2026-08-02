import { describe, expect, it, vi } from 'vitest';
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
});
