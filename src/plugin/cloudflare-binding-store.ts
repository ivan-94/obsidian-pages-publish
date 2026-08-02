import type {
  CloudflareBindingStore,
  CloudflareConnectionStatus,
} from '../cloudflare/connection';

export interface PluginDataBoundary {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

/** Stores only nonsecret Cloudflare connection metadata in Obsidian plugin data. */
export class PluginConnectionBindingStore implements CloudflareBindingStore {
  constructor(private readonly data: PluginDataBoundary) {}

  async read(): Promise<CloudflareConnectionStatus | undefined> {
    return bindingFromPluginData(await this.data.load());
  }

  async write(status: CloudflareConnectionStatus): Promise<void> {
    const existing = await this.data.load();
    const root = isRecord(existing) ? existing : {};
    await this.data.save({ ...root, cloudflareBinding: copyBinding(status) });
  }
}

function bindingFromPluginData(value: unknown): CloudflareConnectionStatus | undefined {
  if (!isRecord(value)) return undefined;
  const binding = value.cloudflareBinding;
  if (!isRecord(binding) || !isConnectionState(binding.state)) return undefined;
  if (binding.state !== 'connected') {
    return {
      state: binding.state,
      ...(isConnectionMethod(binding.method) ? { method: binding.method } : {}),
      ...(isAccount(binding.account) ? { account: copyAccount(binding.account) } : {}),
    };
  }
  if (!isConnectionMethod(binding.method) || !isAccount(binding.account)) return undefined;
  return {
    state: 'connected',
    method: binding.method,
    account: copyAccount(binding.account),
  };
}

function copyBinding(status: CloudflareConnectionStatus): CloudflareConnectionStatus {
  return {
    state: status.state,
    ...(status.method === undefined ? {} : { method: status.method }),
    ...(status.account === undefined ? {} : { account: copyAccount(status.account) }),
  };
}

function copyAccount(account: { id: string; name: string }): { id: string; name: string } {
  return { id: account.id, name: account.name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isConnectionState(value: unknown): value is CloudflareConnectionStatus['state'] {
  return value === 'disconnected' || value === 'connected' || value === 'expired';
}

function isConnectionMethod(value: unknown): value is 'oauth' | 'api-token' {
  return value === 'oauth' || value === 'api-token';
}

function isAccount(value: unknown): value is { id: string; name: string } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
}
