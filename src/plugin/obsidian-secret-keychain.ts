import type { CloudflareKeychainBoundary } from '../cloudflare/connection';

interface ObsidianSecretStorageBoundary {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

/** Stores Cloudflare credentials through Obsidian SecretStorage. */
export class ObsidianSecretStorageKeychain implements CloudflareKeychainBoundary {
  constructor(private readonly storage: ObsidianSecretStorageBoundary) {}

  async save(service: string, secret: string): Promise<void> {
    this.storage.setSecret(secretId(service), secret);
  }

  async read(service: string): Promise<string | undefined> {
    const secret = this.storage.getSecret(secretId(service));
    return secret === null || secret.length === 0 ? undefined : secret;
  }

  async remove(service: string): Promise<void> {
    this.storage.setSecret(secretId(service), '');
  }
}

function secretId(service: string): string {
  const id = service.replaceAll('.', '-');
  if (!/^[a-z0-9-]+$/u.test(id)) {
    throw new Error('SecretStorage service IDs must be lowercase alphanumeric identifiers.');
  }
  return id;
}
