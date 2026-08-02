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
    input.notify('Cloudflare 授权未完成或回调无效，请重新开始授权。');
    throw error;
  }
  input.notify(`Cloudflare 已连接：${connection.account.name}`);
  void input.openPublishCenter().catch(() => {
    input.notify('Cloudflare 已连接，但无法自动打开发布中心。');
  });
}
