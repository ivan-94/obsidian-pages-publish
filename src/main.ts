import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { PagesPublishApplication } from './application';
import { watchSiteConfigChanges } from './config/site-config-watcher';
import { activatePagesPublish, type PagesPublishActivation } from './plugin/lifecycle';
import { ObsidianPagesPublishHost } from './plugin/obsidian-host';
import { isSupportedPlatform } from './plugin/platform';
import { PagesPublishSettingTab } from './plugin/settings-tab';
import {
  CURRENT_ARTICLE_VIEW_TYPE,
  CurrentArticleView,
} from './plugin/current-article-view';
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
      {
        scanTimers: {
          set: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clear: (handle) => window.clearTimeout(handle as number),
        },
      },
    );
    const settingTab = new PagesPublishSettingTab(
      this,
      adapter.getBasePath(),
      application,
    );
    this.addSettingTab(settingTab);
    const notifyConfigChange = (file: { path: string }): void => {
      if (file.path === '.publish/site.yml') {
        void settingTab.notifyConfigFileChanged();
      }
    };
    this.registerEvent(this.app.vault.on('create', notifyConfigChange));
    this.registerEvent(this.app.vault.on('modify', notifyConfigChange));
    this.registerEvent(this.app.vault.on('delete', notifyConfigChange));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.path === '.publish/site.yml' || oldPath === '.publish/site.yml') {
          void settingTab.notifyConfigFileChanged();
        }
      }),
    );
    this.register(
      watchSiteConfigChanges(adapter.getBasePath(), () => {
        void settingTab.notifyConfigFileChanged();
        application.notifyFileChange();
      }),
    );

    this.registerView(
      PAGES_PUBLISH_VIEW_TYPE,
      (leaf) => new PagesPublishView(leaf, application),
    );
    this.registerView(
      CURRENT_ARTICLE_VIEW_TYPE,
      (leaf) =>
        new CurrentArticleView(leaf, application, () =>
          this.openPublishCenter(),
        ),
    );
    this.addCommand({
      id: 'open-current-article-panel',
      name: '打开当前文章面板',
      callback: () => {
        void this.openCurrentArticlePanel();
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
          return;
        }
        menu.addItem((item) =>
          item
            .setTitle('Pages publish：打开当前文章面板')
            .setIcon('file-up')
            .onClick(() => {
              void this.openCurrentArticlePanel();
            }),
        );
      }),
    );
    this.activation = activatePagesPublish(
      application,
      new ObsidianPagesPublishHost(this),
    );
  }

  onunload(): void {
    void this.activation?.dispose();
  }

  private async openCurrentArticlePanel(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice('无法创建右侧边栏，请检查当前工作区布局。');
      return;
    }
    await leaf.setViewState({
      type: CURRENT_ARTICLE_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async openPublishCenter(): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}
