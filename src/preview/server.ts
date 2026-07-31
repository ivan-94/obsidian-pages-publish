import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

export interface PreviewSession {
  url: string;
}

export class LocalPreviewServer {
  private server: Server | undefined;
  private startPromise: Promise<PreviewSession> | undefined;

  async start(files: Readonly<Record<string, string>>): Promise<PreviewSession> {
    if (this.startPromise) {
      return this.startPromise;
    }

    const operation = this.startExclusive(files);
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
      const filePath = pathname.endsWith('/')
        ? `${pathname}index.html`
        : pathname;
      const body = files[filePath];

      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
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
    return { url: `http://127.0.0.1:${address.port}/` };
  }

  private async closeCurrentServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
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
    });
  }
}
