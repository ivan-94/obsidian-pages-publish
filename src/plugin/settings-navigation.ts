interface SettingsModalHost {
  open(): void;
  openTabById(id: string): void;
}

/**
 * Obsidian exposes its Settings modal at runtime but not through the public
 * `App` typings. Keep that compatibility boundary narrow and always leave a
 * usable fallback for hosts where it is unavailable.
 */
export function openPluginSettingsInHost(
  app: unknown,
  pluginId: string,
): boolean {
  const settings = (app as { setting?: unknown }).setting;
  if (!isSettingsModalHost(settings)) return false;
  settings.open();
  settings.openTabById(pluginId);
  return true;
}

function isSettingsModalHost(value: unknown): value is SettingsModalHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { open?: unknown }).open === 'function' &&
    typeof (value as { openTabById?: unknown }).openTabById === 'function'
  );
}
