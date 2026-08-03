import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps recovery records out of the Vault while making each local Vault's
 * state independent. The directory name never exposes the Vault path.
 */
export function localPluginStateDirectory(
  vaultRoot: string,
  input: { homeDirectory?: string } = {},
): string {
  const vaultIdentity = createHash('sha256').update(vaultRoot).digest('hex').slice(0, 32);
  return join(
    input.homeDirectory ?? homedir(),
    'Library',
    'Application Support',
    'pages-publish',
    'vault-state',
    vaultIdentity,
  );
}

/** Shared, rebuildable runtime and Quartz cache; never stored inside a Vault. */
export function publicationEnvironmentDirectory(
  input: { homeDirectory?: string } = {},
): string {
  return join(
    input.homeDirectory ?? homedir(),
    'Library',
    'Application Support',
    'pages-publish',
    'environment',
  );
}
