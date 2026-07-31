import {
  ButtonComponent,
  ItemView,
  Notice,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';
import type { PagesPublishApplication } from '../application';
import type { SiteConfigV1 } from '../config/site-config';

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
      this.renderLocalSetup(container);
      return;
    }

    try {
      const scan = await this.application.requestScan('manual-refresh');
      const scanBar = container.createDiv({ cls: 'pages-publish-view__scan' });
      scanBar.createSpan({
        text: `扫描完成 · ${scan.value.candidates.length} 篇 Markdown 候选`,
      });
      new ButtonComponent(scanBar).setButtonText('重新扫描').onClick(async () => {
        await this.render();
      });
      if (scan.value.issues.length > 0) {
        const issueList = container.createEl('ul', {
          cls: 'pages-publish-view__issues',
        });
        for (const issue of scan.value.issues) {
          issueList.createEl('li', {
            cls: `pages-publish-view__issue pages-publish-view__issue--${issue.severity}`,
            text: `${issue.severity === 'blocker' ? '阻塞' : '警告'} · ${issue.path} · ${issue.message}`,
          });
        }
      }
      if (scan.value.issues.some((issue) => issue.severity === 'blocker')) {
        container.createEl('h2', { text: '发布已被安全检查阻止' });
        container.createEl('p', {
          text: '修复上方问题后重新扫描。现有线上站点不会受到影响。',
        });
        return;
      }
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

  private renderLocalSetup(container: HTMLElement): void {
    const vaultName = this.app.vault.getName();
    const draft: SiteConfigV1 = {
      version: 1,
      site: { name: vaultName, homeLayout: 'sections' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: projectNameFrom(vaultName) },
    };

    container.createDiv({ cls: 'pages-publish-view__type', text: '首次设置' });
    container.createEl('h2', { text: '创建本地发布配置' });
    container.createEl('p', {
      text: '此步骤只写入 .publish/site.yml 并扫描候选，不会连接 Cloudflare、发布文章或修改 Frontmatter。',
    });

    new Setting(container).setName('站点名称').addText((text) =>
      text.setValue(draft.site.name).onChange((value) => {
        draft.site.name = value;
      }),
    );
    new Setting(container).setName('站点简介').addTextArea((text) =>
      text.onChange((value) => {
        draft.site.description = value || undefined;
      }),
    );
    const scopeWarning = container.createEl('p', {
      cls: 'pages-publish-view__warning',
    });
    new Setting(container)
      .setName('内容目录')
      .setDesc('Vault 相对目录；只有目录内的 Markdown 会成为候选。')
      .addText((text) =>
        text.setValue('notes').onChange((value) => {
          const root = draft.contentRoots[0];
          if (root) root.path = value;
          scopeWarning.setText(
            value.trim() === '.'
              ? '警告：选择 Vault 根会把整个 Vault 的 Markdown 纳入候选范围。'
              : '',
          );
        }),
      );
    new Setting(container)
      .setName('公开路径')
      .setDesc('必须以 / 开始。')
      .addText((text) =>
        text.setValue('/notes').onChange((value) => {
          const root = draft.contentRoots[0];
          if (root) root.publicRoot = value;
        }),
      );
    new Setting(container)
      .setName('Cloudflare 项目标识')
      .setDesc('仅保存非密钥计划；不会创建或绑定远端项目。')
      .addText((text) =>
        text.setValue(draft.cloudflare.projectName).onChange((value) => {
          draft.cloudflare.projectName = value;
        }),
      );

    const actions = container.createDiv({ cls: 'pages-publish-view__actions' });
    new ButtonComponent(actions)
      .setButtonText('创建本地配置并扫描')
      .setCta()
      .onClick(async () => {
        try {
          await this.application.createInitialSiteConfig(draft);
          new Notice('本地配置已创建并完成扫描。没有发布任何文章。');
          await this.render();
        } catch (error) {
          new Notice(`无法创建本地配置：${errorMessage(error)}`);
        }
      });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function projectNameFrom(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58);
  return normalized || 'pages-publish-site';
}
