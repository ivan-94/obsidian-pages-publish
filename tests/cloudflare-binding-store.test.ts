import { describe, expect, it, vi } from 'vitest';
import { PluginConnectionBindingStore } from '../src/plugin/cloudflare-binding-store';

describe('plugin Cloudflare binding store', () => {
  it('persists only the nonsecret connection binding while preserving unrelated plugin data', async () => {
    const save = vi.fn(async () => undefined);
    const store = new PluginConnectionBindingStore({
      load: async () => ({ uiPreference: 'compact' }),
      save,
    });

    await store.write({
      state: 'connected',
      method: 'api-token',
      account: { id: 'account-1', name: 'Personal' },
    });

    expect(save).toHaveBeenCalledWith({
      uiPreference: 'compact',
      cloudflareBinding: {
        state: 'connected',
        method: 'api-token',
        account: { id: 'account-1', name: 'Personal' },
      },
    });
  });
});
