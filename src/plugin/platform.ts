export function isSupportedPlatform(
  platform: NodeJS.Platform,
  hasFileSystemVault: boolean,
): boolean {
  return platform === 'darwin' && hasFileSystemVault;
}
