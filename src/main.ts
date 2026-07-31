import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { PagesPublishApplication } from './application';
import { activatePagesPublish, type PagesPublishActivation } from './plugin/lifecycle';
import { ObsidianPagesPublishHost } from './plugin/obsidian-host';
import { isSupportedPlatform } from './plugin/platform';
import { PAGES_PUBLISH_VIEW_TYPE, PagesPublishView } from './plugin/view';

export default class PagesPublishPlugin extends Plugin {
  private activation: PagesPublishActivation | undefined;

  async onload(): Promise<void> {
    const isFileSystemVault = this.app.vault.adapter instanceof FileSystemAdapter;
    if (!isSupportedPlatform(process.platform, isFileSystemVault)) {
      new Notice('当前插件仅支持 macOS 上使用本地文件系统的 Obsidian 桌面端。');
      return;
    }

    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const application = new PagesPublishApplication(
      adapter.getBasePath(),
      (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    );

    this.registerView(
      PAGES_PUBLISH_VIEW_TYPE,
      (leaf) => new PagesPublishView(leaf, application),
    );
    this.activation = activatePagesPublish(
      application,
      new ObsidianPagesPublishHost(this),
    );
  }

  onunload(): void {
    void this.activation?.dispose();
  }
}
