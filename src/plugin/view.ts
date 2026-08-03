import {
  ButtonComponent,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Setting,
  setIcon,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import type {
  InitialSetupConnection,
  PagesPublishApplication,
} from '../application';
import type { PublicationServiceStatus } from '../application';
import type { ScanIssue } from '../content/site-scanner';
import type {
  PublishCenterArticle,
  PublishCenterState,
} from '../publication/publish-center';
import type { CurrentArticlePanelArticle } from '../publication/current-article-panel';
import { openPluginSettingsInHost } from './settings-navigation';
import { openSiteConfigForRepair } from './site-config-repair-view';
import type { SetupDraft } from '../setup/site-setup';
import type {
  SetupAccount,
  SetupProject,
  SetupProgressStage,
  SetupReview,
} from '../setup/site-setup';

export const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

type PublishCenterTab = 'changes' | 'all' | 'unpublished' | 'issues';
type PublishCenterFilter = 'all' | 'public' | 'unlisted' | 'private' | 'blocker' | 'warning';

type SetupExecutionState =
  | { state: 'running'; stage: SetupProgressStage; draft: SetupDraft }
  | { state: 'success'; candidateCount: number; eligibleCount: number; domain: string }
  | { state: 'failed'; stage: SetupProgressStage; draft: SetupDraft; message: string };

export class PagesPublishView extends ItemView {
  private activeTab: PublishCenterTab = 'changes';
  private articleFilter: PublishCenterFilter = 'all';
  private selectedSourcePath: string | undefined;
  private selectedArticleDetail: CurrentArticlePanelArticle | undefined;
  private focusReviewOnRender = false;
  private focusArticleOnRender: string | undefined;
  private focusTabOnRender: PublishCenterTab | undefined;
  private focusSearchOnRender = false;
  private focusFilterOnRender = false;
  private articleSearchQuery = '';
  private setupStep = 0;
  private setupDraft: SetupDraft | undefined;
  private setupAccounts: SetupAccount[] | undefined;
  private setupProjects: SetupProject[] | undefined;
  private setupReview: SetupReview | undefined;
  private setupProjectAvailability: { name: string; available: boolean } | undefined;
  private setupVaultRootConfirmed = false;
  private setupExecution: SetupExecutionState | undefined;
  private showEnvironmentDetails = false;
  private focusSetupHeadingOnRender = false;
  private unsubscribePublicationStatus: (() => void) | undefined;
  private unsubscribeGlobalUiState: (() => void) | undefined;
  private lastPublishCenter: PublishCenterState | undefined;
  private lastPublishConnection: InitialSetupConnection = { state: 'unavailable' };
  private lastLaunchTarget: 'setup' | 'publish-center' | undefined;
  private activeRender: Promise<void> | undefined;
  private renderAgain = false;
  private refreshPublishCenterInFlight = false;
  private sitePreviewInFlight: Promise<void> | undefined;

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

  getState(): Record<string, unknown> {
    return { tab: this.activeTab, filter: this.articleFilter };
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const tab = recordValue(state)?.tab;
    if (isPublishCenterTab(tab)) this.activeTab = tab;
    const filter = recordValue(state)?.filter;
    if (isPublishCenterFilter(filter)) this.articleFilter = filter;
  }

  async onOpen(): Promise<void> {
    this.unsubscribeGlobalUiState = this.application.subscribeGlobalUiState?.(() => {
      // A configured publish-center render starts scans, and scan lifecycle
      // notifications are delivered through this same subscription. Queuing a
      // second full render here would make each scan start another scan forever.
      // Setup notifications remain coalesced because environment/OAuth changes
      // can materially advance the wizard while it is already rendering.
      if (
        this.lastLaunchTarget === 'publish-center'
        && (this.activeRender || this.refreshPublishCenterInFlight)
      ) return;
      void this.render();
    });
    if (this.application.isPublicationAvailable()) {
      this.unsubscribePublicationStatus = this.application.subscribePublicationStatus(() => {
        void this.render();
      });
    }
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.setupDraft) this.application.preserveInitialSetupDraft?.(this.setupDraft);
    this.unsubscribePublicationStatus?.();
    this.unsubscribePublicationStatus = undefined;
    this.unsubscribeGlobalUiState?.();
    this.unsubscribeGlobalUiState = undefined;
  }

  private render(): Promise<void> {
    if (this.activeRender) {
      this.renderAgain = true;
      return this.activeRender;
    }
    const operation = this.renderUntilSettled();
    this.activeRender = operation;
    void operation.finally(() => {
      if (this.activeRender === operation) this.activeRender = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async renderUntilSettled(): Promise<void> {
    do {
      this.renderAgain = false;
      await this.renderOnce();
    } while (this.renderAgain);
  }

  private async renderOnce(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    container.createDiv({ cls: 'pages-publish-view__eyebrow', text: '发布工具' });

    if (this.setupExecution) {
      this.renderSetupExecution(container, this.setupExecution);
      return;
    }

    const target = await this.application.getLaunchTarget();
    this.lastLaunchTarget = target;
    if (target === 'setup') {
      this.lastPublishCenter = undefined;
      await this.renderSetupWizard(container);
      return;
    }

    const publication = this.application.getPublicationStatus();
    if (publication.state === 'running') {
      if (this.lastPublishCenter) {
        this.renderPublishCenter(container, this.lastPublishCenter, this.lastPublishConnection);
      } else {
        this.renderPublishingWithoutScan(container, publication);
      }
      return;
    }

    try {
      this.renderLoadingPublishCenter(container);
      const [center, connection] = await Promise.all([
        this.application.getPublishCenter(),
        this.application.getInitialSetupConnection().catch(
          (): InitialSetupConnection => ({ state: 'unavailable' }),
        ),
      ]);
      this.lastPublishCenter = center;
      this.lastPublishConnection = connection;
      this.renderCachedPublishCenter();
    } catch (error) {
      container.createEl('h2', { text: '无法读取发布配置' });
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: errorMessage(error),
      });
    }
  }

  private renderLoadingPublishCenter(container: HTMLElement): void {
    container.createDiv({ cls: 'pages-publish-view__type', text: '发布中心' });
    container.createEl('h2', { text: '正在加载发布中心' });
    container.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: '正在读取发布内容；Cloudflare 状态将在后台检查。',
    });
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
      text: '任务继续在后台运行。为避免影响当前发布，本次不会重新扫描 Vault；完成后会自动刷新结果。',
    });
  }

  private renderCachedPublishCenter(): void {
    if (!this.lastPublishCenter) return;
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    container.createDiv({ cls: 'pages-publish-view__eyebrow', text: '发布工具' });
    this.renderPublishCenter(container, this.lastPublishCenter, this.lastPublishConnection);
  }

  private async refreshPublishCenter(options: {
    content?: boolean;
    connection?: boolean;
  }): Promise<void> {
    if (this.refreshPublishCenterInFlight) return;
    this.refreshPublishCenterInFlight = true;
    try {
      const [center, connection] = await Promise.all([
        options.content
          ? this.application.getPublishCenter({ forceRefresh: true })
          : Promise.resolve(this.lastPublishCenter),
        options.connection
          ? this.application.getInitialSetupConnection({ forceRefresh: true })
          : Promise.resolve(this.lastPublishConnection),
      ]);
      if (center) this.lastPublishCenter = center;
      this.lastPublishConnection = connection;
      this.renderCachedPublishCenter();
    } catch (error) {
      new Notice(`无法检查发布状态：${errorMessage(error)}`);
    } finally {
      this.refreshPublishCenterInFlight = false;
    }
  }

  private renderPublishCenter(
    container: HTMLElement,
    center: PublishCenterState,
    connection: InitialSetupConnection = { state: 'unavailable' },
  ): void {
    const pageHeader = container.createDiv({ cls: 'pages-publish-view__page-header' });
    const headerContent = pageHeader.createDiv({ cls: 'pages-publish-view__header-content' });
    headerContent.createDiv({ cls: 'pages-publish-view__type', text: '发布中心' });
    headerContent.createEl('h2', { text: center.siteName });
    const publishedSiteUrl = center.lastPublishedAt ? center.siteUrl : undefined;
    const identity = headerContent.createDiv({ cls: 'pages-publish-view__identity' });
    identity.createSpan({
      cls: 'pages-publish-view__site-url',
      text: publishedSiteUrl ?? '尚无已确认成功的线上站点',
    });
    const connectionState = connection.state === 'connected'
      ? 'connected'
      : connection.state === 'expired' || connection.state === 'disconnected'
        ? 'attention'
        : 'unknown';
    const connectionIdentity = identity.createSpan({
      cls: `pages-publish-view__connection pages-publish-view__connection--${connectionState}`,
    });
    connectionIdentity.createSpan({
      cls: 'pages-publish-view__connection-dot',
      attr: { 'aria-hidden': 'true' },
    });
    connectionIdentity.createSpan({
      text: connection.state === 'connected'
        ? `Cloudflare 已连接${connection.account ? `：${connection.account.name}` : ''}`
        : connection.state === 'expired'
          ? 'Cloudflare 授权已失效'
          : connection.state === 'disconnected'
            ? 'Cloudflare 尚未连接'
            : 'Cloudflare 状态不可用',
    });
    identity.createSpan({
      cls: 'pages-publish-view__published-at',
      text: center.lastPublishedAt
        ? `上次发布 ${new Date(center.lastPublishedAt).toLocaleString()}`
        : '从未成功发布',
    });
    const headerActions = pageHeader.createDiv({ cls: 'pages-publish-view__header-actions' });
    new ButtonComponent(headerActions)
      .setIcon('external-link')
      .setButtonText('打开站点')
      .setDisabled(!publishedSiteUrl)
      .onClick(async () => {
        try {
          await this.application.openPublishedSite();
        } catch (error) {
          new Notice(`无法打开线上站点：${errorMessage(error)}`);
        }
      });
    const moreActions = new ButtonComponent(headerActions)
      .setIcon('ellipsis')
      .setTooltip('更多操作')
      .onClick((event) => {
        const menu = new Menu();
        menu.addItem((item) => item
          .setTitle('打开配置文件')
          .setIcon('file-code-2')
          .onClick(async () => {
            await openSiteConfigForRepair({ workspace: this.app.workspace });
          }));
        menu.addItem((item) => item
          .setTitle('打开设置')
          .setIcon('settings')
          .onClick(() => {
            if (!openPluginSettingsInHost(this.app, 'pages-publish')) {
              new Notice('无法自动打开插件设置；请从 Obsidian 设置中选择 Pages Publish。');
            }
          }));
        menu.showAtMouseEvent(event);
      });
    moreActions.buttonEl.setAttribute('aria-label', '更多操作');
    headerContent.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: center.output.status === 'unknown'
        ? '当前问题阻止了完整输出估算；修复后重新扫描即可恢复发布报告。'
        : center.baseline === 'unknown'
          ? `最近部署清单不可用；仍将完整构建 ${center.output.fileCount} 个文件。`
        : `自上次发布以来 ${center.summary.changes} 项变化 · ${center.output.fileCount} 个输出文件`,
    });

    const scanBar = container.createDiv({ cls: 'pages-publish-view__scan' });
    const scanSummary = scanBar.createDiv({ cls: 'pages-publish-view__scan-summary' });
    scanSummary.createEl('strong', { text: `${center.summary.changes} 项变化` });
    scanSummary.createSpan({
      text: center.lastPublishedAt
        ? `基于 ${new Date(center.lastPublishedAt).toLocaleTimeString()}`
        : '等待首次发布',
    });
    const scanMetrics = scanBar.createDiv({ cls: 'pages-publish-view__scan-metrics' });
    for (const metric of [
      { text: `+${center.summary.added} 新增`, icon: 'circle-plus', tab: 'changes' as const, tone: 'success' },
      { text: `~${center.summary.updated} 更新`, icon: 'refresh-cw', tab: 'changes' as const, tone: 'accent' },
      { text: `-${center.summary.takedowns} 待下线`, icon: 'arrow-down-to-line', tab: 'changes' as const, tone: 'warning' },
      { text: `${center.summary.blockers} 阻塞`, icon: 'circle-x', tab: 'issues' as const, tone: 'danger' },
      { text: `${center.summary.warnings} 警告`, icon: 'triangle-alert', tab: 'issues' as const, tone: 'warning' },
    ]) {
      new ButtonComponent(scanMetrics)
        .setIcon(metric.icon)
        .setButtonText(metric.text)
        .setClass('pages-publish-view__metric')
        .setClass(`pages-publish-view__metric--${metric.tone}`)
        .onClick(() => {
          this.activateTab(metric.tab);
        });
    }
    const scanActions = scanBar.createDiv({ cls: 'pages-publish-view__scan-actions' });
    new ButtonComponent(scanActions).setIcon('refresh-cw').setButtonText('重新扫描').onClick(async () => {
      await this.refreshPublishCenter({ content: true });
    });
    new ButtonComponent(scanActions).setIcon('cloud').setButtonText('检查 Cloudflare').onClick(async () => {
      await this.refreshPublishCenter({ connection: true });
    });
    if (!center.canPublish) {
      const blocker = center.issues.find((issue) => issue.severity === 'blocker');
      const callout = container.createDiv({
        cls: 'pages-publish-view__callout pages-publish-view__callout--danger',
      });
      const message = callout.createDiv({ cls: 'pages-publish-view__callout-message' });
      const icon = message.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'circle-x');
      message.createEl('p', {
        text: `发布被阻塞：${blocker?.message ?? '修复所有阻塞问题后重试。'}`,
      });
      new ButtonComponent(callout).setButtonText('查看问题').onClick(() => {
        this.activateTab('issues');
      });
    }
    const connectionBlocksPublishing = connection.state === 'expired'
      || connection.state === 'disconnected';
    if (connectionBlocksPublishing) {
      const warning = container.createDiv({
        cls: 'pages-publish-view__callout pages-publish-view__callout--danger',
      });
      const message = warning.createDiv({ cls: 'pages-publish-view__callout-message' });
      const icon = message.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'cloud-off');
      message.createEl('p', {
        text: connection.state === 'expired'
          ? 'Cloudflare 授权已失效；本地编辑仍可用，重新授权前不会开始发布。'
          : 'Cloudflare 尚未连接；本地编辑仍可用，连接账号前不会开始发布。',
      });
      if (this.application.canConnectInitialSetupOAuth()) {
        new ButtonComponent(warning)
          .setButtonText('重新授权')
          .onClick(async () => {
            try {
              await this.application.beginInitialSetupOAuth();
              new Notice('已在浏览器打开 Cloudflare 授权；完成后将返回 Obsidian。');
            } catch (error) {
              new Notice(`无法开始 Cloudflare 授权：${errorMessage(error)}`);
            }
          });
      }
    }

    const tabs = container.createDiv({ cls: 'pages-publish-view__tabs' });
    const tabList = tabs.createDiv({ cls: 'pages-publish-view__tab-list', attr: { role: 'tablist' } });
    const tabDefinitions: Array<{ id: PublishCenterTab; text: string; count: number }> = [
      { id: 'changes', text: '当前变化', count: center.summary.changes },
      { id: 'all', text: '全部内容', count: center.articles.length },
      { id: 'unpublished', text: '未发布', count: center.summary.added },
      { id: 'issues', text: '问题', count: center.issues.length },
    ];
    for (const tab of tabDefinitions) {
      const button = new ButtonComponent(tabList).setClass('pages-publish-view__tab');
      button.buttonEl.setAttr('role', 'tab');
      button.buttonEl.setAttr('aria-label', `${tab.text} ${tab.count}`);
      button.buttonEl.createSpan({ cls: 'pages-publish-view__tab-label', text: tab.text });
      button.buttonEl.createSpan({ cls: 'pages-publish-view__tab-count', text: String(tab.count) });
      if (this.activeTab === tab.id) button.setClass('is-active');
      button.onClick(() => {
        this.activateTab(tab.id);
      });
      if (this.focusTabOnRender === tab.id) {
        this.focusTabOnRender = undefined;
        button.buttonEl.focus();
      }
    }
    const controls = tabs.createDiv({ cls: 'pages-publish-view__tab-controls' });
    const searchControl = controls.createDiv({ cls: 'pages-publish-view__search-control' });
    const searchIcon = searchControl.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(searchIcon, 'search');
    const search = searchControl.createEl('input', {
      type: 'search',
      attr: { 'aria-label': '搜索文章或路径', placeholder: '搜索文章或路径' },
    });
    search.value = this.articleSearchQuery;
    if (this.focusSearchOnRender) {
      this.focusSearchOnRender = false;
      search.focus();
    }
    const filterControl = controls.createDiv({ cls: 'pages-publish-view__filter-control' });
    const filterIcon = filterControl.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(filterIcon, 'list-filter');
    const filter = filterControl.createEl('select', {
      cls: 'pages-publish-view__filter',
      attr: { 'aria-label': '筛选文章' },
    });
    for (const option of [
      { value: 'all', label: '筛选：全部' },
      { value: 'public', label: '公开' },
      { value: 'unlisted', label: '不列出' },
      { value: 'private', label: '私密' },
      { value: 'blocker', label: '有阻塞' },
      { value: 'warning', label: '有警告' },
    ] as const) {
      filter.createEl('option', { attr: { value: option.value }, text: option.label });
    }
    filter.value = this.articleFilter;
    if (this.focusFilterOnRender) {
      this.focusFilterOnRender = false;
      filter.focus();
    }
    filter.addEventListener('change', () => {
      if (!isPublishCenterFilter(filter.value)) return;
      this.articleFilter = filter.value;
      this.selectedSourcePath = undefined;
      this.selectedArticleDetail = undefined;
      this.focusArticleOnRender = undefined;
      this.focusFilterOnRender = true;
      this.renderCachedPublishCenter();
    });

    const scopedArticles = center.articles.filter(
      (article) => this.matchesTab(article) && this.matchesFilter(article),
    );
    const selected = scopedArticles.find(
      (article) => article.sourcePath === this.selectedSourcePath
        && this.matchesSearch(article),
    );
    if (this.selectedSourcePath && !selected) {
      this.selectedSourcePath = undefined;
      this.selectedArticleDetail = undefined;
      this.focusArticleOnRender = undefined;
    }
    const workspace = container.createDiv({
      cls: `pages-publish-view__workspace${selected ? ' has-review' : ''}`,
    });
    const list = workspace.createDiv({ cls: 'pages-publish-view__list' });
    const table = list.createEl('table', { cls: 'pages-publish-view__articles' });
    const colgroup = table.createEl('colgroup');
    for (const column of ['selection', 'article', 'visibility', 'change', 'check', 'menu']) {
      colgroup.createEl('col', { cls: `pages-publish-view__column--${column}` });
    }
    const header = table.createEl('thead').createEl('tr');
    for (const label of ['上线', '文章 / 路径', '公开方式', '状态变化', '检查']) {
      header.createEl('th', { attr: { scope: 'col' }, text: label });
    }
    header.createEl('th', { attr: { scope: 'col', 'aria-label': '行操作' } });
    const body = table.createEl('tbody');
    const searchableRows: Array<{ row: HTMLTableRowElement; text: string }> = [];
    for (const article of scopedArticles) {
      const row = body.createEl('tr');
      if (selected?.sourcePath === article.sourcePath) row.addClass('is-selected');
      searchableRows.push({ row, text: `${article.title}\n${article.sourcePath}`.toLocaleLowerCase() });
      row.addEventListener('click', (event) => {
        if (event.target instanceof HTMLInputElement) return;
        void this.selectArticle(article);
      });
      const selection = row.createEl('td', { attr: { 'data-label': '下一版包含' } });
      const checkbox = selection.createEl('input', { type: 'checkbox' });
      checkbox.checked = article.nextIncluded;
      checkbox.disabled = article.availability !== 'ready';
      checkbox.setAttr('aria-label', `下一版包含 ${article.title}`);
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        void this.updateInclusion(article, checkbox.checked);
      });
      const title = row.createEl('td', {
        cls: 'pages-publish-view__article-cell',
        attr: { 'data-label': '文章 / 路径' },
      });
      const fileIcon = title.createSpan({
        cls: 'pages-publish-view__article-icon',
        attr: { 'aria-hidden': 'true' },
      });
      setIcon(fileIcon, 'file-text');
      const articleInfo = title.createDiv({ cls: 'pages-publish-view__article-info' });
      const reviewButton = new ButtonComponent(articleInfo)
        .setButtonText(article.title)
        .setTooltip(`审阅 ${article.title}`)
        .onClick(() => this.selectArticle(article));
      if (this.focusArticleOnRender === article.sourcePath) {
        this.focusArticleOnRender = undefined;
        reviewButton.buttonEl.focus();
      }
      articleInfo.createEl('code', { text: article.sourcePath });
      const visibility = row.createEl('td', {
        cls: `pages-publish-view__visibility pages-publish-view__visibility--${article.visibility}`,
        attr: { 'data-label': '公开方式' },
      });
      const visibilityIcon = visibility.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(visibilityIcon, visibilityIconName(article.visibility));
      visibility.createSpan({ text: visibilityLabel(article.visibility) });
      const change = row.createEl('td', {
        cls: `pages-publish-view__change pages-publish-view__change--${article.change}`,
        attr: { 'data-label': '状态变化' },
      });
      const changeIcon = change.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(changeIcon, changeIconName(article.change));
      change.createSpan({ text: changeLabel(article.change) });
      const checkTone = article.issues.length === 0
        ? 'passed'
        : article.issues.some((issue) => issue.severity === 'blocker')
          ? 'blocker'
          : 'warning';
      const check = row.createEl('td', {
        cls: article.issues.length === 0
          ? 'pages-publish-view__check pages-publish-view__check--passed'
          : article.issues.some((issue) => issue.severity === 'blocker')
            ? 'pages-publish-view__check pages-publish-view__check--blocker'
            : 'pages-publish-view__check pages-publish-view__check--warning',
        attr: { 'data-label': '检查' },
      });
      const checkIcon = check.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(checkIcon, checkTone === 'passed' ? 'circle-check' : checkTone === 'blocker' ? 'circle-x' : 'triangle-alert');
      check.createSpan({
        text: article.issues.length === 0
          ? '通过'
          : `${checkTone === 'blocker' ? '阻塞' : '警告'} ${article.issues.length}`,
      });
      const rowActions = row.createEl('td', {
        cls: 'pages-publish-view__row-actions',
        attr: { 'data-label': '操作' },
      });
      const reviewAction = new ButtonComponent(rowActions)
        .setIcon('ellipsis')
        .setTooltip(`审阅 ${article.title}`)
        .onClick(() => this.selectArticle(article));
      reviewAction.buttonEl.setAttr('aria-label', `审阅 ${article.title}`);
    }
    const applySearch = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      this.articleSearchQuery = query;
      for (const entry of searchableRows) {
        entry.row.hidden = query.length > 0 && !entry.text.includes(query);
      }
      if (selected && !this.matchesSearch(selected, query)) {
        this.selectedSourcePath = undefined;
        this.selectedArticleDetail = undefined;
        this.focusArticleOnRender = undefined;
        this.focusSearchOnRender = true;
        this.renderCachedPublishCenter();
      }
    };
    search.addEventListener('input', applySearch);
    applySearch();

    if (selected) this.renderReviewDrawer(
      workspace,
      selected,
      this.selectedArticleDetail?.sourcePath === selected.sourcePath
        ? this.selectedArticleDetail
        : undefined,
    );
    if (this.activeTab === 'issues' && center.issues.length > 0) {
      const issues = list.createEl('ul', { cls: 'pages-publish-view__issues' });
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

    const footer = container.createEl('footer', { cls: 'pages-publish-view__footer' });
    const footerStatus = footer.createDiv({ cls: 'pages-publish-view__footer-status' });
    const publication = this.application.getPublicationStatus();
    this.renderPublicationStatus(footerStatus, publication);
    const footerActions = footer.createDiv({ cls: 'pages-publish-view__footer-actions' });
    new ButtonComponent(footerActions)
      .setIcon('eye')
      .setButtonText(this.sitePreviewInFlight ? '正在准备预览…' : '预览站点')
      .setDisabled(this.sitePreviewInFlight !== undefined)
      .onClick(() => this.openSitePreview());
    new ButtonComponent(footerActions)
      .setIcon('cloud-upload')
      .setButtonText(publishButtonLabel(center.canPublish, publication))
      .setCta()
      .setDisabled(
        !center.canPublish ||
          connectionBlocksPublishing ||
          publication.state === 'unavailable' ||
          publication.state === 'running' ||
          publication.state === 'reconciliation-required',
      )
      .onClick(async () => {
        try {
          const currentConnection = await this.application.getInitialSetupConnection();
          if (currentConnection.state !== 'connected') {
            new Notice('Cloudflare 连接已失效；请重新授权或更新 API token 后再发布。');
            await this.render();
            return;
          }
          const deployment = await this.application.publishSite();
          new Notice(`发布成功：${deployment.output.fileCount} 个文件已激活。后续编辑将进入下一次变化。`);
        } catch (error) {
          new Notice(`发布失败：${errorMessage(error)}`);
        } finally {
          await this.render();
        }
      });
  }

  private openSitePreview(): Promise<void> {
    if (this.sitePreviewInFlight) return this.sitePreviewInFlight;
    const operation = this.openSitePreviewExclusive();
    this.sitePreviewInFlight = operation;
    this.renderCachedPublishCenter();
    void operation.finally(() => {
      if (this.sitePreviewInFlight === operation) {
        this.sitePreviewInFlight = undefined;
        this.renderCachedPublishCenter();
      }
    }).catch(() => undefined);
    return operation;
  }

  private async openSitePreviewExclusive(): Promise<void> {
    try {
      await this.application.openPreview();
      new Notice('本地预览已打开。');
    } catch (error) {
      new Notice(`无法打开本地预览：${errorMessage(error)}`);
    }
  }

  private renderPublicationStatus(
    container: HTMLElement,
    status: PublicationServiceStatus,
  ): void {
    if (status.state === 'idle' || status.state === 'unavailable') return;
    const element = container.createEl('section', {
      cls: status.state === 'failed' || status.state === 'reconciliation-required'
        ? `pages-publish-view__publication-status pages-publish-view__publication-status--${status.state} pages-publish-view__error`
        : `pages-publish-view__publication-status pages-publish-view__publication-status--${status.state} pages-publish-view__summary`,
      attr: {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'aria-busy': status.state === 'running' ? 'true' : 'false',
      },
    });
    element.setAttr('data-state', status.state);
    const message = element.createDiv({ cls: 'pages-publish-view__publication-message' });
    const symbol = message.createSpan({
      cls: 'pages-publish-view__publication-symbol',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(symbol, status.state === 'running'
      ? 'loader-circle'
      : status.state === 'succeeded'
        ? 'circle-check'
        : 'circle-x');
    const copy = message.createDiv({ cls: 'pages-publish-view__publication-copy' });
    copy.createEl('strong', { text: publicationStatusLabel(status) });
    copy.createSpan({
      cls: 'pages-publish-view__publication-detail',
      text: publicationStatusDetail(status),
    });
    if (status.state === 'running') {
      const track = element.createEl('ol', {
        cls: 'pages-publish-view__publication-track',
        attr: { 'aria-label': '发布进度' },
      });
      const stages = ['prepare', 'build', 'upload', 'activate'] as const;
      const activeStage = stages.indexOf(status.stage);
      for (const [index, stage] of stages.entries()) {
        const item = track.createEl('li', {
          cls: index < activeStage
            ? 'is-complete'
            : index === activeStage
              ? 'is-active'
              : 'is-upcoming',
        });
        item.setAttr('data-stage', stage);
        if (index === activeStage) item.setAttr('aria-current', 'step');
        const marker = item.createSpan({
          cls: 'pages-publish-view__publication-stage-marker',
          attr: { 'aria-hidden': 'true' },
        });
        setIcon(marker, index < activeStage
          ? 'check'
          : index === activeStage
            ? 'loader-circle'
            : 'circle');
        item.createSpan({
          cls: 'pages-publish-view__publication-stage-label',
          text: publicationStageLabel(stage),
        });
      }
      this.renderPublicationLogAction(element);
    }
    if (status.state === 'succeeded') {
      const actions = element.createDiv({ cls: 'pages-publish-view__publication-actions' });
      new ButtonComponent(actions).setIcon('external-link').setButtonText('打开站点').onClick(async () => {
        try {
          await this.application.openPublishedSite();
        } catch (error) {
          new Notice(`无法打开线上站点：${errorMessage(error)}`);
        }
      });
    }
    if (status.state === 'failed' || status.state === 'reconciliation-required') {
      this.renderPublicationLogAction(element);
    }
    if (status.state === 'reconciliation-required' && status.reconciliation === 'upload-uncertain') {
      const actions = element.createDiv({ cls: 'pages-publish-view__publication-actions' });
      new ButtonComponent(actions)
        .setButtonText('我已在 Cloudflare 核验，解除本地阻塞')
        .setDestructive()
        .onClick(async () => {
          const confirmed = await new Promise<boolean>((resolve) => {
            new UploadUncertainRecoveryModal(this.app, status.target?.projectName, resolve).open();
          });
          if (!confirmed) return;
          try {
            await this.application.acknowledgeUploadUncertainPublication();
            new Notice('已解除本地发布锁。请重新扫描并确认 Cloudflare 的最终状态后再发布。');
          } catch (error) {
            new Notice(`无法解除本地发布锁：${errorMessage(error)}`);
          }
          await this.render();
        });
    }
  }

  private renderPublicationLogAction(container: HTMLElement): void {
    const maintenance = this.application.getMaintenanceStatus?.();
    if (!maintenance || 'state' in maintenance || !maintenance.capabilities.openLogs) return;
    const actions = container.createDiv({ cls: 'pages-publish-view__publication-actions' });
    new ButtonComponent(actions).setIcon('file-clock').setButtonText('查看日志').onClick(async () => {
      try {
        await this.application.openMaintenanceLogs();
      } catch (error) {
        new Notice(`无法打开日志：${errorMessage(error)}`);
      }
    });
  }

  private matchesTab(article: PublishCenterArticle): boolean {
    if (this.activeTab === 'all') return true;
    if (this.activeTab === 'changes') return article.change !== 'unchanged';
    if (this.activeTab === 'unpublished') return article.change === 'added';
    return article.issues.length > 0;
  }

  private activateTab(tab: PublishCenterTab): void {
    this.activeTab = tab;
    this.focusTabOnRender = tab;
    this.renderCachedPublishCenter();
  }

  private matchesFilter(article: PublishCenterArticle): boolean {
    if (this.articleFilter === 'all') return true;
    if (this.articleFilter === 'blocker' || this.articleFilter === 'warning') {
      return article.issues.some((issue) => issue.severity === this.articleFilter);
    }
    return article.visibility === this.articleFilter;
  }

  private matchesSearch(
    article: PublishCenterArticle,
    query = this.articleSearchQuery,
  ): boolean {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return true;
    return `${article.title}\n${article.sourcePath}`.toLocaleLowerCase().includes(normalizedQuery);
  }

  private renderReviewDrawer(
    container: HTMLElement,
    article: PublishCenterArticle,
    detail?: CurrentArticlePanelArticle,
  ): void {
    const drawer = container.createEl('aside', {
      cls: 'pages-publish-view__review',
      attr: { 'aria-label': `审阅 ${article.title}` },
    });
    const header = drawer.createDiv({ cls: 'pages-publish-view__review-header' });
    const articleIdentity = header.createDiv({ cls: 'pages-publish-view__review-identity' });
    const articleIcon = articleIdentity.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(articleIcon, 'file-text');
    const articleCopy = articleIdentity.createDiv();
    articleCopy.createEl('h3', { text: article.title });
    articleCopy.createEl('p', {
      cls: 'pages-publish-view__review-path',
      text: article.sourcePath,
    });
    const returnButton = new ButtonComponent(header)
      .setButtonText('返回内容列表')
      .setIcon('x')
      .setTooltip('返回内容列表')
      .onClick(() => {
        this.focusArticleOnRender = article.sourcePath;
        this.selectedSourcePath = undefined;
        this.selectedArticleDetail = undefined;
        this.renderCachedPublishCenter();
      });
    returnButton.buttonEl.setAttr('aria-label', '返回内容列表');
    if (this.focusReviewOnRender) {
      this.focusReviewOnRender = false;
      returnButton.buttonEl.focus();
    }
    const body = drawer.createDiv({ cls: 'pages-publish-view__review-body' });
    if (article.availability === 'unavailable') {
      body.createEl('p', {
        cls: 'pages-publish-view__review-notice pages-publish-view__warning',
        text: '当前 blocker 使此文章的待发布状态无法安全计算；修复后重新扫描。',
      });
    }
    if (article.availability === 'historical') {
      body.createEl('p', {
        cls: 'pages-publish-view__review-notice pages-publish-view__warning',
        text: '本地源文件已不存在；此行只记录下一次完整发布的待下线事实，不能直接编辑。',
      });
    }
    const result = body.createEl('section', { cls: 'pages-publish-view__review-section' });
    result.createEl('h4', { text: '发布结果' });
    const inclusion = result.createDiv({ cls: 'pages-publish-view__review-inclusion' });
    const inclusionIcon = inclusion.createSpan({ attr: { 'aria-hidden': 'true' } });
    setIcon(inclusionIcon, article.nextIncluded ? 'circle-check' : 'circle-minus');
    inclusion.createSpan({
      text: article.nextIncluded ? '下一版将包含此文章' : '此文章不会进入下一版',
    });
    new ButtonComponent(inclusion)
      .setButtonText(article.nextIncluded ? '下一版包含此文章' : '加入下一版')
      .setClass('pages-publish-view__review-include-action')
      .setDisabled(article.availability !== 'ready')
      .onClick(() => this.updateInclusion(article, !article.nextIncluded));
    const settings = result.createDiv({ cls: 'pages-publish-view__review-settings' });
    if (detail && article.availability === 'ready') {
      new Setting(settings)
        .setName('公开方式')
        .addDropdown((dropdown) => dropdown
          .addOption('public', '公开')
          .addOption('unlisted', '不列出')
          .addOption('private', '私密')
          .setValue(detail.metadata.visibility.value)
          .onChange(async (value) => {
            try {
              const prepared = await this.application.prepareArticleRouteIntentEdit(
                article.sourcePath,
                { visibility: value as 'public' | 'unlisted' | 'private' },
              );
              const confirmed = prepared.confirmation
                ? await this.confirmTakedown(article)
                : true;
              if (!confirmed) return;
              await this.application.commitArticleIntentEdit(prepared, {
                confirmTakedown: prepared.confirmation !== undefined,
              });
              new Notice('发布意图已保存；线上内容尚未改变。');
            } catch (error) {
              new Notice(`无法更新公开方式：${errorMessage(error)}`);
            }
            await this.selectArticle(article);
          }));
      let slug = detail.metadata.slug.source === 'publication.slug'
        ? detail.metadata.slug.value
        : '';
      new Setting(settings)
        .setName('待发布 URL')
        .setDesc(article.url ?? '下一版不生成页面')
        .addText((text) => text
          .setPlaceholder(detail.metadata.slug.value)
          .setValue(slug)
          .onChange((value) => {
            slug = value;
          }))
        .addButton((button) => button.setButtonText('编辑 URL').onClick(async () => {
          try {
            const prepared = await this.application.prepareArticleUrlIntentEdit(
              article.sourcePath,
              slug.trim() || null,
            );
            await this.application.commitArticleIntentEdit(prepared);
            new Notice('URL 意图已保存；线上内容尚未改变。');
          } catch (error) {
            new Notice(`无法更新 URL：${errorMessage(error)}`);
          }
          await this.selectArticle(article);
        }));
    } else {
      settings.createEl('p', {
        cls: 'pages-publish-view__review-fact',
        text: `待发布 URL：${article.url ?? '下一版不包含'}`,
      });
    }
    if (article.onlineUrl) {
      const online = result.createDiv({ cls: 'pages-publish-view__review-fact' });
      online.createSpan({ text: '当前线上 URL' });
      online.createEl('code', { text: article.onlineUrl });
      if (article.url && article.url !== article.onlineUrl) {
        result.createEl('p', {
          cls: 'pages-publish-view__review-redirect',
          text: '发布后自动保留旧地址重定向',
        });
      }
    }
    const checks = body.createEl('section', { cls: 'pages-publish-view__review-section' });
    checks.createEl('h4', { text: '检查' });
    if (article.issues.length === 0) {
      const passed = checks.createDiv({ cls: 'pages-publish-view__review-check pages-publish-view__review-check--passed' });
      const passedIcon = passed.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(passedIcon, 'circle-check');
      passed.createSpan({ text: '未发现此文章的问题。' });
    } else {
      const issues = checks.createEl('ul', { cls: 'pages-publish-view__review-issues' });
      for (const issue of article.issues) {
        const item = issues.createEl('li', {
          cls: `pages-publish-view__review-issue pages-publish-view__review-issue--${issue.severity}`,
        });
        const issueCopy = item.createDiv();
        issueCopy.createEl('strong', { text: issue.severity === 'blocker' ? '阻塞' : '警告' });
        issueCopy.createSpan({ text: `${issue.path}${issue.line ? `:${issue.line}` : ''} · ${issue.message}` });
        new ButtonComponent(item)
          .setButtonText('定位')
          .setTooltip('打开问题来源')
          .onClick(() => this.locateIssue(issue));
      }
    }
    const details = body.createEl('section', { cls: 'pages-publish-view__review-section pages-publish-view__review-section--details' });
    const frontmatter = details.createEl('details', {
      cls: 'pages-publish-view__review-disclosure',
    });
    frontmatter.createEl('summary', { text: '将写入 Frontmatter' });
    if (!detail) {
      frontmatter.createEl('p', { text: '正在读取当前文章的发布意图…' });
    } else {
      frontmatter.createEl('code', {
        text: `publication.visibility: ${detail.metadata.visibility.value}`,
      });
      if (detail.metadata.slug.source === 'publication.slug') {
        frontmatter.createEl('code', { text: `publication.slug: ${detail.metadata.slug.value}` });
      }
      if (detail.metadata.redirects.value.length > 0) {
        frontmatter.createEl('code', {
          text: `publication.redirects: ${detail.metadata.redirects.value.join(', ')}`,
        });
      }
    }
    const dependencies = details.createEl('details', {
      cls: 'pages-publish-view__review-disclosure',
    });
    dependencies.createEl('summary', { text: '依赖' });
    dependencies.createEl('p', {
      text: detail
        ? `图片 ${detail.dependencies.images} · 笔记 ${detail.dependencies.notes} · 外链 ${detail.dependencies.externalLinks}`
        : '正在读取依赖摘要…',
    });
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

  private async selectArticle(article: PublishCenterArticle): Promise<void> {
    this.selectedSourcePath = article.sourcePath;
    this.selectedArticleDetail = undefined;
    try {
      const detail = await this.application.getCurrentArticlePanel({
        pinnedPath: article.sourcePath,
      });
      if (detail.status === 'article' && this.selectedSourcePath === article.sourcePath) {
        this.selectedArticleDetail = detail;
      }
    } catch {
      this.selectedArticleDetail = undefined;
    }
    if (this.selectedSourcePath === article.sourcePath) {
      this.focusReviewOnRender = true;
      this.renderCachedPublishCenter();
    }
  }

  private async locateIssue(issue: ScanIssue): Promise<void> {
    const path = issue.location?.path
      ?? (issue.path.endsWith('.md') ? issue.path : '.publish/site.yml');
    if (path === '.publish/site.yml') {
      await openSiteConfigForRepair({ workspace: this.app.workspace });
      return;
    }
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
    container.addClass('pages-publish-view--setup');
    const setupShell = container.createDiv({ cls: 'pages-publish-view__setup-shell' });
    const setupHeader = setupShell.createEl('header', { cls: 'pages-publish-view__setup-header' });
    container = setupShell.createEl('main', { cls: 'pages-publish-view__setup-body' });
    let invalidateRenderedScopeReview = (): void => undefined;
    let updateRenderedSetupContinueState = (): void => undefined;
    let scopeReviewSummary: HTMLElement | undefined;
    const setupHeading = (text: string): HTMLElement => {
      const heading = container.createEl('h3', { attr: { tabindex: '-1' }, text });
      if (this.focusSetupHeadingOnRender) {
        this.focusSetupHeadingOnRender = false;
        heading.focus();
      }
      return heading;
    };
    let environment = this.application.getInitialSetupEnvironment();
    if (
      this.setupStep === 0
      && environment.stage === 'idle'
      && environment.nextAction !== 'repair'
    ) {
      const preparation = this.application.prepareInitialSetupEnvironment();
      environment = this.application.getInitialSetupEnvironment();
      void preparation
        .then(() => this.render(), () => this.render())
        .catch(() => undefined);
    }
    const environmentReady = environment.stage === 'ready';
    let connection: InitialSetupConnection = { state: 'unavailable' };
    if (this.setupStep >= 3) {
      try {
        connection = await this.application.getInitialSetupConnection();
      } catch {
        connection = { state: 'unavailable' };
      }
    }
    const connectedAccount = 'account' in connection ? connection.account : undefined;
    const draft = this.setupDraft ??=
      this.application.getInitialSetupDraft?.() ?? this.newSetupDraft(connectedAccount);
    const usesVaultRoot = draft.config.contentRoots.some((root) => root.path.trim() === '.');
    if (!draft.cloudflare.account.id && connectedAccount) {
      draft.cloudflare.account = connectedAccount;
    }
    const setupConnectionAvailable = this.application.isInitialSetupAvailable()
      && environmentReady
      && connection.state === 'connected';
    const setupAvailable = setupConnectionAvailable
      && Boolean(draft.cloudflare.account.id)
      && connectedAccount?.id === draft.cloudflare.account.id;
    setupHeader.createDiv({ cls: 'pages-publish-view__type', text: '首次设置' });
    setupHeader.createEl('h2', { text: '创建你的发布站点' });
    setupHeader.createEl('p', {
      text: '草稿只保留在此向导中。只有最后确认才会写入 .publish/site.yml 或修改 Cloudflare 项目；不会发布文章或修改 Frontmatter。',
    });
    const progress = setupHeader.createEl('ol', {
      cls: 'pages-publish-view__setup-progress',
      attr: { 'aria-label': '首次设置进度' },
    });
    for (const [index, label] of [
      '环境准备',
      '1 站点信息',
      '2 内容范围',
      '3 Cloudflare',
      '4 确认',
    ].entries()) {
      const step = progress.createEl('li', {
        cls: index === this.setupStep ? 'is-active' : index < this.setupStep ? 'is-complete' : '',
        attr: { 'data-step': String(index + 1) },
      });
      step.createSpan({ text: label });
    }

    if (this.setupStep === 0) {
      const environmentRuntime = 'runtime' in environment ? environment.runtime : undefined;
      const environmentEngine = 'engine' in environment ? environment.engine : undefined;
      setupHeading('准备本地发布环境');
      const stages = container.createEl('ul', { cls: 'pages-publish-view__environment-stages' });
      stages.createEl('li', {
        text: environmentReady ? '✓ 检查系统与 Vault' : environment.stage === 'checking-system'
          ? '● 正在检查系统与 Vault'
          : '○ 检查系统与 Vault',
      });
      stages.createEl('li', {
        text: environmentRuntime
          ? `✓ ${environmentRuntime.source === 'obsidian' ? 'Obsidian Node.js' : 'Node.js'} ${environmentRuntime.version}`
          : environment.stage === 'checking-system'
            ? '● 查找兼容的 Node.js 运行时'
            : environment.stage === 'downloading-runtime'
              ? '● 下载固定 Node.js 22 运行时'
              : environment.stage === 'installing-runtime'
                ? '● 校验并安装 Node.js 22 运行时'
            : '○ 查找兼容的 Node.js 运行时',
      });
      stages.createEl('li', {
        text: environmentEngine
          ? `✓ Pages 发布引擎 ${environmentEngine.version}`
          : environment.stage === 'downloading-engine'
            ? '● 下载固定 Quartz 5 源码'
            : environment.stage === 'installing-engine'
              ? '● 按 lockfile 安装 Quartz 依赖'
              : environment.stage === 'smoke-testing'
                ? '● 执行 Quartz 离线 smoke build'
                : environment.stage === 'verifying-engine' || environment.stage === 'installing'
                  ? '● 正在准备 Pages 发布引擎'
            : '○ 准备 Pages 发布引擎',
      });
      stages.createEl('li', {
        text: '○ 本地预览服务将在创建站点后按需验证',
      });
      container.createEl('p', {
        text: environmentReady
          ? '本地发布环境已就绪。继续填写站点计划。'
          : '本地发布环境尚未就绪；准备完成前不能进入站点设置。',
      });
      if (!environmentReady) {
        container.createEl('p', {
          cls: 'pages-publish-view__warning',
          text: environment.impact ?? '请完成本地环境准备后重试。',
        });
      }
      if (
        (environment.stage === 'failed' || environment.stage === 'idle')
        && environment.nextAction === 'repair'
      ) {
        new ButtonComponent(container)
          .setButtonText('重试环境准备')
          .onClick(async () => {
            try {
              await this.application.repairInitialSetupEnvironment();
            } catch (error) {
              new Notice(`无法准备本地发布环境：${errorMessage(error)}`);
            }
            await this.render();
          });
      }
      if (isEnvironmentPreparingStage(environment.stage)) {
        new ButtonComponent(container)
          .setButtonText('取消环境准备')
          .onClick(async () => {
            if (this.application.cancelInitialSetupEnvironment()) {
              new Notice('正在取消本地发布环境准备。');
            }
            await this.render();
          });
      }
      new ButtonComponent(container)
        .setButtonText(this.showEnvironmentDetails ? '隐藏详情' : '查看详情')
        .onClick(async () => {
          this.showEnvironmentDetails = !this.showEnvironmentDetails;
          await this.render();
        });
      if (this.showEnvironmentDetails) {
        container.createEl('p', {
          cls: 'pages-publish-view__summary',
          text: '运行时与发布引擎由当前 Obsidian 插件进程使用；不会修改系统 Node.js、npm、PATH 或全局包，也不会显示本机敏感路径。',
        });
      }
    } else if (this.setupStep === 1) {
      setupHeading('站点信息');
      new Setting(container).setName('站点名称').setDesc('必填；支持中文，不决定域名。').addText((text) =>
        text.setValue(draft.config.site.name).onChange((value) => {
          draft.config.site.name = value;
          updateRenderedSetupContinueState();
        }),
      );
      const descriptionCount = container.createSpan({
        cls: 'pages-publish-view__character-count',
        text: `${visibleCharacterCount(draft.config.site.description ?? '')} / 160`,
      });
      new Setting(container).setName('站点简介').setDesc('可选，最多 160 个字符。').addTextArea((text) =>
        text.setValue(draft.config.site.description ?? '').onChange((value) => {
          draft.config.site.description = value || undefined;
          descriptionCount.setText(`${visibleCharacterCount(value)} / 160`);
          updateRenderedSetupContinueState();
        }),
      );
    } else if (this.setupStep === 2) {
      setupHeading('内容范围');
      const scopeWarning = container.createEl('p', { cls: 'pages-publish-view__warning' });
      for (const [index, root] of draft.config.contentRoots.entries()) {
        const row = container.createDiv({ cls: 'pages-publish-view__setup-content-root' });
        new Setting(row)
          .setName(`内容目录 ${index + 1}`)
          .setDesc('只有其中的 Markdown 会成为候选。')
          .addText((text) => text.setValue(root.path).onChange((value) => {
            root.path = value;
            this.setupReview = undefined;
            this.setupVaultRootConfirmed = false;
            invalidateRenderedScopeReview();
            scopeWarning.setText(
              draft.config.contentRoots.some((candidate) => candidate.path.trim() === '.')
                ? '警告：选择 Vault 根会把整个 Vault 的 Markdown 纳入候选范围。'
                : '',
            );
          }));
        new Setting(row)
          .setName('公开路径')
          .setDesc('必须以 / 开始。')
          .addText((text) => text.setValue(root.publicRoot).onChange((value) => {
            root.publicRoot = value;
            this.setupReview = undefined;
            invalidateRenderedScopeReview();
          }));
        if (draft.config.contentRoots.length > 1) {
          new ButtonComponent(row)
            .setButtonText(`移除内容目录 ${index + 1}`)
            .setDestructive()
            .onClick(async () => {
              draft.config.contentRoots.splice(index, 1);
              this.setupReview = undefined;
              this.setupVaultRootConfirmed = false;
              await this.render();
            });
        }
        const rootSummary = this.setupReview?.roots?.find(
          (candidate) => candidate.path === root.path,
        );
        row.createSpan({
          cls: 'pages-publish-view__setup-root-result',
          text: rootSummary ? `扫描结果：${rootSummary.candidateCount} 篇` : '扫描结果：待扫描',
        });
      }
      new ButtonComponent(container)
        .setButtonText('添加内容目录')
        .onClick(async () => {
          draft.config.contentRoots.push({ path: '', publicRoot: '/' });
          this.setupReview = undefined;
          this.setupVaultRootConfirmed = false;
          await this.render();
        });
      if (usesVaultRoot) {
        container.createEl('p', {
          cls: 'pages-publish-view__warning',
          text: this.setupVaultRootConfirmed
            ? '已确认：整个 Vault 的 Markdown 都会进入候选扫描。'
            : '选择 Vault 根会扩大可能公开的内容范围；继续前必须明确确认。',
        });
        if (!this.setupVaultRootConfirmed) {
          new ButtonComponent(container)
            .setButtonText('确认将整个 Vault 纳入候选范围')
            .onClick(async () => {
              this.setupVaultRootConfirmed = true;
              await this.render();
            });
        }
      }
      container.createEl('p', {
        text: '继续前会以此草稿进行本地扫描；扫描不会写入 site.yml。',
      });
      new ButtonComponent(container)
        .setButtonText(this.setupReview ? '重新扫描内容范围' : '扫描内容范围')
        .onClick(async () => {
          try {
            this.setupReview = await this.application.reviewInitialSetup(draft);
          } catch (error) {
            new Notice(`无法扫描设置草稿：${errorMessage(error)}`);
            this.setupReview = undefined;
          }
          await this.render();
        });
      if (this.setupReview) {
        scopeReviewSummary = container.createEl('p', {
          cls: 'pages-publish-view__setup-scan-summary',
          text: `草稿扫描：找到 ${this.setupReview.candidateCount} 篇候选，其中 ${this.setupReview.eligibleCount} 篇当前无 Blocker。`,
        });
        for (const example of this.setupReview.examples ?? []) {
          container.createEl('p', {
            cls: 'pages-publish-view__setup-example',
            text: `${example.sourcePath} → ${example.url}`,
          });
        }
      }
    } else if (this.setupStep === 3) {
      const canUseOAuth = this.application.canConnectInitialSetupOAuth();
      setupHeading('Cloudflare');
      container.createEl('p', {
        text: setupAvailable
          ? `将使用已连接账号：${draft.cloudflare.account.name}。`
          : setupConnectionAvailable && connectedAccount
            ? `当前连接账号 ${connectedAccount.name} 与草稿账号 ${draft.cloudflare.account.name} 不一致；请选择目标账号后再继续。`
          : canUseOAuth
            ? '尚未连接 Cloudflare。请使用 Cloudflare 登录完成授权，然后选择账号和 Pages 项目。'
            : '尚未连接 Cloudflare。此发行版本未配置 OAuth client；请使用 API token 连接后查看账号和可用 Pages 项目。',
      });
      if (connection.state === 'expired') {
        container.createEl('p', {
          cls: 'pages-publish-view__warning',
          text: 'Cloudflare 授权已过期；重新授权后才能创建或绑定项目。',
        });
      }
      if (canUseOAuth) {
        new ButtonComponent(container)
          .setButtonText('使用 Cloudflare 登录')
          .setCta()
          .onClick(async () => {
            try {
              await this.application.beginInitialSetupOAuth();
              new Notice('已在浏览器打开 Cloudflare 授权；完成后将返回 Obsidian。');
            } catch (error) {
              new Notice(`无法开始 Cloudflare 授权：${errorMessage(error)}`);
            }
          });
        container.createEl('p', {
          text: '将在浏览器中打开授权页面。凭据保存在 Obsidian 安全存储（当前 Vault 的本地存储）。',
        });
        const advanced = container.createEl('details');
        advanced.createEl('summary', { text: '高级方式 · 使用 API token' });
        this.renderSetupApiTokenConnection(advanced, draft);
      } else {
        this.renderSetupApiTokenConnection(container, draft);
      }
      if (setupConnectionAvailable) {
        await this.renderSetupAccounts(container, draft);
      }
      if (setupAvailable) {
        await this.renderSetupProjects(container, draft);
      }
      new Setting(container).setName('Pages 项目标识').setDesc('创建或绑定计划；最终确认前不调用远端。').addText((text) =>
        text.setValue(draft.cloudflare.projectName).onChange((value) => {
          draft.cloudflare.projectName = value;
          draft.config.cloudflare.projectName = value;
          this.setupProjects = undefined;
          this.setupProjectAvailability = undefined;
        }),
      );
      new ButtonComponent(container)
        .setButtonText('检查可用性')
        .onClick(async () => {
          const projectName = draft.cloudflare.projectName.trim();
          if (projectName.length === 0) {
            new Notice('请输入 Pages 项目标识。');
            return;
          }
          try {
            const projects = await this.application.listInitialSetupProjects(
              draft.cloudflare.account,
            );
            this.setupProjects = projects;
            this.setupProjectAvailability = {
              name: projectName,
              available: !projects.some((project) => project.name === projectName),
            };
          } catch (error) {
            new Notice(`无法检查 Pages 项目标识：${errorMessage(error)}`);
            this.setupProjectAvailability = undefined;
          }
          await this.render();
        });
      if (this.setupProjectAvailability?.name === draft.cloudflare.projectName.trim()) {
        container.createEl('p', {
          cls: this.setupProjectAvailability.available
            ? 'pages-publish-view__summary'
            : 'pages-publish-view__warning',
          text: this.setupProjectAvailability.available
            ? `${this.setupProjectAvailability.name} 可用。`
            : `${this.setupProjectAvailability.name} 已存在；请选择绑定已有项目或更换标识。`,
        });
      }
      const projectActions = container.createDiv({ cls: 'pages-publish-view__setup-options' });
      new ButtonComponent(projectActions)
        .setButtonText(draft.cloudflare.action === 'create' ? '● 创建新项目' : '○ 创建新项目')
        .onClick(async () => {
          draft.cloudflare.action = 'create';
          this.setupProjectAvailability = undefined;
          await this.render();
        });
      new ButtonComponent(projectActions)
        .setButtonText(draft.cloudflare.action === 'bind' ? '● 绑定已有项目' : '○ 绑定已有项目')
        .onClick(async () => {
          draft.cloudflare.action = 'bind';
          this.setupProjectAvailability = undefined;
          await this.render();
        });
      container.createEl('p', {
        cls: 'pages-publish-view__setup-example',
        text: `默认域名：${draft.cloudflare.projectName}.pages.dev`,
      });
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
        container.createEl('p', {
          text: '最终确认后会向 Cloudflare 请求连接域名；随后可能需要按提示配置域名解析并等待验证，不承诺立即生效。',
        });
        new Setting(container).setName('自定义域名').setDesc('最终确认后请求绑定；可显示待验证、有效或失败。').addText((text) =>
          text.setValue(customDomain.hostname).onChange((value) => {
            customDomain.hostname = value;
          }),
        );
      }
    } else {
      setupHeading('确认创建站点');
      const summary = container.createEl('ul', { cls: 'pages-publish-view__setup-summary' });
      const siteSummary = summary.createEl('li', {
        text: `站点：${draft.config.site.name || '未命名站点'}`,
      });
      if (draft.config.site.description) {
        siteSummary.createEl('p', { text: draft.config.site.description });
      }
      new ButtonComponent(siteSummary).setButtonText('编辑站点信息').onClick(async () => {
        this.setupStep = 1;
        this.focusSetupHeadingOnRender = true;
        await this.render();
      });
      const contentSummary = summary.createEl('li', {
        text: `内容范围：${draft.config.contentRoots.map((root) => {
          const count = this.setupReview?.roots?.find((item) => item.path === root.path)?.candidateCount;
          return `${root.path} → ${root.publicRoot}${count === undefined ? '' : ` · ${count} 篇`}`;
        }).join('；')}`,
      });
      new ButtonComponent(contentSummary).setButtonText('编辑内容范围').onClick(async () => {
        this.setupStep = 2;
        this.focusSetupHeadingOnRender = true;
        await this.render();
      });
      const cloudflareSummary = summary.createEl('li', {
        text: `Cloudflare：${draft.cloudflare.account.name} · ${draft.cloudflare.action === 'create' ? '创建' : '绑定'}项目 ${draft.cloudflare.projectName} · ${draft.cloudflare.domain.kind === 'pages-dev' ? `${draft.cloudflare.projectName}.pages.dev` : draft.cloudflare.domain.hostname}`,
      });
      new ButtonComponent(cloudflareSummary).setButtonText('编辑 Cloudflare').onClick(async () => {
        this.setupStep = 3;
        this.focusSetupHeadingOnRender = true;
        await this.render();
      });
      container.createEl('p', { text: '将执行：验证草稿、创建或验证 Pages 项目、写入正式配置、扫描候选。' });
      container.createEl('p', { text: '不会执行：发布文章、修改文章 Frontmatter。' });
    }

    const actions = setupShell.createDiv({
      cls: 'pages-publish-view__actions pages-publish-view__setup-actions',
    });
    if (this.setupStep > 0) {
      new ButtonComponent(actions)
        .setButtonText('退出设置')
        .onClick(() => {
          this.application.preserveInitialSetupDraft(draft);
          this.leaf.detach();
        });
    }
    new ButtonComponent(actions)
      .setButtonText('返回')
      .setDisabled(this.setupStep === 0)
      .onClick(async () => {
        this.setupStep = Math.max(0, this.setupStep - 1);
        this.focusSetupHeadingOnRender = true;
        await this.render();
      });
    if (this.setupStep < 4) {
      const canContinueNow = (): boolean => this.setupStep === 0
        ? environmentReady
        : this.setupStep === 1
          ? draft.config.site.name.trim().length > 0
            && visibleCharacterCount(draft.config.site.description ?? '') <= 160
          : this.setupStep === 2
            ? this.setupReview !== undefined && (!usesVaultRoot || this.setupVaultRootConfirmed)
            : this.setupStep === 3
              ? setupAvailable
              : true;
      const continueButton = new ButtonComponent(actions)
        .setButtonText(setupContinuationLabel(this.setupStep))
        .setCta()
        .setDisabled(!canContinueNow())
        .onClick(async () => {
          if (!canContinueNow()) return;
          if (this.setupStep === 1 && draft.config.site.name.trim().length === 0) {
            new Notice('请输入站点名称后再继续。');
            return;
          }
          if (
            this.setupStep === 1 &&
            visibleCharacterCount(draft.config.site.description ?? '') > 160
          ) {
            new Notice('站点简介不能超过 160 个字符。');
            return;
          }
          if (this.setupStep === 2 && this.setupReview === undefined) {
            new Notice('内容范围已变化，请重新扫描后再继续。');
            return;
          }
          if (this.setupStep === 2 && usesVaultRoot && !this.setupVaultRootConfirmed) {
            new Notice('请先确认将整个 Vault 纳入候选范围。');
            return;
          }
          this.setupStep += 1;
          this.focusSetupHeadingOnRender = true;
          await this.render();
        });
      updateRenderedSetupContinueState = () => {
        continueButton.setDisabled(!canContinueNow());
      };
      if (this.setupStep === 2) {
        invalidateRenderedScopeReview = () => {
          continueButton.setDisabled(true);
          scopeReviewSummary?.setText('内容范围已变化，请重新扫描。');
        };
      }
      return;
    }
    new ButtonComponent(actions)
      .setButtonText(setupAvailable ? '创建站点并开始扫描' : '创建站点（需要完成连接）')
      .setCta()
      .setDisabled(!setupAvailable || !draft.cloudflare.account.id)
      .onClick(() => this.executeInitialSetup(structuredClone(draft)));
  }

  private renderSetupExecution(
    container: HTMLElement,
    execution: SetupExecutionState,
  ): void {
    container.createDiv({ cls: 'pages-publish-view__type', text: '首次设置' });
    if (execution.state === 'success') {
      container.createEl('h2', { text: '站点已创建' });
      container.createEl('p', {
        cls: 'pages-publish-view__summary',
        text: `找到 ${execution.candidateCount} 篇候选，其中 ${execution.eligibleCount} 篇可以加入首次发布。${execution.domain}`,
      });
      container.createEl('p', { text: '没有文章被发布，也没有修改文章 Frontmatter。' });
      new ButtonComponent(container).setButtonText('进入发布中心').setCta().onClick(async () => {
        this.setupExecution = undefined;
        await this.render();
      });
      return;
    }
    const stageOrder: SetupProgressStage[] = ['validate', 'project', 'domain', 'config', 'scan'];
    const labels: Record<SetupProgressStage, string> = {
      validate: '验证冻结草稿与当前连接',
      project: '创建或验证 Cloudflare Pages 项目',
      domain: '配置 pages.dev 或自定义域名计划',
      config: '原子写入 .publish/site.yml',
      scan: '扫描内容候选',
    };
    const activeIndex = stageOrder.indexOf(execution.stage);
    container.createEl('h2', {
      text: execution.state === 'running' ? '正在创建站点' : '站点创建未完成',
    });
    const stages = container.createEl('ul', { cls: 'pages-publish-view__environment-stages' });
    for (const [index, stage] of stageOrder.entries()) {
      const marker = index < activeIndex
        ? '✓'
        : index === activeIndex
          ? execution.state === 'running' ? '●' : '✕'
          : '○';
      stages.createEl('li', { text: `${marker} ${labels[stage]}` });
    }
    if (execution.state === 'running') {
      container.createEl('p', { text: '请保持 Obsidian 运行；重试会复用匹配的远端项目。' });
      return;
    }
    container.createEl('p', {
      cls: 'pages-publish-view__error',
      text: execution.message,
    });
    const actions = container.createDiv({ cls: 'pages-publish-view__actions' });
    new ButtonComponent(actions).setButtonText('返回确认').onClick(async () => {
      this.setupExecution = undefined;
      this.setupStep = 4;
      await this.render();
    });
    new ButtonComponent(actions).setButtonText('重试已确认计划').setCta().onClick(() =>
      this.executeInitialSetup(execution.draft),
    );
  }

  private async executeInitialSetup(draft: SetupDraft): Promise<void> {
    const confirmedDraft = structuredClone(draft);
    let currentStage: SetupProgressStage = 'validate';
    try {
      if (!(await this.isSetupPlanConfirmable(confirmedDraft))) {
        new Notice('本地环境或 Cloudflare 连接已变化；请恢复连接并重新检查确认页。');
        await this.render();
        return;
      }
      this.setupExecution = { state: 'running', stage: currentStage, draft: confirmedDraft };
      await this.render();
      const review = await this.application.reviewInitialSetup(confirmedDraft);
      if (!(await this.isSetupPlanConfirmable(confirmedDraft))) {
        this.setupExecution = undefined;
        new Notice('本地环境或 Cloudflare 连接已变化；请恢复连接并重新检查确认页。');
        await this.render();
        return;
      }
      const result = await this.application.confirmInitialSetup(confirmedDraft, (stage) => {
        currentStage = stage;
        this.setupExecution = { state: 'running', stage, draft: confirmedDraft };
        void this.render();
      });
      this.setupDraft = undefined;
      const domain = 'url' in result.domain
        ? `站点地址：${result.domain.url}。`
        : result.domain.status === 'pending'
          ? '自定义域名正在等待验证。'
          : '自定义域名已生效。';
      this.setupExecution = {
        state: 'success',
        candidateCount: result.scan.candidateCount,
        eligibleCount: review.eligibleCount,
        domain,
      };
      await this.render();
    } catch (error) {
      this.setupExecution = {
        state: 'failed',
        stage: currentStage,
        draft: confirmedDraft,
        message: `无法完成当前步骤：${errorMessage(error)}`,
      };
      await this.render();
    }
  }

  private async isSetupPlanConfirmable(draft: SetupDraft): Promise<boolean> {
    const currentEnvironment = this.application.getInitialSetupEnvironment();
    const currentConnection = await this.application.getInitialSetupConnection();
    const currentAccount = 'account' in currentConnection
      ? currentConnection.account
      : undefined;
    return currentEnvironment.stage === 'ready'
      && this.application.isInitialSetupAvailable()
      && currentConnection.state === 'connected'
      && currentAccount?.id === draft.cloudflare.account.id;
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
          try {
            const selected = this.application.canSelectInitialSetupAccount()
              ? await this.application.selectInitialSetupAccount(account.id)
              : { state: 'connected' as const, account };
            const selectedAccount = 'account' in selected ? selected.account : undefined;
            draft.cloudflare.account = selectedAccount ?? account;
            this.setupProjects = undefined;
            this.setupProjectAvailability = undefined;
            await this.render();
          } catch (error) {
            new Notice(`无法切换 Cloudflare 账号：${errorMessage(error)}`);
          }
        });
    }
  }

  private renderSetupApiTokenConnection(
    container: HTMLElement,
    draft: SetupDraft,
  ): void {
    if (!this.application.canConnectInitialSetupApiToken()) return;
    let token = '';
    let tokenInput: HTMLInputElement | undefined;
    new Setting(container)
      .setName('Cloudflare API token')
      .setDesc('高级备用方式；仅在点击“连接”后验证并写入 Obsidian 安全存储。请授予账户读取和 Pages 读取、编辑权限。')
      .addText((text) => {
        tokenInput = text.inputEl;
        text.inputEl.type = 'password';
        text.setPlaceholder('粘贴 API token').onChange((value) => {
          token = value;
        });
      })
      .addButton((button) =>
        button.setButtonText('连接 Cloudflare').setCta().onClick(async () => {
          if (token.trim().length === 0) {
            new Notice('请输入 Cloudflare API token。');
            return;
          }
          button.setDisabled(true).setButtonText('连接中…');
          try {
            const status = await this.application.connectInitialSetupApiToken(token.trim());
            const connectedAccount = 'account' in status ? status.account : undefined;
            if (
              status.state !== 'connected' ||
              !connectedAccount
            ) {
              throw new Error('Cloudflare 未返回可用于 Pages 发布的账号。');
            }
            draft.cloudflare.account = connectedAccount;
            this.setupAccounts = undefined;
            this.setupProjects = undefined;
            this.setupProjectAvailability = undefined;
            new Notice(`Cloudflare 已连接：${connectedAccount.name}`);
            await this.render();
          } catch (error) {
            new Notice(`无法连接 Cloudflare：${errorMessage(error)}`);
            button.setDisabled(false).setButtonText('连接 Cloudflare');
          } finally {
            token = '';
            if (tokenInput) tokenInput.value = '';
          }
        }),
      );
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
          this.setupProjectAvailability = undefined;
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
    this.modalEl?.addClass('pages-publish-modal');
    this.modalEl?.addClass('pages-publish-modal--danger');
    this.titleEl.addClass('pages-publish-modal__title');
    this.contentEl.addClass('pages-publish-modal__content');
    this.titleEl.setText('确认待下线');
    const copy = this.contentEl.createDiv({ cls: 'pages-publish-modal__copy' });
    copy.createEl('p', {
      text: '下一次完整发布会移除这篇文章的线上页面。本地 Markdown 文件不会被删除，当前线上页面也不会立即改变。',
    });
    const impact = this.contentEl.createDiv({ cls: 'pages-publish-modal__impact' });
    impact.createSpan({ text: '影响范围' });
    impact.createSpan({ text: '仅在下一次整站发布生效' });
    if (this.article.onlineUrl) {
      const target = this.contentEl.createDiv({ cls: 'pages-publish-modal__target' });
      target.createSpan({
        cls: 'pages-publish-modal__target-label',
        text: '将下线的线上地址',
      });
      target.createEl('code', { text: this.article.onlineUrl });
    }
    const actions = this.contentEl.createDiv({
      cls: 'pages-publish-modal__actions pages-publish-article-panel__modal-actions',
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

class UploadUncertainRecoveryModal extends Modal {
  private settled = false;

  constructor(
    app: PagesPublishView['app'],
    private readonly projectName: string | undefined,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl?.addClass('pages-publish-modal');
    this.modalEl?.addClass('pages-publish-modal--danger');
    this.titleEl.addClass('pages-publish-modal__title');
    this.contentEl.addClass('pages-publish-modal__content');
    this.titleEl.setText('确认解除上传结果未知锁');
    const copy = this.contentEl.createDiv({ cls: 'pages-publish-modal__copy' });
    copy.createEl('p', {
      text: this.projectName === undefined
        ? '插件无法确认上次 Cloudflare 上传是否创建或激活。请先在 Cloudflare Pages 核验目标项目的部署记录。'
        : `插件无法确认上次上传是否影响 Pages 项目“${this.projectName}”。请先在 Cloudflare Pages 核验部署记录。`,
    });
    const impact = this.contentEl.createDiv({ cls: 'pages-publish-modal__impact' });
    impact.createSpan({ text: '解除后' });
    impact.createSpan({ text: '仅允许后续发布重新开始；不会撤销或删除 Cloudflare 部署。' });
    if (this.projectName) {
      const target = this.contentEl.createDiv({ cls: 'pages-publish-modal__target' });
      target.createSpan({
        cls: 'pages-publish-modal__target-label',
        text: '需要核验的项目',
      });
      target.createEl('code', { text: this.projectName });
    }
    const actions = this.contentEl.createDiv({
      cls: 'pages-publish-modal__actions pages-publish-article-panel__modal-actions',
    });
    new ButtonComponent(actions).setButtonText('取消').onClick(() => this.finish(false));
    new ButtonComponent(actions)
      .setButtonText('已核验，解除阻塞')
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

function setupContinuationLabel(step: number): string {
  const labels: Record<number, string> = {
    0: '继续：站点信息',
    1: '继续：内容范围',
    2: '继续：Cloudflare',
    3: '继续：确认',
  };
  return labels[step] ?? '继续';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function isPublishCenterTab(value: unknown): value is PublishCenterTab {
  return value === 'changes' || value === 'all' || value === 'unpublished' || value === 'issues';
}

function isPublishCenterFilter(value: unknown): value is PublishCenterFilter {
  return value === 'all'
    || value === 'public'
    || value === 'unlisted'
    || value === 'private'
    || value === 'blocker'
    || value === 'warning';
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

function publicationStatusLabel(
  status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>,
): string {
  if (status.state === 'running') return `${publicationStageLabel(status.stage)}中`;
  if (status.state === 'succeeded') return '发布成功';
  if (status.state === 'reconciliation-required') {
    return status.reconciliation === 'upload-uncertain'
      ? '上传结果未确认'
      : '本地发布事实待协调';
  }
  return '发布失败';
}

function publicationStatusDetail(
  status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>,
): string {
  if (status.state === 'running') {
    return `第 ${publicationStageNumber(status.stage)}/4 阶段。任务在后台继续运行。`;
  }
  if (status.state === 'succeeded') {
    return `${status.deployment.output.fileCount} 个文件已激活。后续编辑会进入下一次变化。`;
  }
  if (status.state === 'reconciliation-required') {
    if (status.reconciliation === 'upload-uncertain') {
      return `请先在 Cloudflare Pages 核验${status.target === undefined ? '已保存的目标项目' : `项目 ${status.target.projectName}`}，再解除本地阻塞。${status.message}`;
    }
    return `线上发布成功，但本地事实待协调：${status.message}`;
  }
  return `${status.message} 新版本未激活，现有线上站点保持不变。`;
}

export function publicationStatusText(status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>): string {
  return `${publicationStatusLabel(status)}：${publicationStatusDetail(status)}`;
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

function isEnvironmentPreparingStage(stage: string): boolean {
  return [
    'checking-system',
    'downloading-runtime',
    'installing-runtime',
    'verifying-engine',
    'downloading-engine',
    'installing-engine',
    'smoke-testing',
    'installing',
  ].includes(stage);
}

function visibilityLabel(value: PublishCenterArticle['visibility']): string {
  if (value === 'public') return '公开';
  if (value === 'unlisted') return '不列出';
  if (value === 'private') return '不公开';
  return '—';
}

function visibilityIconName(value: PublishCenterArticle['visibility']) {
  if (value === 'public') return 'globe-2';
  if (value === 'unlisted') return 'link';
  if (value === 'private') return 'lock-keyhole';
  return 'circle-help';
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

function changeIconName(value: PublishCenterArticle['change']) {
  if (value === 'added') return 'plus';
  if (value === 'updated') return 'refresh-cw';
  if (value === 'url-changed') return 'link-2';
  if (value === 'visibility-changed') return 'eye';
  if (value === 'takedown') return 'minus';
  if (value === 'unchanged') return 'minus';
  return 'circle-help';
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

function visibleCharacterCount(value: string): number {
  return Array.from(value).length;
}
