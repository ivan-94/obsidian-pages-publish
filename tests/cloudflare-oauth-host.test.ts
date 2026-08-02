import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareDesktopOAuth,
  type CloudflareOAuthRequestBoundary,
} from '../src/cloudflare/oauth-host';

type OAuthRequest = Parameters<CloudflareOAuthRequestBoundary['request']>[0];

describe('Cloudflare desktop OAuth host', () => {
  it('builds an authorization-code PKCE request without a client secret', async () => {
    const request = vi.fn<CloudflareOAuthRequestBoundary['request']>();
    const oauth = new CloudflareDesktopOAuth({
      clientId: 'public-client-id',
      redirectUri: 'http://127.0.0.1:8976/oauth/callback',
      request,
    });

    const result = await oauth.begin({
      scopes: ['memberships.read', 'page.read', 'page.write'],
      state: 'one-time-state',
      codeChallenge: 's256-challenge',
      codeChallengeMethod: 'S256',
    });

    const url = new URL(result.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'public-client-id',
      code_challenge: 's256-challenge',
      code_challenge_method: 'S256',
      redirect_uri: 'http://127.0.0.1:8976/oauth/callback',
      response_type: 'code',
      scope: 'memberships.read page.read page.write',
      state: 'one-time-state',
    });
    expect(result.authorizationUrl).not.toContain('client_secret');
    expect(request).not.toHaveBeenCalled();
  });

  it('exchanges the callback code with the PKCE verifier as a public client', async () => {
    const request = vi.fn(async (_input: OAuthRequest) => ({
      status: 200,
      json: { access_token: 'oauth-access-token', token_type: 'bearer' },
    }));
    const oauth = new CloudflareDesktopOAuth({
      clientId: 'public-client-id',
      redirectUri: 'http://127.0.0.1:8976/oauth/callback',
      request,
    });

    await expect(oauth.exchange({
      code: 'authorization-code',
      codeVerifier: 'one-time-verifier',
    })).resolves.toEqual({ accessToken: 'oauth-access-token' });

    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      url: 'https://dash.cloudflare.com/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toEqual({
      client_id: 'public-client-id',
      code: 'authorization-code',
      code_verifier: 'one-time-verifier',
      grant_type: 'authorization_code',
      redirect_uri: 'http://127.0.0.1:8976/oauth/callback',
    });
    expect(call?.body).not.toContain('client_secret');
  });

  it('uses the loopback URL selected for this authorization in both legs of the OAuth flow', async () => {
    const request = vi.fn(async (_input: OAuthRequest) => ({
      status: 200,
      json: { access_token: 'oauth-access-token' },
    }));
    const oauth = new CloudflareDesktopOAuth({
      clientId: 'public-client-id',
      redirectUri: 'http://127.0.0.1:8976/oauth/callback',
      request,
    });
    const redirectUri = 'http://127.0.0.1:8977/oauth/callback';

    const authorization = await oauth.begin({
      scopes: ['memberships.read'],
      state: 'one-time-state',
      codeChallenge: 's256-challenge',
      codeChallengeMethod: 'S256',
      redirectUri,
    });
    await oauth.exchange({
      code: 'authorization-code',
      codeVerifier: 'one-time-verifier',
      redirectUri,
    });

    expect(new URL(authorization.authorizationUrl).searchParams.get('redirect_uri')).toBe(redirectUri);
    const tokenRequest = request.mock.calls[0]?.[0];
    expect(new URLSearchParams(tokenRequest?.body).get('redirect_uri')).toBe(redirectUri);
  });

  it('refuses non-HTTP callback schemes because Cloudflare only accepts web redirect URLs', () => {
    expect(() => new CloudflareDesktopOAuth({
      clientId: 'public-client-id',
      redirectUri: 'obsidian://pages-publish-oauth',
      request: vi.fn(),
    })).toThrow('OAuth redirect URI must start with http:// or https://.');
  });
});
