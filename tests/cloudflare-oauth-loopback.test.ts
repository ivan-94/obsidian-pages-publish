import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareOAuthLoopbackServer,
} from '../src/cloudflare/oauth-loopback';
import { CloudflareOAuthCallbackFailure } from '../src/cloudflare/oauth-callback-failure';

describe('Cloudflare OAuth loopback callback', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the registered HTTP callback once and never exposes its code in the browser response', async () => {
    const callback = vi.fn(async () => undefined);
    const redirectUri = 'http://127.0.0.1:18976/oauth/callback';
    const server = new CloudflareOAuthLoopbackServer({ redirectUri, callback });
    await expect(server.start()).resolves.toEqual({ redirectUri });

    const response = await get(`${redirectUri}?state=one-time-state&code=authorization-code`);

    expect(response.status).toBe(200);
    expect(response.body).toContain('Cloudflare authorization complete');
    expect(response.body).not.toContain('authorization-code');
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith({
        state: 'one-time-state',
        code: 'authorization-code',
      });
    });

    await expect(get(`${redirectUri}?state=replayed&code=code`)).rejects.toThrow();
  });

  it('rejects another protocol, callback path, or callback payload', async () => {
    expect(() => new CloudflareOAuthLoopbackServer({
      redirectUri: 'https://example.com/oauth/callback',
      callback: async () => undefined,
    })).toThrow('OAuth loopback redirect URI must use http://127.0.0.1');

    const callback = vi.fn(async () => undefined);
    const redirectUri = 'http://127.0.0.1:18977/oauth/callback';
    const server = new CloudflareOAuthLoopbackServer({ redirectUri, callback });
    await server.start();

    await expect(get('http://127.0.0.1:18977/not-the-callback')).resolves.toMatchObject({
      status: 404,
    });
    await expect(get(`${redirectUri}?state=one-time-state`)).resolves.toMatchObject({
      status: 400,
    });
    expect(callback).not.toHaveBeenCalled();
    await server.stop();
  });

  it('leaves the listener available when a stale callback is rejected so the newest authorization can finish', async () => {
    const redirectUri = 'http://127.0.0.1:18978/oauth/callback';
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async ({ state }) => {
        if (state !== 'newest-state') throw new Error('stale OAuth state');
      },
    });
    await server.start();

    await expect(get(`${redirectUri}?state=stale-state&code=stale-code`)).resolves.toMatchObject({
      status: 400,
    });
    await expect(get(`${redirectUri}?state=newest-state&code=newest-code`)).resolves.toMatchObject({
      status: 200,
    });
  });

  it('returns a safe, actionable callback failure without exposing an OAuth code', async () => {
    const redirectUri = 'http://127.0.0.1:18984/oauth/callback';
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async () => {
        throw new CloudflareOAuthCallbackFailure(
          'Cloudflare 未接受本次授权码。请在 Obsidian 中重新开始授权。',
        );
      },
    });
    await server.start();

    const response = await get(`${redirectUri}?state=one-time-state&code=authorization-code`);

    expect(response).toMatchObject({ status: 400 });
    expect(response.body).toContain('Cloudflare 未接受本次授权码');
    expect(response.body).not.toContain('authorization-code');
    await server.stop();
  });

  it('cancels the matching pending authorization when Cloudflare returns an OAuth error', async () => {
    const redirectUri = 'http://127.0.0.1:18979/oauth/callback';
    const onCancellation = vi.fn(async ({ state }: { state: string }) => state === 'current-state');
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async () => undefined,
      onCancellation,
    });
    await server.start();

    await expect(get(`${redirectUri}?error=access_denied&state=current-state`)).resolves.toMatchObject({
      status: 400,
    });
    expect(onCancellation).toHaveBeenCalledWith({
      state: 'current-state',
      reason: 'denied',
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(get(`${redirectUri}?state=current-state&code=late-code`)).rejects.toThrow();
  });

  it('expires an abandoned browser authorization and releases the loopback listener', async () => {
    const redirectUri = 'http://127.0.0.1:18980/oauth/callback';
    const onTimeout = vi.fn(async () => undefined);
    let expire: (() => void) | undefined;
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async () => undefined,
      onTimeout,
      timeoutMs: 60_000,
      timers: {
        set: (callback) => {
          expire = callback;
          return 1;
        },
        clear: () => undefined,
      },
    });
    await server.start();

    expire?.();
    await vi.waitFor(() => {
      expect(onTimeout).toHaveBeenCalledOnce();
    });
    await expect(get(`${redirectUri}?state=late&code=late`)).rejects.toThrow();
  });

  it('identifies a client scope rejection without reflecting Cloudflare error text', async () => {
    const redirectUri = 'http://127.0.0.1:18981/oauth/callback';
    const onCancellation = vi.fn(async (input: { state: string; reason: string }) =>
      input.state === 'current-state' && input.reason === 'invalid_scope',
    );
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async () => undefined,
      onCancellation,
    });
    await server.start();

    const response = await get(
      `${redirectUri}?error=invalid_scope&error_description=untrusted-detail&state=current-state`,
    );

    expect(response).toMatchObject({ status: 400 });
    expect(response.body).toContain('does not permit the required permissions');
    expect(response.body).not.toContain('untrusted-detail');
    expect(onCancellation).toHaveBeenCalledWith({
      state: 'current-state',
      reason: 'invalid_scope',
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(get(`${redirectUri}?state=current-state&code=late-code`)).rejects.toThrow();
  });

  it('identifies a lost Cloudflare browser session without reflecting provider error text', async () => {
    const redirectUri = 'http://127.0.0.1:18985/oauth/callback';
    const onCancellation = vi.fn(async (input: { state: string; reason: string }) =>
      input.state === 'current-state' && input.reason === 'session_unavailable',
    );
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback: async () => undefined,
      onCancellation,
    });
    await server.start();

    const response = await get(
      `${redirectUri}?error=request_forbidden&error_description=No+CSRF+value+available+in+the+session+cookie.&state=current-state`,
    );

    expect(response).toMatchObject({ status: 400 });
    expect(response.body).toContain('browser session was lost');
    expect(response.body).not.toContain('No CSRF value');
    expect(onCancellation).toHaveBeenCalledWith({
      state: 'current-state',
      reason: 'session_unavailable',
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(get(`${redirectUri}?state=current-state&code=late-code`)).rejects.toThrow();
  });

  it('ignores a stale timeout after a new OAuth attempt rearms the listener', async () => {
    const redirectUri = 'http://127.0.0.1:18982/oauth/callback';
    const callbacks: Array<() => void> = [];
    const onTimeout = vi.fn(async () => undefined);
    const callback = vi.fn(async () => undefined);
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback,
      onTimeout,
      timers: {
        set: (operation) => {
          callbacks.push(operation);
          return callbacks.length;
        },
        clear: () => undefined,
      },
    });
    await server.start();
    await server.start();

    callbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onTimeout).not.toHaveBeenCalled();
    await expect(get(`${redirectUri}?state=current-state&code=current-code`)).resolves.toMatchObject({
      status: 200,
    });
    expect(callback).toHaveBeenCalledWith({ state: 'current-state', code: 'current-code' });
  });

  it('does not stop a retry that begins while an old timeout is finishing', async () => {
    const redirectUri = 'http://127.0.0.1:18983/oauth/callback';
    const callbacks: Array<() => void> = [];
    let finishTimeout!: () => void;
    const onTimeout = vi.fn(() => new Promise<void>((resolve) => {
      finishTimeout = resolve;
    }));
    const callback = vi.fn(async () => undefined);
    const server = new CloudflareOAuthLoopbackServer({
      redirectUri,
      callback,
      onTimeout,
      timers: {
        set: (operation) => {
          callbacks.push(operation);
          return callbacks.length;
        },
        clear: () => undefined,
      },
    });
    await server.start();

    callbacks[0]?.();
    await vi.waitFor(() => {
      expect(onTimeout).toHaveBeenCalledOnce();
    });
    await server.start();
    finishTimeout();
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(get(`${redirectUri}?state=current-state&code=current-code`)).resolves.toMatchObject({
      status: 200,
    });
    expect(callback).toHaveBeenCalledWith({ state: 'current-state', code: 'current-code' });
  });
});

async function get(url: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const operation = request(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    operation.once('error', reject);
    operation.end();
  });
}
