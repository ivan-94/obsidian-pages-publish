declare const __PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID__: string | undefined;
import { CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI } from './oauth-loopback';

export interface CloudflareOAuthBuildConfig {
  clientId: string;
  redirectUri: string;
}

/** Build-time public-client metadata. No client secret is accepted or bundled. */
export function cloudflareOAuthBuildConfig(): CloudflareOAuthBuildConfig | undefined {
  return resolveCloudflareOAuthBuildConfig({
    clientId: typeof __PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID__ === 'string'
      ? __PAGES_PUBLISH_CLOUDFLARE_OAUTH_CLIENT_ID__
      : '',
  });
}

export function resolveCloudflareOAuthBuildConfig(input: {
  clientId: string;
  redirectUri?: string;
}): CloudflareOAuthBuildConfig | undefined {
  const clientId = input.clientId.trim();
  if (clientId.length === 0) return undefined;
  return {
    clientId,
    redirectUri: CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI,
  };
}
