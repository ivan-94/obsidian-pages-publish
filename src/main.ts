import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { PagesPublishApplication } from './application';
import { watchSiteConfigChanges } from './config/site-config-watcher';
import { activatePagesPublish, type PagesPublishActivation } from './plugin/lifecycle';
import { ObsidianPagesPublishHost } from './plugin/obsidian-host';
import { isSupportedPlatform } from './plugin/platform';
import { pagesPublishAction } from './plugin/safe-actions';
import { openPluginSettingsInHost } from './plugin/settings-navigation';
import { PagesPublishSettingTab } from './plugin/settings-tab';
import { createLocalMaintenanceService } from './maintenance/local-maintenance';
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
    const maintenanceDirectory = `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/maintenance`;
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
        maintenance: createLocalMaintenanceService({
          directory: maintenanceDirectory,
          pluginVersion: this.manifest.version,
          platform: process.platform,
          adapter: this.app.vault.adapter,
        }),
      },
    );
    // The application currently has no host-provided Pages adapter until its
    // connection boundary is configured. Calling this now keeps startup
    // recovery wired for that boundary without exposing an unhandled promise.
    void application.hydratePublicationFacts().catch(() => undefined);
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
    const openArticlePanel = pagesPublishAction('open-current-article-panel');
    this.addCommand({
      id: openArticlePanel.id,
      name: openArticlePanel.name,
      callback: () => {
        void this.openCurrentArticlePanel();
      },
    });
    const previewCurrentArticle = pagesPublishAction('preview-current-article');
    this.addCommand({
      id: previewCurrentArticle.id,
      name: previewCurrentArticle.name,
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.previewArticle(application, file.path);
        return true;
      },
    });
    const previewSite = pagesPublishAction('preview-site');
    this.addCommand({
      id: previewSite.id,
      name: previewSite.name,
      callback: () => {
        void this.previewSite(application);
      },
    });
    const changeVisibility = pagesPublishAction('change-current-article-visibility');
    this.addCommand({
      id: changeVisibility.id,
      name: changeVisibility.name,
      checkCallback: (checking) => {
        if (!this.activeMarkdownFile()) return false;
        if (!checking) void this.openCurrentArticlePanel();
        return true;
      },
    });
    const openOnlinePage = pagesPublishAction('open-current-article-online-page');
    this.addCommand({
      id: openOnlinePage.id,
      name: openOnlinePage.name,
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openArticleOnlinePage(application, file.path);
        return true;
      },
    });
    const openSettings = pagesPublishAction('open-plugin-settings');
    this.addCommand({
      id: openSettings.id,
      name: openSettings.name,
      callback: () => this.openPluginSettings(),
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
          return;
        }
        // Obsidian's public MenuItem API has no submenu primitive. A labelled
        // section preserves the Pages Publish grouping without relying on DOM
        // internals that would make the menu brittle across desktop releases.
        menu.addItem((item) => item.setTitle('Pages publish').setIsLabel(true));
        menu.addItem((item) =>
          item
            .setTitle(pagesPublishAction('open-article-panel').name)
            .setIcon('file-up')
            .onClick(() => {
              void this.openArticlePanelFor(file.path);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle(pagesPublishAction('change-visibility').name)
            .setIcon('eye')
            .onClick(() => {
              void this.openArticlePanelFor(file.path);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle(pagesPublishAction('preview-article').name)
            .setIcon('monitor-play')
            .onClick(() => {
              void this.previewArticle(application, file.path);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle(pagesPublishAction('open-online-page').name)
            .setIcon('external-link')
            .onClick(() => {
              void this.openArticleOnlinePage(application, file.path);
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

  private async openArticlePanelFor(sourcePath: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(sourcePath, '', false);
      await this.openCurrentArticlePanel();
    } catch (error) {
      new Notice(`无法打开当前文章面板：${errorMessage(error)}`);
    }
  }

  private async openPublishCenter(): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveFile();
    return file?.extension.toLowerCase() === 'md' ? file : undefined;
  }

  private async previewArticle(
    application: PagesPublishApplication,
    sourcePath: string,
  ): Promise<void> {
    try {
      await application.openArticlePreview(sourcePath);
      new Notice('本地预览已打开；没有发布线上内容。');
    } catch (error) {
      new Notice(`无法打开当前文章预览：${errorMessage(error)}`);
    }
  }

  private async previewSite(application: PagesPublishApplication): Promise<void> {
    try {
      await application.openPreview();
      new Notice('本地预览已打开；没有发布线上内容。');
    } catch (error) {
      new Notice(`无法打开本地预览：${errorMessage(error)}`);
    }
  }

  private async openArticleOnlinePage(
    application: PagesPublishApplication,
    sourcePath: string,
  ): Promise<void> {
    try {
      const state = await application.getCurrentArticlePanel({ activePath: sourcePath });
      if (state.status !== 'article' || !state.metadata.deployment?.url) {
        new Notice('此文章尚无可打开的线上页面。');
        return;
      }
      window.open(state.metadata.deployment.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      new Notice(`无法读取当前文章的线上页面：${errorMessage(error)}`);
    }
  }

  private openPluginSettings(): void {
    if (!openPluginSettingsInHost(this.app, this.manifest.id)) {
      new Notice('请在 Obsidian 设置中打开此插件的设置。');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误。';
}
