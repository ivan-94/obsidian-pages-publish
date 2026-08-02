import { describe, expect, it, vi } from 'vitest';
import { ObsidianSecretStorageKeychain } from '../src/plugin/obsidian-secret-keychain';

describe('Obsidian SecretStorage Keychain boundary', () => {
  it('stores a Cloudflare credential through Obsidian SecretStorage', async () => {
    const setSecret = vi.fn();
    const keychain = new ObsidianSecretStorageKeychain({
      setSecret,
      getSecret: vi.fn(),
    });

    await keychain.save('pages-publish.cloudflare', 'token-secret');

    expect(setSecret).toHaveBeenCalledWith('pages-publish-cloudflare', 'token-secret');
  });

  it('restores the exact Cloudflare credential from Obsidian SecretStorage', async () => {
    const keychain = new ObsidianSecretStorageKeychain({
      setSecret: vi.fn(),
      getSecret: vi.fn(() => 'stored-token-secret'),
    });

    await expect(keychain.read('pages-publish.cloudflare')).resolves.toBe('stored-token-secret');
  });

  it('treats a cleared SecretStorage item as absent and clears it on disconnect', async () => {
    const setSecret = vi.fn();
    const keychain = new ObsidianSecretStorageKeychain({
      setSecret,
      getSecret: vi.fn(() => ''),
    });

    await expect(keychain.read('pages-publish.cloudflare')).resolves.toBeUndefined();
    await keychain.remove('pages-publish.cloudflare');

    expect(setSecret).toHaveBeenCalledWith('pages-publish-cloudflare', '');
  });
});
