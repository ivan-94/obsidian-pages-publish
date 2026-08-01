import {
  ButtonComponent,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';
import type { PagesPublishApplication } from '../application';
import type { SiteConfigV1 } from '../config/site-config';
import type { ScanIssue } from '../content/site-scanner';
import type {
  PublishCenterArticle,
  PublishCenterState,
} from '../publication/publish-center';

export const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

type PublishCenterTab = 'changes' | 'all' | 'unpublished' | 'issues';

export class PagesPublishView extends ItemView {
  private activeTab: PublishCenterTab = 'changes';
  private selectedSourcePath: string | undefined;

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
      this.renderPublishCenter(
        container,
        await this.application.getPublishCenter(),
      );
    } catch (error) {
      container.createEl('h2', { text: '无法读取发布配置' });
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: errorMessage(error),
      });
    }
  }

  private renderPublishCenter(
    container: HTMLElement,
    center: PublishCenterState,
  ): void {
    container.createDiv({ cls: 'pages-publish-view__type', text: '发布中心' });
    container.createEl('h2', { text: center.siteName });
    container.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: center.output.status === 'unknown'
        ? '当前问题阻止了完整输出估算；修复后重新扫描即可恢复发布报告。'
        : center.baseline === 'unknown'
          ? `最近部署清单不可用；仍将完整构建 ${center.output.fileCount} 个文件。`
        : `自上次发布以来 ${center.summary.changes} 项变化 · ${center.output.fileCount} 个输出文件`,
    });

    const scanBar = container.createDiv({ cls: 'pages-publish-view__scan' });
    scanBar.createSpan({
      text: `+${center.summary.added} 新增 · ~${center.summary.updated} 更新 · -${center.summary.takedowns} 待下线 · ${center.summary.blockers} 阻塞 · ${center.summary.warnings} 警告`,
    });
    new ButtonComponent(scanBar).setButtonText('重新扫描').onClick(async () => {
      await this.render();
    });
    if (!center.canPublish) {
      const blocker = center.issues.find((issue) => issue.severity === 'blocker');
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: `发布被阻塞：${blocker?.message ?? '修复所有阻塞问题后重试。'}`,
      });
    }

    const tabs = container.createDiv({ cls: 'pages-publish-view__tabs' });
    const tabDefinitions: Array<{ id: PublishCenterTab; text: string }> = [
      { id: 'changes', text: `当前变化 ${center.summary.changes}` },
      { id: 'all', text: `全部内容 ${center.articles.length}` },
      { id: 'unpublished', text: `未发布 ${center.summary.added}` },
      { id: 'issues', text: `问题 ${center.issues.length}` },
    ];
    for (const tab of tabDefinitions) {
      new ButtonComponent(tabs)
        .setButtonText(tab.text)
        .setClass(this.activeTab === tab.id ? 'is-active' : '')
        .onClick(async () => {
          this.activeTab = tab.id;
          await this.render();
        });
    }

    const table = container.createEl('table', { cls: 'pages-publish-view__articles' });
    const header = table.createEl('thead').createEl('tr');
    for (const label of ['上线', '文章 / 路径', '公开方式', '状态变化', '检查']) {
      header.createEl('th', { text: label });
    }
    const body = table.createEl('tbody');
    for (const article of center.articles.filter((item) => this.matchesTab(item))) {
      const row = body.createEl('tr');
      row.addEventListener('click', (event) => {
        if (event.target instanceof HTMLInputElement) return;
        this.selectArticle(article);
      });
      const selection = row.createEl('td');
      const checkbox = selection.createEl('input', { type: 'checkbox' });
      checkbox.checked = article.nextIncluded;
      checkbox.disabled = article.availability !== 'ready';
      checkbox.setAttr('aria-label', `下一版包含 ${article.title}`);
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        void this.updateInclusion(article, checkbox.checked);
      });
      const title = row.createEl('td');
      new ButtonComponent(title)
        .setButtonText(article.title)
        .setTooltip(`审阅 ${article.title}`)
        .onClick(() => this.selectArticle(article));
      title.createEl('code', { text: article.sourcePath });
      row.createEl('td', { text: visibilityLabel(article.visibility) });
      row.createEl('td', { text: changeLabel(article.change) });
      row.createEl('td', {
        text: article.issues.length === 0
          ? '通过'
          : `${article.issues.some((issue) => issue.severity === 'blocker') ? '阻塞' : '警告'} ${article.issues.length}`,
      });
    }

    const selected = center.articles.find(
      (article) => article.sourcePath === this.selectedSourcePath,
    );
    if (selected) this.renderReviewDrawer(container, selected);
    if (this.activeTab === 'issues' && center.issues.length > 0) {
      const issues = container.createEl('ul', { cls: 'pages-publish-view__issues' });
      for (const issue of center.issues) {
        const item = issues.createEl('li', {
          cls: `pages-publish-view__issue pages-publish-view__issue--${issue.severity}`,
          text: `${issue.severity === 'blocker' ? '阻塞' : '警告'} · ${issue.path}${issue.line ? `:${issue.line}` : ''} · ${issue.message}`,
        });
        new ButtonComponent(item)
          .setButtonText('定位')
          .setTooltip('打开问题来源')
          .onClick(() => this.locateIssue(issue));
      }
    }

    const actions = container.createDiv({ cls: 'pages-publish-view__actions' });
    new ButtonComponent(actions).setButtonText('预览站点').onClick(async () => {
      try {
        await this.application.openPreview();
        new Notice('本地预览已打开。');
      } catch (error) {
        new Notice(`无法打开本地预览：${errorMessage(error)}`);
      }
    });
    new ButtonComponent(actions)
      .setButtonText(center.canPublish ? '确认发布计划' : '发布站点（不可用）')
      .setCta()
      .setDisabled(!center.canPublish)
      .onClick(async () => {
        try {
          const snapshot = await this.application.preparePublishSnapshot();
          new Notice(`已冻结 ${snapshot.output.fileCount} 个文件；后续编辑将进入下一次变化。`);
        } catch (error) {
          new Notice(`无法准备发布：${errorMessage(error)}`);
        }
      });
  }

  private matchesTab(article: PublishCenterArticle): boolean {
    if (this.activeTab === 'all') return true;
    if (this.activeTab === 'changes') return article.change !== 'unchanged';
    if (this.activeTab === 'unpublished') return article.change === 'added';
    return article.issues.length > 0;
  }

  private renderReviewDrawer(
    container: HTMLElement,
    article: PublishCenterArticle,
  ): void {
    const drawer = container.createDiv({ cls: 'pages-publish-view__review' });
    drawer.createEl('h3', { text: article.title });
    drawer.createEl('p', { text: article.sourcePath });
    if (article.availability === 'unavailable') {
      drawer.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: '当前 blocker 使此文章的待发布状态无法安全计算；修复后重新扫描。',
      });
    }
    if (article.availability === 'historical') {
      drawer.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: '本地源文件已不存在；此行只记录下一次完整发布的待下线事实，不能直接编辑。',
      });
    }
    drawer.createEl('p', { text: `待发布 URL：${article.url ?? '下一版不包含'}` });
    if (article.onlineUrl) {
      drawer.createEl('p', { text: `当前线上 URL：${article.onlineUrl}` });
    }
    drawer.createEl('h4', { text: '检查' });
    if (article.issues.length === 0) {
      drawer.createEl('p', { text: '未发现此文章的问题。' });
    } else {
      const issues = drawer.createEl('ul');
      for (const issue of article.issues) {
        const item = issues.createEl('li', {
          text: `${issue.severity === 'blocker' ? '阻塞' : '警告'} · ${issue.path}${issue.line ? `:${issue.line}` : ''} · ${issue.message}`,
        });
        new ButtonComponent(item)
          .setButtonText('定位')
          .setTooltip('打开问题来源')
          .onClick(() => this.locateIssue(issue));
      }
    }
  }

  private async updateInclusion(
    article: PublishCenterArticle,
    included: boolean,
  ): Promise<void> {
    try {
      const confirmTakedown = !included && Boolean(article.onlineUrl)
        ? await this.confirmTakedown(article)
        : false;
      if (!included && article.onlineUrl && !confirmTakedown) {
        await this.render();
        return;
      }
      await this.application.setPublishCenterInclusion(article.sourcePath, included, {
        confirmTakedown,
      });
      await this.render();
    } catch (error) {
      new Notice(`无法更新下一版选择：${errorMessage(error)}`);
      await this.render();
    }
  }

  private selectArticle(article: PublishCenterArticle): void {
    this.selectedSourcePath = article.sourcePath;
    void this.render();
  }

  private async locateIssue(issue: ScanIssue): Promise<void> {
    const path = issue.location?.path
      ?? (issue.path.endsWith('.md') ? issue.path : '.publish/site.yml');
    await this.app.workspace.openLinkText(path, '', false);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !issue.line) return;
    view.editor.setCursor({
      line: Math.max(0, issue.line - 1),
      ch: Math.max(0, (issue.column ?? 1) - 1),
    });
    view.editor.focus();
  }

  private async confirmTakedown(article: PublishCenterArticle): Promise<boolean> {
    return new Promise((resolve) => {
      new PublishCenterTakedownModal(this.app, article, resolve).open();
    });
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

class PublishCenterTakedownModal extends Modal {
  private settled = false;

  constructor(
    app: PagesPublishView['app'],
    private readonly article: PublishCenterArticle,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('确认待下线');
    this.contentEl.createEl('p', {
      text: '此文章将在下一次完整发布中下线；当前线上页面不会立即改变。',
    });
    if (this.article.onlineUrl) {
      this.contentEl.createEl('code', { text: this.article.onlineUrl });
    }
    const actions = this.contentEl.createDiv({
      cls: 'pages-publish-article-panel__modal-actions',
    });
    new ButtonComponent(actions).setButtonText('取消').onClick(() => this.finish(false));
    new ButtonComponent(actions)
      .setButtonText('确认待下线')
      .setDestructive()
      .onClick(() => this.finish(true));
  }

  onClose(): void {
    if (!this.settled) this.resolve(false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean): void {
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function visibilityLabel(value: PublishCenterArticle['visibility']): string {
  if (value === 'public') return '公开';
  if (value === 'unlisted') return '不列出';
  if (value === 'private') return '不公开';
  return '—';
}

function changeLabel(value: PublishCenterArticle['change']): string {
  const labels: Record<PublishCenterArticle['change'], string> = {
    added: '新增',
    updated: '内容更新',
    'url-changed': 'URL 已变化',
    'visibility-changed': '公开方式已变化',
    takedown: '待下线',
    unchanged: '无变化',
    unknown: '状态未知',
  };
  return labels[value];
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
