import type { CloudflareOAuthBoundary } from './connection';

export interface CloudflareOAuthRequestBoundary {
  request(input: {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status: number; json: unknown }>;
}

/** Public-client Authorization Code + PKCE adapter for the Cloudflare desktop flow. */
export class CloudflareDesktopOAuth implements CloudflareOAuthBoundary {
  readonly available = true;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly request: CloudflareOAuthRequestBoundary['request'];

  constructor(input: {
    clientId: string;
    redirectUri: string;
    request: CloudflareOAuthRequestBoundary['request'];
  }) {
    this.clientId = requiredValue(input.clientId, 'OAuth client id');
    this.redirectUri = validatedRedirectUri(input.redirectUri);
    this.request = input.request;
  }

  async begin(input: {
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
    redirectUri?: string;
  }): Promise<{ authorizationUrl: string }> {
    const url = new URL('https://dash.cloudflare.com/oauth2/auth');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUriFor(input.redirectUri));
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', input.codeChallengeMethod);
    return { authorizationUrl: url.toString() };
  }

  async exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
  }): Promise<{ accessToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUriFor(input.redirectUri),
      code: requiredValue(input.code, 'OAuth authorization code'),
      code_verifier: requiredValue(input.codeVerifier, 'OAuth PKCE verifier'),
    });
    const response = await this.request({
      url: 'https://dash.cloudflare.com/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const payload = objectValue(response.json);
    const accessToken = payload?.access_token;
    if (response.status !== 200 || typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Cloudflare OAuth token exchange failed.');
    }
    return { accessToken };
  }

  private redirectUriFor(value: string | undefined): string {
    return value === undefined ? this.redirectUri : validatedRedirectUri(value);
  }
}

function requiredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function validatedRedirectUri(value: string): string {
  const normalized = requiredValue(value, 'OAuth redirect URI');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('OAuth redirect URI is invalid.');
  }
  if (url.hash || url.username || url.password) {
    throw new Error('OAuth redirect URI contains unsupported components.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OAuth redirect URI must start with http:// or https://.');
  }
  return normalized;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
