export const OBSIDIAN_PLUGIN_FILES: readonly ['main.js', 'manifest.json', 'styles.css'];

export function installStagedObsidianPlugin(input: {
  vaultRoot: string;
  configDir: string;
  stagedDirectory: string;
}): Promise<{
  pluginDirectory: string;
  pluginId: string;
  version: string;
}>;

export function uninstallStagedObsidianPlugin(input: {
  vaultRoot: string;
  configDir: string;
  pluginId: string;
}): Promise<void>;
