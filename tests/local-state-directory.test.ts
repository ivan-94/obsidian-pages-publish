import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localPluginStateDirectory } from '../src/plugin/local-state-directory';

describe('local plugin state directory', () => {
  it('uses macOS Application Support keyed by vault identity rather than writing recovery data into the Vault', () => {
    const vaultRoot = '/Users/ivan/Documents/Knowledge Vault';
    const expectedIdentity = createHash('sha256').update(vaultRoot).digest('hex').slice(0, 32);

    expect(localPluginStateDirectory(vaultRoot, { homeDirectory: '/Users/ivan' })).toBe(
      `/Users/ivan/Library/Application Support/pages-publish/vault-state/${expectedIdentity}`,
    );
  });
});
