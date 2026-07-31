import { afterEach, describe, expect, it } from 'vitest';
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
});
