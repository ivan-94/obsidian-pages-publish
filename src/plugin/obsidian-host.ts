import type { Plugin } from 'obsidian';
import type { LaunchTarget } from '../application';
import type { PagesPublishHost } from './lifecycle';
import { PAGES_PUBLISH_VIEW_TYPE } from './view';

export class ObsidianPagesPublishHost implements PagesPublishHost {
  constructor(private readonly plugin: Plugin) {}

  registerRibbon(
    icon: string,
    label: string,
    callback: () => Promise<void>,
  ): () => void {
    const element = this.plugin.addRibbonIcon(icon, label, () => {
      void callback();
    });
    return () => element.remove();
  }

  registerCommand(
    id: string,
    name: string,
    callback: () => Promise<void>,
  ): () => void {
    this.plugin.addCommand({
      id,
      name,
      callback: () => {
        void callback();
      },
    });
    return () => undefined;
  }

  registerVaultChanges(callback: () => void): () => void {
    const vault = this.plugin.app.vault;
    const references = [
      vault.on('create', callback),
      vault.on('modify', callback),
      vault.on('delete', callback),
      vault.on('rename', callback),
    ];
    return () => {
      for (const reference of references) vault.offref(reference);
    };
  }

  async openWorkspace(target: LaunchTarget): Promise<void> {
    const leaf = this.plugin.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
      state: { target },
    });
    await this.plugin.app.workspace.revealLeaf(leaf);
  }
}
