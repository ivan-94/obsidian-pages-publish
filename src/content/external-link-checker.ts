import { lookup } from 'dns/promises';
import { request as requestHttp } from 'http';
import { request as requestHttps } from 'https';
import { isIP } from 'net';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'timers';

export interface ExternalLinkCandidate {
  url: string;
  sourcePath: string;
  line: number;
  column: number;
}

export interface TemporaryExternalLinkIssue {
  severity: 'warning';
  code:
    | 'external-link-http-error'
    | 'external-link-unreachable'
    | 'external-link-unsafe-target';
  url: string;
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  temporary: true;
}

export interface ExternalLinkFetchBoundary {
  (
    input: string,
    init: RequestInit,
    resolvedAddress: string,
  ): Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
  }>;
}

export interface ExternalLinkHostResolver {
  (hostname: string): Promise<readonly string[]>;
}

const maximumRedirects = 5;
const maximumAuditedAddresses = 8;
const defaultTimeoutMs = 10_000;

export async function checkExternalLinks(
  candidates: readonly ExternalLinkCandidate[],
  options: {
    fetch?: ExternalLinkFetchBoundary;
    signal?: AbortSignal;
    resolveHost?: ExternalLinkHostResolver;
    timeoutMs?: number;
  },
): Promise<TemporaryExternalLinkIssue[]> {
  const issues: TemporaryExternalLinkIssue[] = [];
  const resolveHost = options.resolveHost ?? resolvePublicHostAddresses;
  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    try {
      let current = new URL(candidate.url);
      const candidateDeadline =
        Date.now() + (options.timeoutMs ?? defaultTimeoutMs);
      let response:
        | Awaited<ReturnType<ExternalLinkFetchBoundary>>
        | undefined;
      for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
        const addresses = await safeExternalAddresses(
          current,
          resolveHost,
          options.signal,
          remainingTimeout(candidateDeadline),
        );
        response = await fetchFromAuditedAddresses(
          current.toString(),
          options.fetch ?? requestPinnedExternalUrl,
          addresses,
          options.signal,
          candidateDeadline,
        );
        if (!redirectStatus(response.status)) break;
        const location = response.headers?.get('location');
        if (!location || redirectCount === maximumRedirects) break;
        current = new URL(location, current);
      }
      if (response && !response.ok) {
        issues.push(issueFor(candidate, 'external-link-http-error', {
          message: `The external link returned HTTP ${response.status}.`,
        }));
      }
    } catch (error) {
      if (options.signal?.aborted) throwAbortReason(options.signal);
      if (error instanceof UnsafeExternalTargetError) {
        issues.push(
          issueFor(candidate, 'external-link-unsafe-target', {
            message:
              'The external link targets a local, private, or otherwise unsafe network address.',
          }),
        );
        continue;
      }
      if (isAbortError(error) && options.signal?.aborted) throw error;
      issues.push(
        issueFor(candidate, 'external-link-unreachable', {
          message: 'The external link could not be reached during this check.',
        }),
      );
    }
  }
  return issues;
}

async function fetchFromAuditedAddresses(
  url: string,
  fetchBoundary: ExternalLinkFetchBoundary,
  addresses: readonly string[],
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<Awaited<ReturnType<ExternalLinkFetchBoundary>>> {
  let lastError: unknown;
  for (const address of addresses) {
    throwIfAborted(signal);
    const timeoutMs = remainingTimeout(deadline);
    try {
      return await fetchWithTimeout(
        url,
        fetchBoundary,
        address,
        signal,
        timeoutMs,
      );
    } catch (error) {
      if (signal?.aborted) throwAbortReason(signal);
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('No audited address was reachable.');
}

function issueFor(
  candidate: ExternalLinkCandidate,
  code: TemporaryExternalLinkIssue['code'],
  details: { message: string },
): TemporaryExternalLinkIssue {
  return {
    severity: 'warning',
    code,
    url: candidate.url,
    sourcePath: candidate.sourcePath,
    line: candidate.line,
    column: candidate.column,
    message: details.message,
    impact: 'Core preview and publishing remain available.',
    temporary: true,
  };
}

async function fetchWithTimeout(
  url: string,
  fetchBoundary: ExternalLinkFetchBoundary,
  resolvedAddress: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ExternalLinkFetchBoundary>>> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setNodeTimeout(() => {
    controller.abort(new DOMException('External link check timed out.', 'TimeoutError'));
  }, timeoutMs);
  try {
    throwIfAborted(signal);
    return await fetchBoundary(
      url,
      {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      },
      resolvedAddress,
    );
  } finally {
    clearNodeTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function safeExternalAddresses(
  url: URL,
  resolveHost: ExternalLinkHostResolver,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<readonly string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeExternalTargetError();
  }
  if (url.username || url.password) throw new UnsafeExternalTargetError();
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new UnsafeExternalTargetError();
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await awaitWithTimeout(resolveHost(hostname), signal, timeoutMs);
  if (addresses.length === 0 || addresses.some(isUnsafeIpAddress)) {
    throw new UnsafeExternalTargetError();
  }
  return [...new Set(addresses)].slice(0, maximumAuditedAddresses);
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DOMException('External link check timed out.', 'TimeoutError');
  }
  return remaining;
}

async function awaitWithTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortFromCaller = (): void => rejectAbort?.(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setNodeTimeout(
      () => reject(new DOMException('External link check timed out.', 'TimeoutError')),
      timeoutMs,
    );
    operation.finally(() => clearNodeTimeout(timer)).catch(() => undefined);
  });
  try {
    throwIfAborted(signal);
    return await Promise.race([operation, aborted, timeout]);
  } finally {
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

const requestPinnedExternalUrl: ExternalLinkFetchBoundary = async (
  input,
  init,
  resolvedAddress,
) => {
  const url = new URL(input);
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        protocol: url.protocol,
        hostname: resolvedAddress,
        port: url.port || undefined,
        method: init.method ?? 'HEAD',
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host },
        servername: url.hostname,
        signal: init.signal ?? undefined,
      },
      (response) => {
        response.resume();
        resolve({
          ok:
            response.statusCode !== undefined &&
            response.statusCode >= 200 &&
            response.statusCode < 300,
          status: response.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
            },
          },
        });
      },
    );
    operation.once('error', reject);
    operation.end();
  });
};

function isUnsafeIpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      /^fe[c-f]/u.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('::ffff:') ||
      normalized.startsWith('64:ff9b:') ||
      normalized.startsWith('2002:') ||
      /^2001:(?:0|0000):/u.test(normalized)
    );
  }
  return true;
}

async function resolvePublicHostAddresses(
  hostname: string,
): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );
}

function redirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throwAbortReason(signal);
}

function throwAbortReason(signal: AbortSignal): never {
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('External link check aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class UnsafeExternalTargetError extends Error {}
