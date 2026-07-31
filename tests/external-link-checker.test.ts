import { describe, expect, it, vi } from 'vitest';
import { checkExternalLinks } from '../src/content/external-link-checker';

describe('manual external link checker', () => {
  it('requests links only when invoked and returns temporary failure warnings', async () => {
    const fetchBoundary = vi.fn(async (input: string, _init: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/network-failure')) throw new Error('offline');
      return new Response(undefined, {
        status: url.endsWith('/service-failure') ? 503 : 204,
      });
    });
    const candidates = [
      {
        url: 'https://example.test/ok',
        sourcePath: 'notes/source.md',
        line: 7,
        column: 1,
      },
      {
        url: 'https://example.test/service-failure',
        sourcePath: 'notes/source.md',
        line: 8,
        column: 1,
      },
      {
        url: 'https://example.test/network-failure',
        sourcePath: 'notes/source.md',
        line: 9,
        column: 1,
      },
    ];

    expect(fetchBoundary).not.toHaveBeenCalled();

    const issues = await checkExternalLinks(candidates, {
      fetch: fetchBoundary,
      resolveHost: async () => ['93.184.216.34'],
    });

    expect(fetchBoundary).toHaveBeenCalledTimes(candidates.length);
    for (const call of fetchBoundary.mock.calls) {
      expect(call[1]).toMatchObject({ method: 'HEAD', redirect: 'manual' });
    }
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'external-link-http-error',
        sourcePath: 'notes/source.md',
        line: 8,
        temporary: true,
        impact: 'Core preview and publishing remain available.',
      }),
      expect.objectContaining({
        severity: 'warning',
        code: 'external-link-unreachable',
        sourcePath: 'notes/source.md',
        line: 9,
        temporary: true,
        impact: 'Core preview and publishing remain available.',
      }),
    ]);
  });

  it('blocks local, private DNS, and private redirect targets before requesting them', async () => {
    const fetchBoundary = vi.fn(async (input: string) => {
      if (input === 'https://public.example/start') {
        return new Response(undefined, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }
      return new Response(undefined, { status: 204 });
    });
    const issues = await checkExternalLinks(
      [
        {
          url: 'http://127.0.0.1/admin',
          sourcePath: 'notes/source.md',
          line: 1,
          column: 1,
        },
        {
          url: 'https://rebinding.example/secret',
          sourcePath: 'notes/source.md',
          line: 2,
          column: 1,
        },
        {
          url: 'https://public.example/start',
          sourcePath: 'notes/source.md',
          line: 3,
          column: 1,
        },
        {
          url: 'https://legacy-v6.example/page',
          sourcePath: 'notes/source.md',
          line: 4,
          column: 1,
        },
        {
          url: 'https://nat64.example/page',
          sourcePath: 'notes/source.md',
          line: 5,
          column: 1,
        },
        {
          url: 'https://six-to-four.example/page',
          sourcePath: 'notes/source.md',
          line: 6,
          column: 1,
        },
      ],
      {
        fetch: fetchBoundary,
        resolveHost: async (hostname) =>
          hostname === 'rebinding.example'
            ? ['10.0.0.7']
            : hostname === 'legacy-v6.example'
              ? ['fec0::1']
              : hostname === 'nat64.example'
                ? ['64:ff9b::a00:7']
                : hostname === 'six-to-four.example'
                  ? ['2002:0a00:0007::1']
                  : ['93.184.216.34'],
      },
    );

    expect(fetchBoundary).toHaveBeenCalledTimes(1);
    expect(fetchBoundary).toHaveBeenCalledWith(
      'https://public.example/start',
      expect.objectContaining({ redirect: 'manual' }),
      '93.184.216.34',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 1,
      }),
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 2,
      }),
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 3,
      }),
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 4,
      }),
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 5,
      }),
      expect.objectContaining({
        code: 'external-link-unsafe-target',
        line: 6,
      }),
    ]);
  });

  it('does not swallow caller cancellation with an ordinary Error reason', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancelled by caller');
    const fetchBoundary = vi.fn(async () => {
      controller.abort(cancellation);
      throw new Error('request failed after cancellation');
    });

    await expect(
      checkExternalLinks(
        [
          {
            url: 'https://public.example/page',
            sourcePath: 'notes/source.md',
            line: 1,
            column: 1,
          },
        ],
        {
          fetch: fetchBoundary,
          signal: controller.signal,
          resolveHost: async () => ['93.184.216.34'],
        },
      ),
    ).rejects.toBe(cancellation);
  });

  it('times out DNS resolution before any request is attempted', async () => {
    const fetchBoundary = vi.fn();

    const issues = await checkExternalLinks(
      [
        {
          url: 'https://slow-dns.example/page',
          sourcePath: 'notes/source.md',
          line: 1,
          column: 1,
        },
      ],
      {
        fetch: fetchBoundary,
        resolveHost: async () => new Promise<never>(() => undefined),
        timeoutMs: 1,
      },
    );

    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(issues).toEqual([
      expect.objectContaining({ code: 'external-link-unreachable' }),
    ]);
  });

  it('tries the next audited address when the first one is unreachable', async () => {
    const fetchBoundary = vi.fn(
      async (_input: string, _init: RequestInit, address: string) => {
        if (address === '93.184.216.34') throw new Error('first route failed');
        return new Response(undefined, { status: 204 });
      },
    );

    const issues = await checkExternalLinks(
      [
        {
          url: 'https://multi-address.example/page',
          sourcePath: 'notes/source.md',
          line: 1,
          column: 1,
        },
      ],
      {
        fetch: fetchBoundary,
        resolveHost: async () => ['93.184.216.34', '93.184.216.35'],
      },
    );

    expect(issues).toEqual([]);
    expect(fetchBoundary.mock.calls.map((call) => call[2])).toEqual([
      '93.184.216.34',
      '93.184.216.35',
    ]);
  });

  it('deduplicates and caps the number of audited connection attempts', async () => {
    const fetchBoundary = vi.fn(
      async (_input: string, _init: RequestInit, _address: string) => {
      throw new Error('route failed');
      },
    );
    const addresses = [
      '93.184.216.34',
      '93.184.216.34',
      ...Array.from({ length: 12 }, (_value, index) => `93.184.216.${35 + index}`),
    ];

    const issues = await checkExternalLinks(
      [
        {
          url: 'https://many-addresses.example/page',
          sourcePath: 'notes/source.md',
          line: 1,
          column: 1,
        },
      ],
      {
        fetch: fetchBoundary,
        resolveHost: async () => addresses,
      },
    );

    expect(issues).toEqual([
      expect.objectContaining({ code: 'external-link-unreachable' }),
    ]);
    expect(fetchBoundary.mock.calls.map((call) => call[2])).toEqual([
      '93.184.216.34',
      '93.184.216.35',
      '93.184.216.36',
      '93.184.216.37',
      '93.184.216.38',
      '93.184.216.39',
      '93.184.216.40',
      '93.184.216.41',
    ]);
  });

  it('shares one timeout deadline across all addresses for a candidate', async () => {
    const fetchBoundary = vi.fn(
      async (_input: string, init: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error('request aborted'),
              ),
            { once: true },
          );
        }),
    );

    const issues = await checkExternalLinks(
      [
        {
          url: 'https://deadline.example/page',
          sourcePath: 'notes/source.md',
          line: 1,
          column: 1,
        },
      ],
      {
        fetch: fetchBoundary,
        resolveHost: async () => [
          '93.184.216.34',
          '93.184.216.35',
          '93.184.216.36',
        ],
        timeoutMs: 2,
      },
    );

    expect(issues).toEqual([
      expect.objectContaining({ code: 'external-link-unreachable' }),
    ]);
    expect(fetchBoundary).toHaveBeenCalledOnce();
  });
});
