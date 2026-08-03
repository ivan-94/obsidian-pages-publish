export type SupportedPlatformIdentity = 'darwin-arm64' | 'darwin-x64';

export function supportedPlatformIdentity(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  hasFileSystemVault: boolean,
): SupportedPlatformIdentity | undefined {
  if (platform !== 'darwin' || !hasFileSystemVault) return undefined;
  if (architecture === 'arm64') return 'darwin-arm64';
  if (architecture === 'x64') return 'darwin-x64';
  return undefined;
}

export function isSupportedPlatform(
  platform: NodeJS.Platform,
  hasFileSystemVault: boolean,
  architecture: NodeJS.Architecture = process.arch,
): boolean {
  return supportedPlatformIdentity(
    platform,
    architecture,
    hasFileSystemVault,
  ) !== undefined;
}
