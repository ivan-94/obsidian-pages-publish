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
import type { PublicationServiceStatus } from '../application';
import type { ScanIssue } from '../content/site-scanner';
import type {
  PublishCenterArticle,
  PublishCenterState,
} from '../publication/publish-center';
import type { SetupDraft } from '../setup/site-setup';
import type {
  SetupAccount,
  SetupProject,
  SetupReview,
} from '../setup/site-setup';

export const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

type PublishCenterTab = 'changes' | 'all' | 'unpublished' | 'issues';

export class PagesPublishView extends ItemView {
  private activeTab: PublishCenterTab = 'changes';
  private selectedSourcePath: string | undefined;
  private setupStep = 0;
  private setupDraft: SetupDraft | undefined;
  private setupAccounts: SetupAccount[] | undefined;
  private setupProjects: SetupProject[] | undefined;
  private setupReview: SetupReview | undefined;
  private unsubscribePublicationStatus: (() => void) | undefined;
  private lastPublishCenter: PublishCenterState | undefined;

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
    if (this.application.isPublicationAvailable()) {
      this.unsubscribePublicationStatus = this.application.subscribePublicationStatus(() => {
        void this.render();
      });
    }
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribePublicationStatus?.();
    this.unsubscribePublicationStatus = undefined;
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    container.createDiv({ cls: 'pages-publish-view__eyebrow', text: '发布工具' });

    const target = await this.application.getLaunchTarget();
    if (target === 'setup') {
      this.lastPublishCenter = undefined;
      await this.renderSetupWizard(container);
      return;
    }

    const publication = this.application.getPublicationStatus();
    if (publication.state === 'running') {
      if (this.lastPublishCenter) {
        this.renderPublishCenter(container, this.lastPublishCenter);
      } else {
        this.renderPublishingWithoutScan(container, publication);
      }
      return;
    }

    try {
      const center = await this.application.getPublishCenter();
      this.lastPublishCenter = center;
      this.renderPublishCenter(container, center);
    } catch (error) {
      container.createEl('h2', { text: '无法读取发布配置' });
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: errorMessage(error),
      });
    }
  }

  private renderPublishingWithoutScan(
    container: HTMLElement,
    status: Extract<PublicationServiceStatus, { state: 'running' }>,
  ): void {
    container.createDiv({ cls: 'pages-publish-view__type', text: '发布中心' });
    container.createEl('h2', { text: '发布进行中' });
    this.renderPublicationStatus(container, status);
    container.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: '任务继续在后台运行。为避免影响当前发布，本次不会重新扫描 vault；完成后会自动刷新结果。',
    });
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
    const publication = this.application.getPublicationStatus();
    this.renderPublicationStatus(container, publication);
    new ButtonComponent(actions).setButtonText('预览站点').onClick(async () => {
      try {
        await this.application.openPreview();
        new Notice('本地预览已打开。');
      } catch (error) {
        new Notice(`无法打开本地预览：${errorMessage(error)}`);
      }
    });
    new ButtonComponent(actions)
      .setButtonText(publishButtonLabel(center.canPublish, publication))
      .setCta()
      .setDisabled(
        !center.canPublish ||
          publication.state === 'unavailable' ||
          publication.state === 'running' ||
          publication.state === 'reconciliation-required',
      )
      .onClick(async () => {
        try {
          const deployment = await this.application.publishSite();
          new Notice(`发布成功：${deployment.output.fileCount} 个文件已激活。后续编辑将进入下一次变化。`);
        } catch (error) {
          new Notice(`发布失败：${errorMessage(error)}`);
        } finally {
          await this.render();
        }
      });
  }

  private renderPublicationStatus(
    container: HTMLElement,
    status: PublicationServiceStatus,
  ): void {
    if (status.state === 'idle' || status.state === 'unavailable') return;
    const element = container.createEl('p', {
      cls: status.state === 'failed' || status.state === 'reconciliation-required'
        ? 'pages-publish-view__error'
        : 'pages-publish-view__summary',
      text: publicationStatusText(status),
    });
    if (status.state === 'running') {
      element.createSpan({
        text: ` 准备${status.stage === 'prepare' ? ' ●' : ' ✓'} → 构建与检查${status.stage === 'build' ? ' ●' : status.stage === 'prepare' ? '' : ' ✓'} → 上传${status.stage === 'upload' ? ' ●' : status.stage === 'activate' ? ' ✓' : ''} → 激活${status.stage === 'activate' ? ' ●' : ''}`,
      });
    }
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

  private async renderSetupWizard(container: HTMLElement): Promise<void> {
    let connection;
    try {
      connection = await this.application.getInitialSetupConnection();
    } catch {
      connection = { state: 'unavailable' as const };
    }
    const connectedAccount = 'account' in connection ? connection.account : undefined;
    const draft = this.setupDraft ??= this.newSetupDraft(connectedAccount);
    if (!draft.cloudflare.account.id && connectedAccount) {
      draft.cloudflare.account = connectedAccount;
    }
    const setupAvailable = this.application.isInitialSetupAvailable()
      && connection.state === 'connected'
      && Boolean(draft.cloudflare.account.id);
    container.createDiv({ cls: 'pages-publish-view__type', text: '首次设置' });
    container.createEl('h2', { text: '创建你的发布站点' });
    container.createEl('p', {
      text: '草稿只保留在此向导中。只有最后确认才会写入 .publish/site.yml 或修改 Cloudflare 项目；不会发布文章或修改 Frontmatter。',
    });
    const progress = container.createDiv({ cls: 'pages-publish-view__setup-progress' });
    for (const [index, label] of [
      '环境准备',
      '1 站点信息',
      '2 内容范围',
      '3 Cloudflare',
      '4 确认',
    ].entries()) {
      progress.createSpan({
        cls: index === this.setupStep ? 'is-active' : index < this.setupStep ? 'is-complete' : '',
        text: label,
      });
    }

    if (this.setupStep === 0) {
      container.createEl('h3', { text: '准备本地发布环境' });
      container.createEl('p', {
        text: setupAvailable
          ? '环境与 Cloudflare 适配器已就绪。继续填写站点计划。'
          : '环境与 Cloudflare 连接尚未就绪，因此不会启用最终创建操作。你仍可查看和编辑本地草稿。',
      });
      if (!setupAvailable) {
        container.createEl('p', {
          cls: 'pages-publish-view__warning',
          text: '需要完成受管理运行时和已连接 cloudflare 账号的接线后，才能创建或绑定远端项目。',
        });
      }
    } else if (this.setupStep === 1) {
      container.createEl('h3', { text: '站点信息' });
      new Setting(container).setName('站点名称').setDesc('必填；支持中文，不决定域名。').addText((text) =>
        text.setValue(draft.config.site.name).onChange((value) => {
          draft.config.site.name = value;
        }),
      );
      new Setting(container).setName('站点简介').setDesc('可选，最多 160 个字符。').addTextArea((text) =>
        text.setValue(draft.config.site.description ?? '').onChange((value) => {
          draft.config.site.description = value || undefined;
        }),
      );
    } else if (this.setupStep === 2) {
      container.createEl('h3', { text: '内容范围' });
      const root = draft.config.contentRoots[0];
      if (!root) throw new Error('Setup draft must have one content root.');
      const scopeWarning = container.createEl('p', { cls: 'pages-publish-view__warning' });
      new Setting(container).setName('内容目录').setDesc('只有其中的 Markdown 会成为候选。').addText((text) =>
        text.setValue(root.path).onChange((value) => {
          root.path = value;
          this.setupReview = undefined;
          scopeWarning.setText(
            value.trim() === '.'
              ? '警告：选择 Vault 根会把整个 Vault 的 Markdown 纳入候选范围。'
              : '',
          );
        }),
      );
      new Setting(container).setName('公开路径').setDesc('必须以 / 开始。').addText((text) =>
        text.setValue(root.publicRoot).onChange((value) => {
          root.publicRoot = value;
          this.setupReview = undefined;
        }),
      );
      container.createEl('p', {
        text: '继续前会以此草稿进行本地扫描；扫描不会写入 site.yml。',
      });
      if (this.setupReview) {
        container.createEl('p', {
          cls: 'pages-publish-view__summary',
          text: `草稿扫描：找到 ${this.setupReview.candidateCount} 篇候选，其中 ${this.setupReview.eligibleCount} 篇当前无 Blocker。`,
        });
      }
    } else if (this.setupStep === 3) {
      container.createEl('h3', { text: 'Cloudflare' });
      container.createEl('p', {
        text: setupAvailable
          ? `将使用已连接账号：${draft.cloudflare.account.name}。`
          : '尚未连接 Cloudflare。OAuth 或高级 API Token 连接成功后，这里会显示账号和可用 Pages 项目。',
      });
      if (connection.state === 'expired') {
        container.createEl('p', {
          cls: 'pages-publish-view__warning',
          text: 'Cloudflare 授权已过期；重新授权后才能创建或绑定项目。',
        });
      }
      if (setupAvailable) {
        await this.renderSetupAccounts(container, draft);
        await this.renderSetupProjects(container, draft);
      }
      new Setting(container).setName('Pages 项目标识').setDesc('创建或绑定计划；最终确认前不调用远端。').addText((text) =>
        text.setValue(draft.cloudflare.projectName).onChange((value) => {
          draft.cloudflare.projectName = value;
          draft.config.cloudflare.projectName = value;
          this.setupProjects = undefined;
        }),
      );
      const projectActions = container.createDiv({ cls: 'pages-publish-view__setup-options' });
      new ButtonComponent(projectActions)
        .setButtonText(draft.cloudflare.action === 'create' ? '● 创建新项目' : '○ 创建新项目')
        .onClick(async () => {
          draft.cloudflare.action = 'create';
          await this.render();
        });
      new ButtonComponent(projectActions)
        .setButtonText(draft.cloudflare.action === 'bind' ? '● 绑定已有项目' : '○ 绑定已有项目')
        .onClick(async () => {
          draft.cloudflare.action = 'bind';
          await this.render();
        });
      container.createEl('p', { text: `默认域名：${draft.cloudflare.projectName}.pages.dev` });
      const domainActions = container.createDiv({ cls: 'pages-publish-view__setup-options' });
      new ButtonComponent(domainActions)
        .setButtonText(draft.cloudflare.domain.kind === 'pages-dev' ? '● 使用 pages.dev' : '○ 使用 pages.dev')
        .onClick(async () => {
          draft.cloudflare.domain = { kind: 'pages-dev' };
          await this.render();
        });
      new ButtonComponent(domainActions)
        .setButtonText(draft.cloudflare.domain.kind === 'custom' ? '● 连接自定义域名' : '○ 连接自定义域名')
        .onClick(async () => {
          draft.cloudflare.domain = { kind: 'custom', hostname: '' };
          await this.render();
        });
      if (draft.cloudflare.domain.kind === 'custom') {
        const customDomain = draft.cloudflare.domain;
        new Setting(container).setName('自定义域名').setDesc('最终确认后请求绑定；可显示待验证、有效或失败。').addText((text) =>
          text.setValue(customDomain.hostname).onChange((value) => {
            customDomain.hostname = value;
          }),
        );
      }
    } else {
      container.createEl('h3', { text: '确认创建站点' });
      const summary = container.createEl('ul', { cls: 'pages-publish-view__setup-summary' });
      summary.createEl('li', { text: `站点：${draft.config.site.name || '未命名站点'}` });
      summary.createEl('li', {
        text: `内容范围：${draft.config.contentRoots.map((root) => `${root.path} → ${root.publicRoot}`).join('；')}`,
      });
      summary.createEl('li', {
        text: `Cloudflare：${draft.cloudflare.action === 'create' ? '创建' : '绑定'}项目 ${draft.cloudflare.projectName}`,
      });
      container.createEl('p', { text: '将执行：验证草稿、创建或验证 pages 项目、写入正式配置、扫描候选。' });
      container.createEl('p', { text: '不会执行：发布文章、修改文章 frontmatter。' });
    }

    const actions = container.createDiv({ cls: 'pages-publish-view__actions' });
    new ButtonComponent(actions)
      .setButtonText('返回')
      .setDisabled(this.setupStep === 0)
      .onClick(async () => {
        this.setupStep = Math.max(0, this.setupStep - 1);
        await this.render();
      });
    if (this.setupStep < 4) {
      new ButtonComponent(actions)
        .setButtonText('继续')
        .setCta()
        .onClick(async () => {
          if (this.setupStep === 2 && setupAvailable) {
            try {
              this.setupReview = await this.application.reviewInitialSetup(draft);
            } catch (error) {
              new Notice(`无法扫描设置草稿：${errorMessage(error)}`);
              return;
            }
          }
          this.setupStep += 1;
          await this.render();
        });
      return;
    }
    new ButtonComponent(actions)
      .setButtonText(setupAvailable ? '创建站点并开始扫描' : '创建站点（需要完成连接）')
      .setCta()
      .setDisabled(!setupAvailable || !draft.cloudflare.account.id)
      .onClick(async () => {
        try {
          const review = await this.application.reviewInitialSetup(draft);
          const result = await this.application.confirmInitialSetup(draft);
          const domain = 'url' in result.domain
            ? result.domain.url
            : result.domain.status === 'pending'
              ? '自定义域名正在等待验证。'
              : '自定义域名已生效。';
          new Notice(`站点已创建；找到 ${result.scan.candidateCount} 篇候选，其中 ${review.eligibleCount} 篇可加入首次发布。${domain} 没有发布任何文章。`);
          await this.render();
        } catch (error) {
          new Notice(`无法创建站点：${errorMessage(error)}`);
        }
      });
  }

  private async renderSetupAccounts(
    container: HTMLElement,
    draft: SetupDraft,
  ): Promise<void> {
    try {
      this.setupAccounts ??= await this.application.listInitialSetupAccounts();
    } catch (error) {
      container.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: `无法读取可用账号：${errorMessage(error)}`,
      });
      return;
    }
    const accountActions = container.createDiv({ cls: 'pages-publish-view__setup-options' });
    for (const account of this.setupAccounts) {
      new ButtonComponent(accountActions)
        .setButtonText(account.id === draft.cloudflare.account.id ? `● ${account.name}` : `○ ${account.name}`)
        .onClick(async () => {
          draft.cloudflare.account = account;
          this.setupProjects = undefined;
          await this.render();
        });
    }
  }

  private async renderSetupProjects(
    container: HTMLElement,
    draft: SetupDraft,
  ): Promise<void> {
    try {
      this.setupProjects ??= await this.application.listInitialSetupProjects(
        draft.cloudflare.account,
      );
    } catch (error) {
      container.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: `无法读取已有项目：${errorMessage(error)}`,
      });
      return;
    }
    if (this.setupProjects.length === 0) return;
    const projectActions = container.createDiv({ cls: 'pages-publish-view__setup-options' });
    projectActions.createSpan({ text: '可绑定项目：' });
    for (const project of this.setupProjects) {
      new ButtonComponent(projectActions)
        .setButtonText(`${project.compatible ? '' : '不兼容 · '}${project.name}`)
        .setDisabled(!project.compatible)
        .onClick(async () => {
          draft.cloudflare.action = 'bind';
          draft.cloudflare.projectName = project.name;
          draft.config.cloudflare.projectName = project.name;
          await this.render();
        });
    }
  }

  private newSetupDraft(account?: SetupAccount): SetupDraft {
    const vaultName = this.app.vault.getName();
    const projectName = projectNameFrom(vaultName);
    return {
      config: {
        version: 1,
        site: { name: vaultName, homeLayout: 'sections' },
        contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
        assets: { exclude: [] },
        features: { search: true, graph: true },
        cloudflare: { projectName },
      },
      cloudflare: {
        account: account ?? { id: '', name: '尚未连接' },
        action: 'create',
        projectName,
        domain: { kind: 'pages-dev' },
      },
    };
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

function publishButtonLabel(
  canPublish: boolean,
  status: PublicationServiceStatus,
): string {
  if (!canPublish) return '发布站点（不可用）';
  if (status.state === 'unavailable') return '发布站点（需要连接）';
  if (status.state === 'running') return '发布中';
  if (status.state === 'reconciliation-required') return '本地同步待修复';
  if (status.state === 'failed') return '重试发布';
  return '发布站点';
}

function publicationStatusText(status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>): string {
  if (status.state === 'running') {
    return `发布中：${publicationStageLabel(status.stage)}（第 ${publicationStageNumber(status.stage)}/4 阶段）`;
  }
  if (status.state === 'succeeded') {
    return `发布成功：${status.deployment.output.fileCount} 个文件已激活。`;
  }
  if (status.state === 'reconciliation-required') {
    return `线上发布成功，但本地事实待协调：${status.message}`;
  }
  return `发布失败：${status.message}`;
}

function publicationStageLabel(stage: 'prepare' | 'build' | 'upload' | 'activate'): string {
  const labels = {
    prepare: '准备',
    build: '构建与检查',
    upload: '上传',
    activate: '激活',
  } as const;
  return labels[stage];
}

function publicationStageNumber(stage: 'prepare' | 'build' | 'upload' | 'activate'): number {
  return ['prepare', 'build', 'upload', 'activate'].indexOf(stage) + 1;
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
