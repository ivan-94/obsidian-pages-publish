import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from 'net';
import { once } from 'events';
import { setTimeout as delay } from 'timers/promises';
import { LocalPreviewServer } from '../src/preview/server';

describe('local preview server', () => {
  const servers: LocalPreviewServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
  });

  it('serves generated site files on loopback and stops cleanly', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);

    const session = await server.start({
      '/index.html': '<h1>Home</h1>',
      '/notes/hello/index.html': '<h1>Hello Pages</h1>',
    });

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(`${session.url}notes/hello/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Hello Pages</h1>');

    await server.stop();
    await expect(fetch(session.url)).rejects.toThrow();
  });

  it('serializes concurrent starts so one stop closes every returned session', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);

    const [first, second] = await Promise.all([
      server.start({ '/index.html': '<h1>First</h1>' }),
      server.start({ '/index.html': '<h1>Second</h1>' }),
    ]);

    expect(first.url).toBe(second.url);
    await server.stop();
    await expect(fetch(first.url)).rejects.toThrow();
    await expect(fetch(second.url)).rejects.toThrow();
  });

  it('restarts while a browser connection to the previous preview remains open', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const first = await server.start({ '/index.html': '<h1>First</h1>' });
    const firstUrl = new URL(first.url);
    const browserConnection = createConnection({
      host: firstUrl.hostname,
      port: Number(firstUrl.port),
    });
    await once(browserConnection, 'connect');
    browserConnection.write(
      `GET / HTTP/1.1\r\nHost: ${firstUrl.host}\r\nConnection: keep-alive\r\n`,
    );
    await delay(10);

    let timedOut = false;
    const restarting = server.start({ '/index.html': '<h1>Second</h1>' });
    const second = await Promise.race([
      restarting,
      delay(100).then(() => {
        timedOut = true;
        return undefined;
      }),
    ]);

    browserConnection.destroy();
    await restarting;
    expect(timedOut).toBe(false);
    expect(second).toBeDefined();
    const response = await fetch(second!.url);
    expect(await response.text()).toContain('<h1>Second</h1>');
  });

  it('serves binary preview assets with their declared media type', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    const session = await server.start(
      { '/index.html': '<img src="/assets/image.png" alt="image">' },
      {
        '/assets/image.png': {
          content: image,
          contentType: 'image/png',
        },
      },
    );

    const response = await fetch(`${session.url}assets/image.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });

  it('serves generated theme stylesheets with a CSS media type', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);

    const session = await server.start({
      '/index.html': '<link rel="stylesheet" href="/assets/theme.css">',
      '/assets/theme.css': ':root { color-scheme: light dark; }',
    });

    const response = await fetch(`${session.url}assets/theme.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toContain('color-scheme');
  });

  it('serves Quartz scripts and indexes with executable-safe media types', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const session = await server.start({
      '/app.js': 'window.quartz = true;',
      '/static/contentIndex.json': '{"pages":[]}',
    });

    const script = await fetch(`${session.url}app.js`);
    const index = await fetch(`${session.url}static/contentIndex.json`);

    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(index.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('serves the designed HTML error page with a 404 status for missing routes', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const notFound = '<!doctype html><title>页面未找到</title><h1>页面未找到</h1>';
    const session = await server.start({
      '/index.html': '<h1>Home</h1>',
      '/404/index.html': notFound,
    });

    const missingResponse = await fetch(`${session.url}missing/deep/`);
    const explicitResponse = await fetch(`${session.url}404/`);

    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(await missingResponse.text()).toBe(notFound);
    expect(explicitResponse.status).toBe(404);
    expect(await explicitResponse.text()).toBe(notFound);
  });

  it('serves a generated sitemap as XML', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const sitemap = '<?xml version="1.0"?><urlset></urlset>';
    const session = await server.start({ '/sitemap.xml': sitemap });

    const response = await fetch(`${session.url}sitemap.xml`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await response.text()).toBe(sitemap);
  });

  it('applies the controlled Cloudflare redirect manifest before HTML fallback', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);
    const session = await server.start({
      '/_redirects': '/old/ /new/ 301\n',
      '/old/index.html': '<meta http-equiv="refresh" content="0;url=/new/">',
      '/new/index.html': '<h1>New</h1>',
    });

    const response = await fetch(`${session.url}old/`, { redirect: 'manual' });
    const manifest = await fetch(`${session.url}_redirects`, { redirect: 'manual' });

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/new/');
    expect(manifest.status).toBe(404);
  });

  it('reports its running session and clears it after a safe stop', async () => {
    const server = new LocalPreviewServer();
    servers.push(server);

    expect(server.getStatus()).toEqual({ state: 'stopped' });
    const session = await server.start({ '/index.html': '<h1>Preview</h1>' });

    expect(server.getStatus()).toEqual({ state: 'running', url: session.url });
    await server.stop();
    expect(server.getStatus()).toEqual({ state: 'stopped' });
  });
});
