import { describe, expect, it } from 'vitest';
import {
  resolveCloudflareOAuthBuildConfig,
} from '../src/cloudflare/oauth-build-config';
import {
  CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI,
} from '../src/cloudflare/oauth-loopback';

describe('Cloudflare OAuth build configuration', () => {
  it('uses the registered cold loopback URL when a public client ID is present', () => {
    expect(resolveCloudflareOAuthBuildConfig({ clientId: 'public-client-id' })).toEqual({
      clientId: 'public-client-id',
      redirectUri: CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI,
    });
  });

  it('never permits an alternate callback because the OAuth client registers one exact local URL', () => {
    expect(resolveCloudflareOAuthBuildConfig({
      clientId: 'public-client-id',
      redirectUri: 'http://127.0.0.1:9444/oauth/callback',
    })).toEqual({
      clientId: 'public-client-id',
      redirectUri: CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI,
    });
  });

  it('does not make OAuth available without a public client ID', () => {
    expect(resolveCloudflareOAuthBuildConfig({ clientId: '  ' })).toBeUndefined();
  });

});
