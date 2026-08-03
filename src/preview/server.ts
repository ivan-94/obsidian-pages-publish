import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { PreviewAsset } from '../content/local-assets';

export interface PreviewSession {
  url: string;
}

export type PreviewServerStatus =
  | { state: 'stopped' }
  | { state: 'running'; url: string };

export class LocalPreviewServer {
  private server: Server | undefined;
  private startPromise: Promise<PreviewSession> | undefined;
  private sessionUrl: string | undefined;

  getStatus(): PreviewServerStatus {
    return this.sessionUrl
      ? { state: 'running', url: this.sessionUrl }
      : { state: 'stopped' };
  }

  async start(
    files: Readonly<Record<string, string>>,
    assets: Readonly<Record<string, PreviewAsset>> = {},
  ): Promise<PreviewSession> {
    if (this.startPromise) {
      return this.startPromise;
    }

    const operation = this.startExclusive(files, assets);
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startPromise === operation) {
        this.startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    await this.closeCurrentServer();
  }

  private async startExclusive(
    files: Readonly<Record<string, string>>,
    assets: Readonly<Record<string, PreviewAsset>>,
  ): Promise<PreviewSession> {
    await this.closeCurrentServer();

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname: string;
      try {
        pathname = decodeURI(requestUrl.pathname);
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Invalid URL encoding');
        return;
      }
      const redirect = exactPreviewRedirect(files['/_redirects'], pathname);
      if (redirect !== undefined) {
        response.writeHead(redirect.status, {
          location: redirect.location,
          'x-content-type-options': 'nosniff',
        });
        response.end();
        return;
      }
      const filePath = pathname.endsWith('/')
        ? `${pathname}index.html`
        : pathname;
      const body = pathname === '/_redirects' ? undefined : files[filePath];
      const asset = assets[pathname];

      if (body === undefined && asset === undefined) {
        const notFoundBody = files['/404/index.html'];
        if (notFoundBody !== undefined) {
          response.writeHead(404, {
            'content-type': 'text/html; charset=utf-8',
            'x-content-type-options': 'nosniff',
          });
          response.end(request.method === 'HEAD' ? undefined : notFoundBody);
          return;
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      response.writeHead(filePath === '/404/index.html' ? 404 : 200, {
        'content-type':
          asset?.contentType ?? contentTypeForGeneratedFile(filePath),
        'x-content-type-options': 'nosniff',
      });
      response.end(
        request.method === 'HEAD' ? undefined : (asset?.content ?? body),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    this.sessionUrl = url;
    return { url };
  }

  private async closeCurrentServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.sessionUrl = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      server.closeAllConnections();
    });
  }
}

function contentTypeForGeneratedFile(path: string): string {
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) {
    return 'text/javascript; charset=utf-8';
  }
  if (path.endsWith('.json') || path.endsWith('.map')) {
    return 'application/json; charset=utf-8';
  }
  if (path.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8';
  if (path.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function exactPreviewRedirect(
  manifest: string | undefined,
  pathname: string,
): { location: string; status: number } | undefined {
  if (manifest === undefined) return undefined;
  for (const line of manifest.split('\n')) {
    const [encodedSource, location, code, ...extra] = line.trim().split(/\s+/u);
    if (!encodedSource || !location || !code || extra.length > 0) continue;
    let source: string;
    try {
      source = decodeURI(encodedSource);
    } catch {
      continue;
    }
    if (source !== pathname) continue;
    const status = Number(code);
    if (![301, 302, 303, 307, 308].includes(status)) continue;
    return { location, status };
  }
  return undefined;
}
