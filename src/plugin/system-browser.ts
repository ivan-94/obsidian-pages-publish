export interface SystemBrowserShell {
  openExternal(url: string): Promise<void>;
}

/** Opens an external URL outside Obsidian so authentication cookies stay in one browser. */
export function openInSystemBrowser(
  url: string,
  shell?: SystemBrowserShell,
): Promise<void> {
  return openWithResolvedShell(url, shell);
}

async function openWithResolvedShell(
  url: string,
  shell: SystemBrowserShell | undefined,
): Promise<void> {
  const resolvedShell = shell ?? await electronSystemBrowserShell();
  await resolvedShell.openExternal(url);
}

async function electronSystemBrowserShell(): Promise<SystemBrowserShell> {
  const electron = await import('electron');
  if (!electron.shell) throw new Error('The Electron system browser is unavailable.');
  return electron.shell;
}
