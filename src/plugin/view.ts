import { ButtonComponent, ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { PagesPublishApplication } from '../application';

export const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

export class PagesPublishView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly application: PagesPublishApplication,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PAGES_PUBLISH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '发布中心';
  }

  getIcon(): string {
    return 'cloud-upload';
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    container.createDiv({ cls: 'pages-publish-view__eyebrow', text: '发布工具' });

    const target = await this.application.getLaunchTarget();
    if (target === 'setup') {
      container.createEl('h2', { text: '尚未创建发布站点' });
      container.createEl('p', {
        text: '创建 .publish/site.yml 后，即可扫描并预览明确公开的 Markdown。完整设置向导将在下一实现 Slice 提供。',
      });
      container.createEl('code', { text: '.publish/site.yml' });
      return;
    }

    try {
      const preview = await this.application.preparePreview();
      container.createDiv({ cls: 'pages-publish-view__type', text: '发布中心' });
      container.createEl('h2', { text: preview.siteName });
      container.createEl('p', {
        cls: 'pages-publish-view__summary',
        text: `${preview.pages.length} 篇文章可进入本地预览`,
      });

      const list = container.createEl('ul', { cls: 'pages-publish-view__articles' });
      for (const page of preview.pages) {
        const item = list.createEl('li');
        item.createSpan({ text: page.title });
        item.createEl('code', { text: page.url });
      }

      const actions = container.createDiv({ cls: 'pages-publish-view__actions' });
      new ButtonComponent(actions)
        .setButtonText('预览站点')
        .setCta()
        .onClick(async () => {
          try {
            await this.application.openPreview();
            new Notice('本地预览已打开。');
          } catch (error) {
            new Notice(`无法打开本地预览：${errorMessage(error)}`);
          }
        });
    } catch (error) {
      container.createEl('h2', { text: '无法读取发布配置' });
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: errorMessage(error),
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
