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
  const resolvedShell = shell ?? electronSystemBrowserShell();
  await resolvedShell.openExternal(url);
}

function electronSystemBrowserShell(): SystemBrowserShell {
  // Obsidian loads desktop plugins as CommonJS and provides Electron at runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is supplied by the Obsidian desktop host.
  const electron = require('electron') as { shell?: SystemBrowserShell };
  if (!electron.shell) throw new Error('The Electron system browser is unavailable.');
  return electron.shell;
}
