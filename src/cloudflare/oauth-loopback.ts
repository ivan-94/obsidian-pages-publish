import { createServer, type Server } from 'node:http';
import { parseCloudflareOAuthCallback } from './oauth-callback';
import { CloudflareOAuthCallbackFailure } from './oauth-callback-failure';

/**
 * This exact URL must be registered on the Cloudflare OAuth client. A numeric
 * loopback address keeps the authorization code off the network while meeting
 * Cloudflare's HTTP(S) redirect rule.
 */
export const CLOUDFLARE_OAUTH_LOOPBACK_REDIRECT_URI =
  'http://127.0.0.1:47931/oauth/callback';

export interface CloudflareOAuthLoopbackTimerBoundary {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export type CloudflareOAuthCancellationReason = 'denied' | 'invalid_scope';

export class CloudflareOAuthLoopbackServer {
  private readonly callback: (input: { state: string; code: string }) => Promise<void>;
  private readonly onCancellation: ((input: {
    state: string;
    reason: CloudflareOAuthCancellationReason;
  }) => Promise<boolean>) | undefined;
  private readonly onTimeout: (() => Promise<void>) | undefined;
  private readonly timeoutMs: number;
  private readonly timers: CloudflareOAuthLoopbackTimerBoundary;
  private readonly redirect: URL;
  private server: Server | undefined;
  private starting: Promise<{ redirectUri: string }> | undefined;
  private callbackConsumed = false;
  private timeout: number | undefined;
  private timeoutGeneration = 0;

  constructor(input: {
    redirectUri: string;
    callback: (input: { state: string; code: string }) => Promise<void>;
    onCancellation?: (input: {
      state: string;
      reason: CloudflareOAuthCancellationReason;
    }) => Promise<boolean>;
    onTimeout?: () => Promise<void>;
    timeoutMs?: number;
    timers?: CloudflareOAuthLoopbackTimerBoundary;
  }) {
    this.redirect = loopbackRedirectUri(input.redirectUri);
    this.callback = input.callback;
    this.onCancellation = input.onCancellation;
    this.onTimeout = input.onTimeout;
    this.timeoutMs = input.timeoutMs ?? 5 * 60_000;
    this.timers = input.timers ?? {
      set: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clear: (handle) => window.clearTimeout(handle),
    };
  }

  start(): Promise<{ redirectUri: string }> {
    if (this.server) {
      this.armTimeout();
      return Promise.resolve({ redirectUri: this.redirect.toString() });
    }
    if (this.starting) return this.starting;
    const server = createServer((request, response) => {
      void this.handleRequest(request.method, request.url, response);
    });
    this.starting = new Promise<{ redirectUri: string }>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.starting = undefined;
        reject(new Error(`Could not listen for the Cloudflare OAuth callback: ${error.message}`));
      };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        this.callbackConsumed = false;
        this.armTimeout();
        this.starting = undefined;
        resolve({ redirectUri: this.redirect.toString() });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(Number(this.redirect.port), this.redirect.hostname);
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.callbackConsumed = false;
    this.clearTimeout();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handleRequest(
    method: string | undefined,
    requestUrl: string | undefined,
    response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
  ): Promise<void> {
    if (method !== 'GET') {
      this.respond(response, 405, 'Method not allowed.');
      return;
    }
    const callbackUrl = new URL(requestUrl ?? '/', this.redirect.origin);
    if (callbackUrl.pathname !== this.redirect.pathname) {
      this.respond(response, 404, 'Not found.');
      return;
    }
    if (this.callbackConsumed) {
      this.respond(response, 409, 'This authorization callback has already been used.');
      return;
    }
    if (callbackUrl.searchParams.has('error')) {
      const state = callbackUrl.searchParams.get('state');
      const reason = cancellationReason(callbackUrl.searchParams.get('error'));
      const cancelled = state === null
        ? false
        : await this.onCancellation?.({ state, reason }) ?? false;
      this.respond(response, 400, browserCancellationMessage(reason));
      if (cancelled) await this.stop().catch(() => undefined);
      return;
    }
    let callback: { state: string; code: string };
    try {
      callback = parseCloudflareOAuthCallback(queryParameters(callbackUrl));
    } catch {
      this.respond(response, 400, 'Cloudflare authorization could not be completed. Return to Obsidian and try again.');
      return;
    }
    try {
      await this.callback(callback);
    } catch (error) {
      this.respond(
        response,
        400,
        error instanceof CloudflareOAuthCallbackFailure
          ? error.browserMessage
          : 'Cloudflare authorization could not be completed. Return to Obsidian and try again.',
      );
      return;
    }
    this.callbackConsumed = true;
    this.respond(response, 200, 'Cloudflare authorization complete. You can return to Obsidian.');
    await this.stop().catch(() => undefined);
  }

  private respond(
    response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
    status: number,
    message: string,
  ): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.end(message);
  }

  private armTimeout(): void {
    this.clearTimeout();
    const generation = ++this.timeoutGeneration;
    this.timeout = this.timers.set(() => {
      if (generation !== this.timeoutGeneration) return;
      void this.expire(generation);
    }, this.timeoutMs);
  }

  private clearTimeout(): void {
    this.timeoutGeneration += 1;
    if (this.timeout === undefined) return;
    this.timers.clear(this.timeout);
    this.timeout = undefined;
  }

  private async expire(generation: number): Promise<void> {
    if (generation !== this.timeoutGeneration || !this.server) return;
    try {
      await this.onTimeout?.();
    } finally {
      if (generation === this.timeoutGeneration) {
        await this.stop().catch(() => undefined);
      }
    }
  }
}

function loopbackRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OAuth loopback redirect URI must use http://127.0.0.1.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1024
    || port > 65535
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error('OAuth loopback redirect URI must use http://127.0.0.1 with a local port.');
  }
  return url;
}

function queryParameters(url: URL): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (parameters[key] === undefined) parameters[key] = value;
  }
  return parameters;
}

function cancellationReason(error: string | null): CloudflareOAuthCancellationReason {
  return error === 'invalid_scope' ? 'invalid_scope' : 'denied';
}

function browserCancellationMessage(reason: CloudflareOAuthCancellationReason): string {
  return reason === 'invalid_scope'
    ? 'This Cloudflare OAuth client does not permit the required permissions. Return to Obsidian and update the client scopes before trying again.'
    : 'Cloudflare authorization was cancelled or denied. Return to Obsidian and try again.';
}
