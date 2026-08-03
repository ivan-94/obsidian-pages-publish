import { CloudflareConnectionError } from './connection';
import { CloudflareOAuthCallbackFailure } from './oauth-callback-failure';

export interface CloudflareOAuthCallbackApplication {
  completeInitialSetupOAuth(input: { state: string; code: string }): Promise<{
    state: 'disconnected' | 'connected' | 'expired' | 'unavailable';
    account?: { id: string; name: string };
  }>;
}

/** Completes OAuth before performing best-effort UI navigation. */
export async function completeCloudflareOAuthCallback(input: {
  callback: { state: string; code: string };
  application: CloudflareOAuthCallbackApplication;
  notify(message: string): void;
  openPublishCenter(): Promise<void>;
}): Promise<void> {
  let connection: { state: 'disconnected' | 'connected' | 'expired' | 'unavailable'; account?: { id: string; name: string } };
  try {
    connection = await input.application.completeInitialSetupOAuth(input.callback);
    if (connection.state !== 'connected' || !connection.account) {
      throw new Error('Cloudflare did not return a connected Pages account.');
    }
  } catch (error) {
    const message = callbackFailureMessage(error);
    input.notify(message);
    throw new CloudflareOAuthCallbackFailure(message);
  }
  input.notify(`Cloudflare 已连接：${connection.account.name}`);
  void input.openPublishCenter().catch(() => {
    input.notify('Cloudflare 已连接，但无法自动打开发布中心。');
  });
}

function callbackFailureMessage(error: unknown): string {
  if (error instanceof CloudflareConnectionError) {
    if (error.code === 'oauth-callback-invalid') {
      return 'Cloudflare 授权回调已过期或被新的授权请求取代，请在 Obsidian 中重新开始授权。';
    }
    if (error.code === 'oauth-exchange-failed') {
      if (error.oauthReason === 'invalid_grant') {
        return 'Cloudflare 拒绝了本次授权事务（invalid_grant）。授权码可能已过期、已使用，或与本次 PKCE/回调不匹配；请从 Obsidian 重新开始一次全新授权。';
      }
      if (error.oauthReason) {
        return `Cloudflare token endpoint 拒绝了授权（${error.oauthReason}）。请检查 OAuth client 配置后，从 Obsidian 重新开始授权。`;
      }
      return 'Cloudflare 未接受本次授权码。请在 Obsidian 中重新开始授权；若仍失败，请检查 OAuth client 的授权码与回调地址配置。';
    }
    if (error.code === 'oauth-refresh-unavailable') {
      return 'Cloudflare 已授权，但未签发可自动续期的凭据。请确认 OAuth client 已启用 refresh_token grant，然后重新授权。';
    }
    if (error.code === 'credential-storage-failed' || error.code === 'binding-write-failed') {
      return 'Cloudflare 已完成授权，但 Obsidian 无法安全保存凭据。请检查本地 SecretStorage 后重试。';
    }
  }
  return 'Cloudflare 授权未完成或回调无效，请重新开始授权。';
}
