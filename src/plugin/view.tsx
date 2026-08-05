import {
  ItemView,
  MarkdownView,
  Notice,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import { render as renderPreact } from 'preact';
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
import { PublishCenterScreen } from '../ui/publish-center/publish-center-screen';
import { SetupExecutionScreen, SetupWizardScreen } from '../ui/setup/setup-wizard-screen';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { PublishCenterErrorScreen, PublishCenterLoadingScreen, PublishingWithoutScanScreen } from '../ui/publish-center/publish-center-state-screen';
export { publicationStatusText } from '../ui/publish-center/publication-status-copy';

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
  private articleSearchQuery = '';
  private setupStep = 0;
  private setupDraft: SetupDraft | undefined;
  private setupAccounts: SetupAccount[] | undefined;
  private setupProjects: SetupProject[] | undefined;
  private setupReview: SetupReview | undefined;
  private setupProjectAvailability: { name: string; available: boolean } | undefined;
  private setupVaultRootConfirmed = false;
  private setupExecution: SetupExecutionState | undefined;
  private unsubscribePublicationStatus: (() => void) | undefined;
  private unsubscribeGlobalUiState: (() => void) | undefined;
  private lastPublishCenter: PublishCenterState | undefined;
  private lastPublishConnection: InitialSetupConnection = { state: 'unavailable' };
  private lastLaunchTarget: 'setup' | 'publish-center' | undefined;
  private activeRender: Promise<void> | undefined;
  private renderAgain = false;
  private refreshPublishCenterInFlight = false;
  private localContentMutationsInFlight = 0;
  private publishCenterContentRefreshRequested = false;
  private sitePreviewInFlight: Promise<void> | undefined;
  private sitePreviewBusy = false;
  private publicationUiActive = false;
  private refreshedPublicationDeploymentId: string | undefined;
  private publishCenterRoot: HTMLElement | undefined;

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
      const publicationRunning = this.lastLaunchTarget === 'publish-center'
        && this.application.getPublicationStatus().state === 'running';
      if (
        this.lastLaunchTarget === 'publish-center'
        && (
          this.activeRender
          || this.refreshPublishCenterInFlight
          || this.localContentMutationsInFlight > 0
          || this.sitePreviewBusy
          || this.publicationUiActive
          || publicationRunning
        )
      ) {
        if (publicationRunning) {
          this.publicationUiActive = true;
        }
        return;
      }
      void this.render();
    });
    if (this.application.isPublicationAvailable()) {
      this.unsubscribePublicationStatus = this.application.subscribePublicationStatus((status) => {
        this.handlePublicationStatus(status);
      });
    }
    await this.render();
  }

  async onClose(): Promise<void> {
    this.clearPublishCenterRoot();
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
    this.clearPublishCenterRoot();
    container.empty();
    container.addClass('pages-publish-view');

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
      const root = this.ensurePreactRoot(container);
      renderPreact(<PublishCenterErrorScreen message={errorMessage(error)} />, root);
    }
  }

  private renderLoadingPublishCenter(container: HTMLElement): void {
    const root = this.ensurePreactRoot(container);
    renderPreact(<PublishCenterLoadingScreen />, root);
  }

  private renderPublishingWithoutScan(
    container: HTMLElement,
    status: Extract<PublicationServiceStatus, { state: 'running' }>,
  ): void {
    const root = this.ensurePreactRoot(container);
    renderPreact(<PublishingWithoutScanScreen status={status} />, root);
  }

  private renderCachedPublishCenter(): void {
    if (!this.lastPublishCenter) return;
    const container = this.contentEl;
    const scrollTop = container.scrollTop;
    this.renderPublishCenter(container, this.lastPublishCenter, this.lastPublishConnection);
    container.scrollTop = scrollTop;
  }

  private handlePublicationStatus(status: PublicationServiceStatus): void {
    const hasMountedPublishCenter = this.lastLaunchTarget === 'publish-center'
      && this.lastPublishCenter !== undefined;
    if (!hasMountedPublishCenter) {
      void this.render();
      return;
    }

    if (status.state === 'running') this.publicationUiActive = true;
    this.renderCachedPublishCenter();

    if (status.state !== 'running') this.publicationUiActive = false;
    if (
      status.state === 'succeeded'
      && this.refreshedPublicationDeploymentId !== status.deployment.deploymentId
    ) {
      this.refreshedPublicationDeploymentId = status.deployment.deploymentId;
      void this.refreshPublishCenter({ content: true });
    }
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
    const root = this.ensurePreactRoot(container);
    const publication = this.application.getPublicationStatus();
    renderPreact(<PublishCenterScreen
      activeTab={this.activeTab}
      center={center}
      connection={connection}
      filter={this.articleFilter}
      onAcknowledgeUploadUncertain={() => this.acknowledgeUploadUncertain()}
      onChangeFilter={(filter) => {
        this.articleFilter = filter;
        this.selectedSourcePath = undefined;
        this.selectedArticleDetail = undefined;
        this.renderCachedPublishCenter();
      }}
      onChangeInclusion={(article, included) => this.updateInclusion(article, included)}
      onChangeQuery={(query) => {
        this.articleSearchQuery = query;
        if (this.selectedSourcePath) {
          const selected = center.articles.find((article) => article.sourcePath === this.selectedSourcePath);
          if (selected && !this.matchesSearch(selected, query)) {
            this.selectedSourcePath = undefined;
            this.selectedArticleDetail = undefined;
          }
        }
        this.renderCachedPublishCenter();
      }}
      onChangeTab={(tab) => this.activateTab(tab)}
      onCheckConnection={() => this.refreshPublishCenter({ connection: true })}
      onCloseReview={() => {
        this.selectedSourcePath = undefined;
        this.selectedArticleDetail = undefined;
        this.renderCachedPublishCenter();
      }}
      onLocateIssue={(issue) => this.locateIssue(issue)}
      onOpenLogs={() => this.openMaintenanceLogs()}
      onOpenSettings={() => {
        if (!openPluginSettingsInHost(this.app, 'pages-publish')) {
          new Notice('无法自动打开插件设置；请从 Obsidian 设置中选择 Pages Publish。');
        }
      }}
      onOpenSite={async () => {
        try { await this.application.openPublishedSite(); }
        catch (error) { new Notice(`无法打开线上站点：${errorMessage(error)}`); }
      }}
      onOpenSiteConfig={() => openSiteConfigForRepair({ workspace: this.app.workspace })}
      onPreview={() => this.openSitePreview()}
      onPublish={() => this.publishFromScreen()}
      onRefresh={() => this.refreshPublishCenter({ content: true })}
      onSelectArticle={(article) => this.selectArticle(article)}
      previewBusy={this.sitePreviewBusy}
      publication={publication}
      query={this.articleSearchQuery}
      selectedDetail={this.selectedArticleDetail}
      selectedSourcePath={this.selectedSourcePath}
    />, root);
  }

  private clearPublishCenterRoot(): void {
    if (!this.publishCenterRoot) return;
    renderPreact(null, this.publishCenterRoot);
    this.publishCenterRoot.remove();
    this.publishCenterRoot = undefined;
  }

  private ensurePreactRoot(container: HTMLElement): HTMLElement {
    if (this.publishCenterRoot?.isConnected) return this.publishCenterRoot;
    container.empty();
    container.addClass('pages-publish-view');
    const root = container.createDiv({ cls: 'pages-publish-ui' });
    this.publishCenterRoot = root;
    return root;
  }

  private async publishFromScreen(): Promise<void> {
    try {
      const currentConnection = await this.application.getInitialSetupConnection();
      if (currentConnection.state !== 'connected') {
        this.lastPublishConnection = currentConnection;
        new Notice('Cloudflare 连接已失效；请重新授权或更新 API token 后再发布。');
        this.renderCachedPublishCenter();
        return;
      }
      const deployment = await this.application.publishSite();
      new Notice(`发布成功：${deployment.output.fileCount} 个文件已激活。后续编辑将进入下一次变化。`);
    } catch (error) {
      new Notice(`发布失败：${errorMessage(error)}`);
    }
  }

  private async acknowledgeUploadUncertain(): Promise<void> {
    const status = this.application.getPublicationStatus();
    if (status.state !== 'reconciliation-required' || status.reconciliation !== 'upload-uncertain') return;
    const confirmed = await openConfirmationModal(this.app, {
      eyebrow: '发布安全锁',
      title: '确认解除上传结果未知锁？',
      description: '请先在 Cloudflare Pages 核验目标项目的部署记录。解除只允许后续发布重新开始，不会撤销或删除远端部署。',
      facts: status.target?.projectName
        ? [{ label: '核验项目', value: status.target.projectName, tone: 'danger' }]
        : undefined,
      cancelLabel: '继续核验',
      confirmLabel: '已核验，解除阻塞',
      confirmTone: 'destructive',
    });
    if (!confirmed) return;
    try {
      await this.application.acknowledgeUploadUncertainPublication();
      new Notice('已解除本地发布锁。请重新扫描并确认 Cloudflare 的最终状态后再发布。');
    } catch (error) {
      new Notice(`无法解除本地发布锁：${errorMessage(error)}`);
    }
    await this.render();
  }

  private async openMaintenanceLogs(): Promise<void> {
    try { await this.application.openMaintenanceLogs(); }
    catch (error) { new Notice(`无法打开日志：${errorMessage(error)}`); }
  }

  private openSitePreview(): Promise<void> {
    if (this.sitePreviewInFlight) return this.sitePreviewInFlight;
    this.sitePreviewBusy = true;
    this.renderCachedPublishCenter();
    const operation = this.openSitePreviewExclusive();
    this.sitePreviewInFlight = operation;
    void operation.finally(() => {
      if (this.sitePreviewInFlight === operation) {
        this.sitePreviewInFlight = undefined;
        this.sitePreviewBusy = false;
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

  private activateTab(tab: PublishCenterTab): void {
    this.activeTab = tab;
    this.renderCachedPublishCenter();
  }

  private matchesSearch(
    article: PublishCenterArticle,
    query = this.articleSearchQuery,
  ): boolean {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return true;
    return `${article.title}\n${article.sourcePath}`.toLocaleLowerCase().includes(normalizedQuery);
  }

  private async updateInclusion(
    article: PublishCenterArticle,
    included: boolean,
  ): Promise<void> {
    this.localContentMutationsInFlight += 1;
    let saved = false;
    try {
      const confirmTakedown = !included && Boolean(article.onlineUrl)
        ? await this.confirmTakedown(article)
        : false;
      if (!included && article.onlineUrl && !confirmTakedown) {
        return;
      }
      await this.application.setPublishCenterInclusion(article.sourcePath, included, {
        confirmTakedown,
      });
      saved = true;
    } catch (error) {
      new Notice(`无法更新下一版选择：${errorMessage(error)}`);
    } finally {
      if (saved) this.publishCenterContentRefreshRequested = true;
      this.localContentMutationsInFlight = Math.max(0, this.localContentMutationsInFlight - 1);
      if (this.localContentMutationsInFlight === 0) {
        if (this.publishCenterContentRefreshRequested) {
          this.publishCenterContentRefreshRequested = false;
          await this.refreshPublishCenter({ content: true });
        } else {
          this.renderCachedPublishCenter();
        }
      }
    }
  }

  private async selectArticle(article: PublishCenterArticle): Promise<void> {
    this.selectedSourcePath = article.sourcePath;
    this.selectedArticleDetail = undefined;
    this.renderCachedPublishCenter();
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
    return openConfirmationModal(this.app, {
      eyebrow: '下一版范围',
      title: `确认下线 ${article.title}？`,
      description: '下一次完整发布会移除线上页面。本地 Markdown 不会删除，当前线上页面也不会立即改变。',
      facts: article.onlineUrl
        ? [{ label: '线上地址', value: article.onlineUrl, tone: 'danger' }]
        : undefined,
      cancelLabel: '保留在线',
      confirmLabel: '确认待下线',
      confirmTone: 'destructive',
    });
  }

  private async renderSetupWizard(container: HTMLElement): Promise<void> {
    let environment = this.application.getInitialSetupEnvironment();
    if (this.setupStep === 0 && environment.stage === 'idle' && environment.nextAction !== 'repair') {
      const preparing = this.application.prepareInitialSetupEnvironment();
      environment = this.application.getInitialSetupEnvironment();
      void preparing.then(() => this.render(), () => this.render()).catch(() => undefined);
    }

    let connection: InitialSetupConnection = { state: 'unavailable' };
    if (this.setupStep >= 3) {
      try { connection = await this.application.getInitialSetupConnection(); }
      catch { connection = { state: 'unavailable' }; }
    }
    const connectedAccount = 'account' in connection ? connection.account : undefined;
    const draft = this.setupDraft ??= this.application.getInitialSetupDraft?.()
      ?? this.newSetupDraft(connectedAccount);
    if (!draft.cloudflare.account.id && connectedAccount) draft.cloudflare.account = connectedAccount;

    if (this.setupStep >= 3 && connection.state === 'connected') {
      try { this.setupAccounts ??= await this.application.listInitialSetupAccounts(); }
      catch { this.setupAccounts ??= []; }
      if (draft.cloudflare.account.id) {
        try { this.setupProjects ??= await this.application.listInitialSetupProjects(draft.cloudflare.account); }
        catch { this.setupProjects ??= []; }
      }
    }

    const rerender = (): void => { void this.renderSetupWizard(container); };
    const root = this.ensurePreactRoot(container);
    renderPreact(<SetupWizardScreen
      accounts={this.setupAccounts ?? []}
      canUseApiToken={this.application.canConnectInitialSetupApiToken()}
      canUseOAuth={this.application.canConnectInitialSetupOAuth()}
      connection={connection}
      draft={draft}
      environment={environment}
      onAddRoot={() => {
        draft.config.contentRoots.push({ path: '', publicRoot: '/' });
        this.setupReview = undefined;
        rerender();
      }}
      onBack={() => {
        this.setupStep = Math.max(0, this.setupStep - 1);
        rerender();
      }}
      onCancelEnvironment={async () => {
        if (this.application.cancelInitialSetupEnvironment()) new Notice('正在取消本地发布环境准备。');
        await this.render();
      }}
      onCheckProject={async () => {
        const projectName = draft.cloudflare.projectName.trim();
        if (!projectName) { new Notice('请输入 Pages 项目标识。'); return; }
        try {
          const projects = await this.application.listInitialSetupProjects(draft.cloudflare.account);
          this.setupProjects = projects;
          this.setupProjectAvailability = {
            name: projectName,
            available: !projects.some((project) => project.name === projectName),
          };
        } catch (error) {
          this.setupProjectAvailability = undefined;
          new Notice(`无法检查 Pages 项目标识：${errorMessage(error)}`);
        }
        rerender();
      }}
      onConnectApiToken={async (token) => {
        try {
          const status = await this.application.connectInitialSetupApiToken(token);
          const account = 'account' in status ? status.account : undefined;
          if (status.state !== 'connected' || !account) throw new Error('Cloudflare 未返回可用于 Pages 发布的账号。');
          draft.cloudflare.account = account;
          this.setupAccounts = undefined;
          this.setupProjects = undefined;
          new Notice(`Cloudflare 已连接：${account.name}`);
        } catch (error) { new Notice(`无法连接 Cloudflare：${errorMessage(error)}`); }
        await this.render();
      }}
      onConnectOAuth={async () => {
        try {
          await this.application.beginInitialSetupOAuth();
          new Notice('已在浏览器打开 Cloudflare 授权；完成后将返回 Obsidian。');
        } catch (error) { new Notice(`无法开始 Cloudflare 授权：${errorMessage(error)}`); }
      }}
      onConfirm={() => this.executeInitialSetup(structuredClone(draft))}
      onConfirmVaultRoot={() => { this.setupVaultRootConfirmed = true; rerender(); }}
      onContinue={() => {
        this.setupStep = Math.min(4, this.setupStep + 1);
        rerender();
      }}
      onExit={() => {
        this.application.preserveInitialSetupDraft(draft);
        this.leaf.detach();
      }}
      onRemoveRoot={(index) => {
        draft.config.contentRoots.splice(index, 1);
        this.setupReview = undefined;
        this.setupVaultRootConfirmed = false;
        rerender();
      }}
      onRepairEnvironment={async () => {
        try { await this.application.repairInitialSetupEnvironment(); }
        catch (error) { new Notice(`无法准备本地发布环境：${errorMessage(error)}`); }
        await this.render();
      }}
      onScanScope={async () => {
        try { this.setupReview = await this.application.reviewInitialSetup(draft); }
        catch (error) {
          this.setupReview = undefined;
          new Notice(`无法扫描设置草稿：${errorMessage(error)}`);
        }
        rerender();
      }}
      onSelectAccount={async (account) => {
        try {
          const selected = this.application.canSelectInitialSetupAccount()
            ? await this.application.selectInitialSetupAccount(account.id)
            : { state: 'connected' as const, account };
          draft.cloudflare.account = ('account' in selected ? selected.account : undefined) ?? account;
          this.setupProjects = undefined;
          this.setupProjectAvailability = undefined;
        } catch (error) { new Notice(`无法切换 Cloudflare 账号：${errorMessage(error)}`); }
        await this.render();
      }}
      onSelectProject={(project) => {
        draft.cloudflare.action = 'bind';
        draft.cloudflare.projectName = project.name;
        draft.config.cloudflare.projectName = project.name;
        this.setupProjectAvailability = undefined;
        rerender();
      }}
      onUpdate={() => {
        this.setupReview = undefined;
        this.setupProjectAvailability = undefined;
        if (!draft.config.contentRoots.some((candidate) => candidate.path.trim() === '.')) {
          this.setupVaultRootConfirmed = false;
        }
        rerender();
      }}
      projectAvailability={this.setupProjectAvailability}
      projects={this.setupProjects ?? []}
      review={this.setupReview}
      step={this.setupStep}
      vaultRootConfirmed={this.setupVaultRootConfirmed}
    />, root);
  }

  private renderSetupExecution(
    container: HTMLElement,
    execution: SetupExecutionState,
  ): void {
    const root = this.ensurePreactRoot(container);
    renderPreact(<SetupExecutionScreen
      candidateCount={execution.state === 'success' ? execution.candidateCount : undefined}
      domain={execution.state === 'success' ? execution.domain : undefined}
      eligibleCount={execution.state === 'success' ? execution.eligibleCount : undefined}
      message={execution.state === 'failed' ? execution.message : undefined}
      onContinue={async () => {
        this.setupExecution = undefined;
        await this.render();
      }}
      onRetry={() => execution.state === 'failed'
        ? this.executeInitialSetup(execution.draft)
        : Promise.resolve()}
      onReturn={async () => {
        this.setupExecution = undefined;
        this.setupStep = 4;
        await this.render();
      }}
      stage={execution.state === 'success' ? undefined : execution.stage}
      state={execution.state}
    />, root);
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

function projectNameFrom(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58);
  return normalized || 'pages-publish-site';
}
