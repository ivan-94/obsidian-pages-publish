export const MINIMUM_OBSIDIAN_VERSION: string;

export function stagePluginPackage(options: {
  projectRoot: string;
  distRoot: string;
  expectedVersion?: string;
}): Promise<{
  directory: string;
  pluginId: string;
  version: string;
}>;
