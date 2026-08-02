import { describe, expect, it } from 'vitest';
import { parseCloudflareOAuthCallback } from '../src/cloudflare/oauth-callback';

describe('Cloudflare OAuth callback', () => {
  it('accepts only a callback carrying both the one-time state and authorization code', () => {
    expect(parseCloudflareOAuthCallback({
      action: 'pages-publish-oauth',
      state: 'one-time-state',
      code: 'authorization-code',
    })).toEqual({ state: 'one-time-state', code: 'authorization-code' });

    expect(() => parseCloudflareOAuthCallback({
      action: 'pages-publish-oauth',
      state: 'one-time-state',
    })).toThrow('Cloudflare authorization did not return a valid callback');
  });
});
