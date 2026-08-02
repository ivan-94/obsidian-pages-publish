import type { Workspace } from 'obsidian';

export const PAGES_PUBLISH_LOG_VIEW_TYPE = 'pages-publish-local-log';

/**
 * A config-directory file is not a Vault TFile, so it cannot safely be opened
 * via Workspace.openLinkText. Open a registered ItemView instead, using only
 * public workspace APIs.
 */
export async function openLatestMaintenanceLog(input: {
  workspace: Pick<Workspace, 'getLeaf' | 'revealLeaf'>;
}): Promise<void> {
  const leaf = input.workspace.getLeaf('tab');
  await leaf.setViewState({
    type: PAGES_PUBLISH_LOG_VIEW_TYPE,
    active: true,
  });
  await input.workspace.revealLeaf(leaf);
}
