import {
  ButtonComponent,
  DropdownComponent,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';
import type { PagesPublishApplication } from '../application';
import type {
  ArticleIntentPatch,
  EffectiveValue,
  PreparedArticleIntentEdit,
} from '../publication/article-metadata';
import type {
  CurrentArticlePanelArticle,
  CurrentArticlePanelState,
} from '../publication/current-article-panel';
import {
  articleContentIssueLabel,
  LatestCurrentArticleProjection,
} from './current-article-controller';
import { openPluginSettingsInHost } from './settings-navigation';
import { openSiteConfigForRepair } from './site-config-repair-view';

export const CURRENT_ARTICLE_VIEW_TYPE = 'pages-publish-current-article';

type CurrentArticlePropertyEditor =
  | 'title'
  | 'summary'
  | 'date'
  | 'tags'
  | 'cover'
  | 'slug'
  | 'kind'
  | 'order'
  | 'redirects';

export class CurrentArticleView extends ItemView {
  private pinnedPath: string | undefined;
  private activePropertyEditor: CurrentArticlePropertyEditor | undefined;
  private activePropertyEditorSourcePath: string | undefined;
  private focusPropertyEditorOnRender = false;
  private focusPropertyActionOnRender:
    | { sourcePath: string; field: CurrentArticlePropertyEditor }
    | undefined;
  private focusRecheckOnRender = false;
  private focusVisibilityOnRender = false;
  private lastUnpinnedActivePath: string | undefined;
  private readonly propertyDrafts = new Map<string, string>();
  private readonly propertyDraftsNeedingReview = new Set<string>();
  private readonly externalLinkResults = new Map<string, string[]>();
  private readonly projection: LatestCurrentArticleProjection;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly application: PagesPublishApplication,
    private readonly openPublishCenter: () => Promise<void>,
  ) {
    super(leaf);
    this.projection = new LatestCurrentArticleProjection((context) =>
      this.application.getCurrentArticlePanel(context),
    );
  }

  getViewType(): string {
    return CURRENT_ARTICLE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '当前文章发布';
  }

  getIcon(): string {
    return 'file-up';
  }

  async onOpen(): Promise<void> {
    // `data-type` is not present on every Obsidian workspace split.  Mark the
    // owning leaf explicitly so the inspector can reserve a scrollable middle
    // region and keep its action dock in view.
    this.containerEl?.addClass?.('pages-publish-article-panel-host');
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        if (!this.pinnedPath) void this.render();
      }),
    );
    this.register(
      this.application.subscribeCurrentArticleChanges(() => {
        const activeDraft = this.activePropertyDraftKey();
        if (activeDraft) {
          this.propertyDraftsNeedingReview.add(activeDraft);
          this.focusPropertyEditorOnRender = true;
        }
        void this.render();
      }),
    );
    await this.render();
  }

  async onClose(): Promise<void> {
    this.containerEl?.removeClass?.('pages-publish-article-panel-host');
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass(
      'pages-publish-article-panel',
      'pages-publish-article-panel--inspector',
    );
    const shell = container.createDiv({
      cls: 'pages-publish-article-panel__shell',
    });
    const header = shell.createEl('header', {
      cls: 'pages-publish-article-panel__header',
    });
    header.createEl('h2', {
      cls: 'pages-publish-article-panel__header-title',
      text: '当前文章发布',
    });
    const headerActions = header.createDiv({
      cls: 'pages-publish-article-panel__header-actions',
    });
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (!this.pinnedPath) {
      if (this.lastUnpinnedActivePath !== undefined
        && this.lastUnpinnedActivePath !== activePath) {
        this.clearTransientArticleInteraction();
      }
      this.lastUnpinnedActivePath = activePath;
    }
    const pin = new ButtonComponent(headerActions)
      .setIcon(this.pinnedPath ? 'pin-off' : 'pin')
      .setTooltip(this.pinnedPath ? '取消固定文章' : '固定当前文章');
    pin.buttonEl.setAttribute(
      'aria-label',
      this.pinnedPath ? '取消固定文章' : '固定当前文章',
    );
    pin.setDisabled(!this.pinnedPath && !activePath).onClick(async () => {
      this.pinnedPath = this.pinnedPath ? undefined : activePath;
      await this.render();
    });

    const state = await this.projection.resolve({
      activePath,
      pinnedPath: this.pinnedPath,
    });
    if (!state) return;
    const body = shell.createDiv({
      cls: 'pages-publish-article-panel__body',
      attr: {
        role: 'region',
        'aria-label': '当前文章发布详情',
      },
    });
    if (state.status !== 'article') {
      this.renderEmptyState(body, state);
      return;
    }
    const actions = shell.createEl('footer', {
      cls: 'pages-publish-article-panel__actions',
      attr: { 'aria-label': '文章发布操作' },
    });
    this.renderArticle(body, actions, state);
  }

  private clearTransientArticleInteraction(): void {
    this.activePropertyEditor = undefined;
    this.activePropertyEditorSourcePath = undefined;
    this.focusPropertyEditorOnRender = false;
    this.focusPropertyActionOnRender = undefined;
    this.focusRecheckOnRender = false;
    this.focusVisibilityOnRender = false;
  }

  private renderArticle(
    body: HTMLElement,
    actions: HTMLElement,
    state: CurrentArticlePanelArticle,
  ): void {
    const article = body.createDiv({
      cls: 'pages-publish-article-panel__article',
    });
    const identity = article.createDiv({
      cls: 'pages-publish-article-panel__identity',
    });
    const articleIcon = new ButtonComponent(identity).setIcon('file-text');
    articleIcon.buttonEl.addClass('pages-publish-article-panel__article-icon');
    articleIcon.buttonEl.setAttr('aria-hidden', 'true');
    articleIcon.buttonEl.setAttr('tabindex', '-1');
    const identityCopy = identity.createDiv({
      cls: 'pages-publish-article-panel__identity-copy',
    });
    identityCopy.createEl('h3', { text: state.metadata.title.value });
    identityCopy.createEl('code', {
      cls: 'pages-publish-article-panel__path',
      text: state.sourcePath,
    });

    const syncFacts = article.createEl('section', {
      cls: 'pages-publish-article-panel__section pages-publish-article-panel__sync-facts',
      attr: { 'aria-labelledby': 'pages-publish-sync-heading' },
    });
    syncFacts.createEl('h4', {
      cls: 'pages-publish-article-panel__section-title',
      text: '同步状态',
      attr: { id: 'pages-publish-sync-heading' },
    });
    const syncRow = syncFacts.createDiv({
      cls: 'pages-publish-article-panel__sync-row',
    });
    const publicationStatus = syncRow.createDiv({
      cls: `pages-publish-article-panel__status pages-publish-article-panel__status--${state.publicationState}`,
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    const statusIcon = new ButtonComponent(publicationStatus)
      .setIcon(publicationStateIcon(state.publicationState));
    statusIcon.buttonEl.addClass('pages-publish-article-panel__status-icon');
    statusIcon.buttonEl.setAttr('aria-hidden', 'true');
    statusIcon.buttonEl.setAttr('tabindex', '-1');
    publicationStatus.createSpan({ text: publicationStateLabel(state.publicationState) });
    if (state.metadata.deployment?.lastPublishedAt) {
      syncRow.createSpan({
        cls: 'pages-publish-article-panel__sync-timestamp',
        text: `线上版本 ${new Date(state.metadata.deployment.lastPublishedAt).toLocaleString()}`,
      });
    }
    if (state.sitePublicationFailed) {
      syncFacts.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: '上次整站发布失败；这不会覆盖当前文章自身的部署状态，线上仍保持旧版本。',
      });
    }
    if (state.legacyMigration) {
      const migration = article.createEl('details', {
        cls: 'pages-publish-article-panel__section pages-publish-article-panel__migration',
      });
      migration.createEl('summary', { text: '检测到旧发布字段' });
      const migrationContent = migration.createDiv({
        cls: 'pages-publish-article-panel__section-content',
      });
      migrationContent.createEl('p', {
        text: `迁移预览：${state.legacyMigration.legacyFields
          .map((field) => `${field.path}: ${String(field.value)}`)
          .join('、')} → publication.visibility: ${state.legacyMigration.next.visibility.value}。旧字段会原样保留。`,
      });
      new ButtonComponent(migrationContent)
        .setButtonText('迁移到新 schema')
        .onClick(async () => {
          try {
            const result = await this.application.commitArticleIntentEdit(
              state.legacyMigration!,
            );
            new Notice(
              result.scanError
                ? `迁移已保存，但重新扫描失败：${result.scanError.message}`
                : '迁移已保存到 publication；旧字段仍保留。',
            );
          } catch (error) {
            new Notice(`无法迁移旧字段：${errorMessage(error)}`);
          } finally {
            await this.render();
          }
        });
    }

    {
      const container = article.createEl('section', {
        cls: 'pages-publish-article-panel__section pages-publish-article-panel__section--settings',
      });
      container.createEl('h4', { text: '发布设置' });
      const visibilitySetting = new Setting(container)
        .setName('公开方式')
        .setDesc(visibilityDescription(state.metadata.visibility.value));
      const dropdown = new DropdownComponent(visibilitySetting.controlEl)
        .addOption('public', '公开')
        .addOption('unlisted', '不列出')
        .addOption('private', '私密')
        .setValue(state.metadata.visibility.value);
      dropdown.onChange(async (value) => {
        dropdown.setDisabled(true);
        try {
          const prepared = await this.application.prepareArticleRouteIntentEdit(
            state.sourcePath,
            { visibility: value as 'public' | 'unlisted' | 'private' },
          );
          const confirmed = await this.confirmIfNeeded(prepared);
          if (!confirmed) return;
          const result = await this.application.commitArticleIntentEdit(prepared, {
            confirmTakedown: prepared.confirmation !== undefined,
          });
          new Notice(
            result.scanError
              ? `发布意图已保存，但重新扫描失败：${result.scanError.message}`
              : '发布意图已保存；线上内容尚未改变。',
          );
        } catch (error) {
          new Notice(`无法保存发布意图：${errorMessage(error)}`);
        } finally {
          this.focusVisibilityOnRender = true;
          await this.render();
        }
      });
      if (this.focusVisibilityOnRender) {
        this.focusVisibilityOnRender = false;
        dropdown.selectEl.focus();
      }
    }

    const routes = article.createEl('section', {
      cls: 'pages-publish-article-panel__section pages-publish-article-panel__section--routes',
    });
    routes.createEl('h4', { text: 'URL 与重定向' });
    const pendingUrl = this.renderReadonlyFact(
      routes,
      '待发布 URL',
      state.route.pendingUrl ?? '下一版不生成页面',
    );
    const editPendingUrl = new ButtonComponent(pendingUrl)
      .setButtonText('编辑')
      .setTooltip('编辑待发布 URL')
      .onClick(async () => {
        this.activePropertyEditor = 'slug';
        this.activePropertyEditorSourcePath = state.sourcePath;
        this.focusPropertyEditorOnRender = true;
        await this.render();
      });
    this.restorePropertyActionFocus(editPendingUrl, state.sourcePath, 'slug');
    if (this.isPropertyEditorActive(state, 'slug')) {
      this.renderTextOverride(routes, state, 'Slug', 'slug');
    }
    const onlineUrl = this.renderReadonlyFact(
      routes,
      '当前线上 URL',
      state.route.onlineUrl ?? '尚未上线',
    );
    if (state.route.onlineUrl) {
      new ButtonComponent(onlineUrl).setButtonText('打开').onClick(async () => {
        try {
          await this.application.openArticleOnlinePage(state.sourcePath);
        } catch (error) {
          new Notice(`无法打开线上页面：${errorMessage(error)}`);
        }
      });
    }
    this.renderReadonlyFact(
      routes,
      '重定向结果',
      state.route.redirects.length === 0
        ? '无'
        : state.route.redirects
            .map((redirect) => `${redirect.from} → ${redirect.to}`)
            .join('\n'),
    );
    this.renderChecks(article, state);

    const dependencies = article.createEl('details', {
      cls: 'pages-publish-article-panel__section pages-publish-article-panel__dependencies',
    });
    dependencies.createEl('summary', {
      text: `依赖 · 图片 ${state.dependencies.images} · 笔记 ${state.dependencies.notes} · 外链 ${state.dependencies.externalLinks}`,
    });
    const dependenciesContent = dependencies.createDiv({
      cls: 'pages-publish-article-panel__section-content',
    });
    dependenciesContent.createEl('p', {
      text: '本地图片和笔记链接在常规本地扫描中检查；外链只在你明确点击后联网检查。',
    });
    if (state.dependencies.externalLinks > 0) {
      new ButtonComponent(dependenciesContent)
        .setButtonText('检查外链')
        .onClick(async () => {
          try {
            const issues = await this.application.checkExternalLinks();
            const current = issues
              .filter((issue) => issue.sourcePath === state.sourcePath)
              .map((issue) => `第 ${issue.line} 行 · ${issue.message}`);
            this.externalLinkResults.set(state.sourcePath, current);
            new Notice(current.length === 0
              ? '当前文章的外链检查通过。'
              : `当前文章有 ${current.length} 个临时外链警告。`);
          } catch (error) {
            new Notice(`无法检查外链：${errorMessage(error)}`);
          }
          await this.render();
        });
    }
    const externalResults = this.externalLinkResults.get(state.sourcePath) ?? [];
    for (const result of externalResults) {
      dependenciesContent.createEl('p', {
        cls: 'pages-publish-content-issue pages-publish-content-issue--warning',
        text: result,
      });
    }

    const properties = article.createEl('section', {
      cls: 'pages-publish-article-panel__section pages-publish-article-panel__section--properties',
    });
    properties.createEl('h4', { text: '发布属性' });
    this.renderEditableValue(properties, state, '标题', state.metadata.title, 'title', '覆盖');
    this.renderEditableValue(properties, state, '摘要', state.metadata.summary, 'summary', '覆盖');
    this.renderEditableValue(properties, state, '日期', state.metadata.date, 'date', '编辑');
    this.renderEditableValue(properties, state, '标签', {
      value: state.metadata.tags.value.join(', ') || '未设置',
      source: state.metadata.tags.source,
    }, 'tags', '编辑');
    this.renderEditableValue(properties, state, '封面', state.metadata.cover, 'cover', '选择');
    const advanced = properties.createEl('details', {
      cls: 'pages-publish-article-panel__advanced pages-publish-article-panel__disclosure',
    });
    advanced.open = this.isPropertyEditorActive(state, 'kind')
      || this.isPropertyEditorActive(state, 'order')
      || this.isPropertyEditorActive(state, 'redirects')
      || this.shouldRestoreAdvancedPropertyAction(state.sourcePath);
    advanced.createEl('summary', { text: '高级：类型、排序、重定向' });
    this.renderEditableValue(advanced, state, '类型', state.metadata.kind, 'kind', '编辑');
    this.renderEditableValue(advanced, state, '排序', state.metadata.order, 'order', '编辑');
    this.renderEditableValue(advanced, state, '重定向', {
      value: state.metadata.redirects.value.join(', ') || '未设置',
      source: state.metadata.redirects.source,
    }, 'redirects', '编辑');

    const facts = article.createEl('details', {
      cls: 'pages-publish-article-panel__section pages-publish-article-panel__facts',
    });
    facts.createEl('summary', { text: '部署事实（只读）' });
    if (!state.metadata.deployment) {
      facts.createEl('p', { text: '尚无成功部署记录。' });
    } else {
      for (const [label, value] of [
        ['线上 URL', state.metadata.deployment.url],
        ['首次发布', state.metadata.deployment.firstPublishedAt],
        ['最近发布', state.metadata.deployment.lastPublishedAt],
        ['源摘要', state.metadata.deployment.sourceDigest],
        ['部署标识', state.metadata.deployment.deploymentId],
      ] as const) {
        if (value) this.renderReadonlyFact(facts, label, value);
      }
    }

    const actionCopy = actions.createDiv({
      cls: 'pages-publish-article-panel__actions-copy',
    });
    actionCopy.createEl('strong', { text: '发布操作' });
    const environment = this.application.getInitialSetupEnvironment();
    const environmentReady = environment.stage === 'ready';
    if (!environmentReady) {
      actionCopy.createEl('p', {
        cls: 'pages-publish-content-issue pages-publish-content-issue--warning',
        text: '本地发布环境尚未就绪；文章属性仍可编辑，但预览暂不可用。',
      });
    }
    const actionButtons = actions.createDiv({
      cls: [
        'pages-publish-article-panel__action-buttons',
        environmentReady
          ? 'pages-publish-article-panel__action-buttons--ready'
          : 'pages-publish-article-panel__action-buttons--repair',
      ].join(' '),
    });
    if (!environmentReady) {
      new ButtonComponent(actionButtons)
        .setIcon('wrench')
        .setButtonText('修复本地环境')
        .onClick(async () => {
          try {
            await this.application.repairInitialSetupEnvironment();
          } catch (error) {
            new Notice(`无法修复本地环境：${errorMessage(error)}`);
          }
          await this.render();
        });
    }
    new ButtonComponent(actionButtons)
      .setIcon('eye')
      .setButtonText('预览当前文章')
      .setCta()
      .setDisabled(!environmentReady)
      .onClick(async () => {
        try {
          await this.application.openArticlePreview(state.sourcePath);
          new Notice('本地预览已打开；没有发布线上内容。');
        } catch (error) {
          new Notice(`无法打开本地预览：${errorMessage(error)}`);
        }
      });
    new ButtonComponent(actionButtons)
      .setIcon('external-link')
      .setButtonText('打开发布中心')
      .onClick(() => this.openPublishCenter());
  }

  private renderTextOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
    field: 'title' | 'summary' | 'slug' | 'date' | 'cover',
  ): void {
    const initialDraft =
      state.metadata[field]?.source === `publication.${field}`
        ? String(state.metadata[field]?.value ?? '')
        : '';
    let draft = this.propertyDraft(state.sourcePath, field, initialDraft);
    this.renderDraftReviewWarning(container, state.sourcePath, field);
    const setting = new Setting(container)
      .setName(label)
      .setDesc('留空保存会删除显式覆盖，并恢复动态来源。')
      .addText((text) => {
        text
          .setPlaceholder(String(state.metadata[field]?.value ?? ''))
          .setValue(draft)
          .onChange((value) => {
            draft = value;
            this.propertyDrafts.set(
              propertyDraftKey(state.sourcePath, field),
              value,
            );
          });
        text.inputEl.setAttribute('aria-label', `${label}显式覆盖`);
        this.focusPropertyEditor(text.inputEl);
      })
      .addButton((button) =>
        button.setButtonText('保存').onClick(async () => {
          button.setDisabled(true);
          try {
            const patch: ArticleIntentPatch = {
              [field]: draft.trim() || null,
            };
            const prepared =
              field === 'slug'
                ? await this.application.prepareArticleUrlIntentEdit(
                    state.sourcePath,
                    patch.slug ?? null,
                  )
                : await this.application.prepareArticleIntentEdit(
                    state.sourcePath,
                    patch,
                  );
            const result =
              await this.application.commitArticleIntentEdit(prepared);
            this.focusPropertyActionOnRender = { sourcePath: state.sourcePath, field };
            this.finishPropertyEditor(state.sourcePath, field);
            new Notice(
              result.scanError
                ? `属性覆盖已保存，但重新扫描失败：${result.scanError.message}`
                : '属性覆盖已保存；线上内容尚未改变。',
            );
          } catch (error) {
            this.focusPropertyEditorOnRender = true;
            new Notice(`无法保存属性覆盖：${errorMessage(error)}`);
          } finally {
            await this.render();
          }
        }),
      );
    this.addCancelPropertyEditor(setting, state.sourcePath, field);
  }

  private renderListOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
    field: 'tags' | 'redirects',
  ): void {
    const metadata = state.metadata[field];
    const initialDraft =
      metadata.source === `publication.${field}`
        ? metadata.value.join(', ')
        : '';
    let draft = this.propertyDraft(state.sourcePath, field, initialDraft);
    this.renderDraftReviewWarning(container, state.sourcePath, field);
    const setting = new Setting(container)
      .setName(label)
      .setDesc('使用逗号或换行分隔；留空保存会恢复动态来源。')
      .addTextArea((text) => {
        text
          .setPlaceholder(metadata.value.join(', '))
          .setValue(draft)
          .onChange((value) => {
            draft = value;
            this.propertyDrafts.set(
              propertyDraftKey(state.sourcePath, field),
              value,
            );
          });
        text.inputEl.setAttribute('aria-label', `${label}显式覆盖`);
        this.focusPropertyEditor(text.inputEl);
      })
      .addButton((button) =>
        button.setButtonText('保存').onClick(async () => {
          const values = draft
            .split(/[,\n]/)
            .map((value) => value.trim())
            .filter(Boolean);
          await this.saveOverride(
            state,
            { [field]: values.length === 0 ? null : values },
            button,
            field,
          );
        }),
      );
    this.addCancelPropertyEditor(setting, state.sourcePath, field);
  }

  private renderKindOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
  ): void {
    const initialDraft: '' | 'article' | 'index' =
      state.metadata.kind.source === 'publication.kind'
        ? state.metadata.kind.value
        : '';
    let draft = this.propertyDraft(
      state.sourcePath,
      'kind',
      initialDraft,
    ) as '' | 'article' | 'index';
    this.renderDraftReviewWarning(container, state.sourcePath, 'kind');
    const setting = new Setting(container)
      .setName(label)
      .setDesc('留空使用默认 article。')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('', '使用默认值')
          .addOption('article', '文章')
          .addOption('index', '栏目索引')
          .setValue(draft)
          .onChange((value) => {
            draft = value as '' | 'article' | 'index';
            this.propertyDrafts.set(
              propertyDraftKey(state.sourcePath, 'kind'),
              value,
            );
          });
        dropdown.selectEl.setAttribute('aria-label', `${label}显式覆盖`);
        this.focusPropertyEditor(dropdown.selectEl);
      })
      .addButton((button) =>
        button.setButtonText('保存').onClick(() =>
          this.saveOverride(
            state,
            { kind: draft === '' ? null : draft },
            button,
            'kind',
          ),
        ),
      );
    this.addCancelPropertyEditor(setting, state.sourcePath, 'kind');
  }

  private renderOrderOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
  ): void {
    const initialDraft =
      state.metadata.order?.source === 'publication.order'
        ? String(state.metadata.order.value)
        : '';
    let draft = this.propertyDraft(state.sourcePath, 'order', initialDraft);
    this.renderDraftReviewWarning(container, state.sourcePath, 'order');
    const setting = new Setting(container)
      .setName(label)
      .setDesc('有限数字；留空删除显式排序。')
      .addText((text) => {
        text
          .setPlaceholder(
            state.metadata.order ? String(state.metadata.order.value) : '',
          )
          .setValue(draft)
          .onChange((value) => {
            draft = value;
            this.propertyDrafts.set(
              propertyDraftKey(state.sourcePath, 'order'),
              value,
            );
          });
        text.inputEl.setAttribute('aria-label', `${label}显式覆盖`);
        this.focusPropertyEditor(text.inputEl);
      })
      .addButton((button) =>
        button.setButtonText('保存').onClick(async () => {
          const value = draft.trim() === '' ? null : Number(draft);
          if (value !== null && !Number.isFinite(value)) {
            new Notice('排序必须是有限数字。');
            return;
          }
          await this.saveOverride(state, { order: value }, button, 'order');
        }),
      );
    this.addCancelPropertyEditor(setting, state.sourcePath, 'order');
  }

  private async saveOverride(
    state: CurrentArticlePanelArticle,
    patch: ArticleIntentPatch,
    button: ButtonComponent,
    field: CurrentArticlePropertyEditor,
  ): Promise<void> {
    button.setDisabled(true);
    try {
      const prepared =
        patch.kind === undefined && patch.redirects === undefined
          ? await this.application.prepareArticleIntentEdit(
              state.sourcePath,
              patch,
            )
          : await this.application.prepareArticleRouteIntentEdit(
              state.sourcePath,
              {
                ...(patch.kind === undefined ? {} : { kind: patch.kind }),
                ...(patch.redirects === undefined
                  ? {}
                  : { redirects: patch.redirects }),
              },
            );
      const result = await this.application.commitArticleIntentEdit(prepared);
      this.focusPropertyActionOnRender = { sourcePath: state.sourcePath, field };
      this.finishPropertyEditor(state.sourcePath, field);
      new Notice(
        result.scanError
          ? `属性覆盖已保存，但重新扫描失败：${result.scanError.message}`
          : '属性覆盖已保存；线上内容尚未改变。',
      );
    } catch (error) {
      this.focusPropertyEditorOnRender = true;
      new Notice(`无法保存属性覆盖：${errorMessage(error)}`);
    } finally {
      await this.render();
    }
  }

  private renderEditableValue(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
    value: EffectiveValue<unknown, string> | undefined,
    field: CurrentArticlePropertyEditor,
    action: string,
  ): void {
    const row = this.renderValue(container, label, value);
    const propertyAction = new ButtonComponent(row)
      .setButtonText(action)
      .setTooltip(`${action}${label}`)
      .onClick(async () => {
        this.activePropertyEditor = field;
        this.activePropertyEditorSourcePath = state.sourcePath;
        this.focusPropertyEditorOnRender = true;
        await this.render();
      });
    this.restorePropertyActionFocus(propertyAction, state.sourcePath, field);
    if (!this.isPropertyEditorActive(state, field)) return;
    switch (field) {
      case 'title':
      case 'summary':
      case 'date':
      case 'cover':
      case 'slug':
        this.renderTextOverride(container, state, label, field);
        break;
      case 'tags':
      case 'redirects':
        this.renderListOverride(container, state, label, field);
        break;
      case 'kind':
        this.renderKindOverride(container, state, label);
        break;
      case 'order':
        this.renderOrderOverride(container, state, label);
        break;
    }
  }

  private renderChecks(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
  ): void {
    const hasIssues = state.route.issues.length > 0 || state.contentIssues.length > 0;
    const section = container.createEl('details', {
      cls: 'pages-publish-article-panel__checks',
      attr: {
        'data-inspector-section': 'checks',
        'data-state': hasIssues ? 'attention' : 'passed',
      },
    });
    section.open = hasIssues || this.focusRecheckOnRender;
    section.createEl('summary', { text: '检查' });
    const content = section.createDiv({
      cls: 'pages-publish-article-panel__section-content',
    });
    const header = content.createDiv({
      cls: 'pages-publish-article-panel__section-header',
    });
    const recheck = new ButtonComponent(header)
      .setButtonText('重新检查')
      .onClick(async () => {
        this.focusRecheckOnRender = true;
        await this.render();
      });
    if (this.focusRecheckOnRender) {
      this.focusRecheckOnRender = false;
      recheck.buttonEl.focus();
    }
    if (!hasIssues) {
      content.createEl('p', {
        cls: 'pages-publish-article-panel__checks-passed',
        text: '通过 · 未发现阻塞或警告',
      });
      return;
    }
    const checks = [
      ...state.route.issues.map((issue) => ({ kind: 'route' as const, issue })),
      ...state.contentIssues.map((issue) => ({ kind: 'content' as const, issue })),
    ].sort((left, right) =>
      severityOrder(left.issue.severity) - severityOrder(right.issue.severity));
    for (const check of checks) {
      const row = content.createDiv({
        cls: `pages-publish-article-panel__check-item pages-publish-article-panel__check-item--${check.issue.severity}`,
      });
      if (check.kind === 'content') {
        const issue = check.issue;
        row.createEl('strong', {
          text: `${articleContentIssueLabel(issue)} · 第 ${issue.line} 行`,
        });
        row.createEl('code', { text: `${issue.sourcePath}:${issue.line}` });
        row.createEl('p', { text: issue.message });
        row.createEl('small', { text: issue.impact });
        new ButtonComponent(row)
          .setButtonText('定位')
          .setTooltip(`打开 ${issue.sourcePath} 第 ${issue.line} 行`)
          .onClick(() => this.locateContentIssue(issue));
      } else {
        const issue = check.issue;
        row.createEl('strong', {
          text: `${issue.severity === 'blocker' ? '阻塞' : '警告'} · 文件级路由检查`,
        });
        row.createEl('code', { text: issue.sourcePath ?? state.sourcePath });
        row.createEl('p', { text: issue.message });
        row.createEl('small', {
          text: issue.severity === 'blocker'
            ? '发布被阻塞。'
            : '发布会继续，但请确认 URL 与重定向结果。',
        });
        new ButtonComponent(row)
          .setButtonText('定位')
          .setTooltip(`打开 ${issue.sourcePath ?? state.sourcePath}`)
          .onClick(() => this.app.workspace.openLinkText(
            issue.sourcePath ?? state.sourcePath,
            '',
            false,
          ));
      }
    }
  }

  private async locateContentIssue(
    issue: CurrentArticlePanelArticle['contentIssues'][number],
  ): Promise<void> {
    await this.app.workspace.openLinkText(issue.sourcePath, '', false);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    view.editor.setCursor({
      line: Math.max(0, issue.line - 1),
      ch: Math.max(0, issue.column - 1),
    });
    view.editor.focus();
  }

  private renderValue(
    container: HTMLElement,
    label: string,
    value: EffectiveValue<unknown, string> | undefined,
  ): HTMLElement {
    const row = container.createDiv({
      cls: 'pages-publish-article-panel__value',
    });
    row.createSpan({ text: label });
    const detail = row.createDiv();
    detail.createDiv({ text: value === undefined ? '未设置' : String(value.value) });
    detail.createEl('small', {
      text: value === undefined ? '无来源' : sourceLabel(value.source),
    });
    return row;
  }

  private focusPropertyEditor(element: HTMLElement): void {
    if (!this.focusPropertyEditorOnRender) return;
    this.focusPropertyEditorOnRender = false;
    element.focus();
  }

  private addCancelPropertyEditor(
    setting: Setting,
    sourcePath: string,
    field: CurrentArticlePropertyEditor,
  ): void {
    setting.addButton((button) => button
      .setButtonText('取消编辑')
      .onClick(async () => {
        this.focusPropertyActionOnRender = { sourcePath, field };
        this.finishPropertyEditor(sourcePath, field);
        await this.render();
      }));
  }

  private isPropertyEditorActive(
    state: CurrentArticlePanelArticle,
    field: CurrentArticlePropertyEditor,
  ): boolean {
    return this.activePropertyEditor === field
      && this.activePropertyEditorSourcePath === state.sourcePath;
  }

  private activePropertyDraftKey(): string | undefined {
    if (!this.activePropertyEditor || !this.activePropertyEditorSourcePath) {
      return undefined;
    }
    return propertyDraftKey(
      this.activePropertyEditorSourcePath,
      this.activePropertyEditor,
    );
  }

  private propertyDraft(
    sourcePath: string,
    field: CurrentArticlePropertyEditor,
    initialValue: string,
  ): string {
    return this.propertyDrafts.get(propertyDraftKey(sourcePath, field))
      ?? initialValue;
  }

  private renderDraftReviewWarning(
    container: HTMLElement,
    sourcePath: string,
    field: CurrentArticlePropertyEditor,
  ): void {
    if (!this.propertyDraftsNeedingReview.has(propertyDraftKey(sourcePath, field))) {
      return;
    }
    container.createEl('p', {
      cls: 'pages-publish-content-issue pages-publish-content-issue--warning',
      text: '文件或站点配置已变化；未保存草稿已保留，请复核后保存或取消。',
    });
  }

  private finishPropertyEditor(
    sourcePath: string,
    field: CurrentArticlePropertyEditor,
  ): void {
    const key = propertyDraftKey(sourcePath, field);
    this.propertyDrafts.delete(key);
    this.propertyDraftsNeedingReview.delete(key);
    if (this.activePropertyEditorSourcePath !== sourcePath
      || this.activePropertyEditor !== field) return;
    this.activePropertyEditor = undefined;
    this.activePropertyEditorSourcePath = undefined;
    this.focusPropertyEditorOnRender = false;
  }

  private restorePropertyActionFocus(
    action: ButtonComponent,
    sourcePath: string,
    field: CurrentArticlePropertyEditor,
  ): void {
    const target = this.focusPropertyActionOnRender;
    if (!target || target.sourcePath !== sourcePath || target.field !== field) return;
    this.focusPropertyActionOnRender = undefined;
    action.buttonEl.focus();
  }

  private shouldRestoreAdvancedPropertyAction(sourcePath: string): boolean {
    const target = this.focusPropertyActionOnRender;
    return target?.sourcePath === sourcePath
      && (target.field === 'kind'
        || target.field === 'order'
        || target.field === 'redirects');
  }

  private renderReadonlyFact(
    container: HTMLElement,
    label: string,
    value: string,
  ): HTMLElement {
    const row = container.createDiv({
      cls: 'pages-publish-article-panel__fact',
    });
    row.createSpan({ text: label });
    row.createEl('code', { text: value });
    return row;
  }

  private renderEmptyState(
    container: HTMLElement,
    state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>,
  ): void {
    const copy = emptyStateCopy(state);
    container.createEl('h3', { text: copy.title });
    container.createEl('p', { text: copy.description });
    if (state.status === 'missing-pinned') {
      new ButtonComponent(container)
        .setButtonText('取消固定')
        .onClick(async () => {
          this.pinnedPath = undefined;
          await this.render();
        });
    }
    if (state.status === 'no-site') {
      new ButtonComponent(container)
        .setButtonText('开始设置')
        .setCta()
        .onClick(() => this.openPublishCenter());
    }
    if (state.status === 'out-of-scope') {
      new ButtonComponent(container)
        .setButtonText('打开内容范围设置')
        .onClick(() => {
          if (!openPluginSettingsInHost(this.app, 'pages-publish')) {
            new Notice('请从 Obsidian 设置中打开 Pages Publish 的内容范围。');
          }
        });
    }
    if (state.status === 'out-of-scope-online') {
      new ButtonComponent(container)
        .setButtonText('查看发布中心')
        .onClick(() => this.openPublishCenter());
    }
    if (state.status === 'config-error') {
      new ButtonComponent(container)
        .setButtonText('打开并定位')
        .onClick(() => openSiteConfigForRepair({ workspace: this.app.workspace }));
    }
  }

  private async confirmIfNeeded(
    prepared: PreparedArticleIntentEdit,
  ): Promise<boolean> {
    if (!prepared.confirmation) return true;
    return new Promise((resolve) => {
      new TakedownConfirmationModal(this.app, prepared, resolve).open();
    });
  }
}

class TakedownConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: CurrentArticleView['app'],
    private readonly prepared: PreparedArticleIntentEdit,
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
      text: '保存后，下一次整站发布会移除这篇文章的线上页面。本地 Markdown 文件不会被删除，当前线上页面也不会立即改变。',
    });
    const impact = this.contentEl.createDiv({ cls: 'pages-publish-modal__impact' });
    impact.createSpan({ text: '影响范围' });
    impact.createSpan({ text: '仅在下一次整站发布生效' });
    if (this.prepared.confirmation?.onlineUrl) {
      const target = this.contentEl.createDiv({ cls: 'pages-publish-modal__target' });
      target.createSpan({
        cls: 'pages-publish-modal__target-label',
        text: '将下线的线上地址',
      });
      target.createEl('code', {
        text: this.prepared.confirmation.onlineUrl,
      });
    }
    const actions = this.contentEl.createDiv({
      cls: 'pages-publish-modal__actions pages-publish-article-panel__modal-actions',
    });
    new ButtonComponent(actions).setButtonText('取消').onClick(() => {
      this.finish(false);
    });
    new ButtonComponent(actions)
      .setButtonText('确认待下线')
      .setDestructive()
      .onClick(() => {
        this.finish(true);
      });
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

function emptyStateCopy(
  state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>,
): { title: string; description: string } {
  switch (state.status) {
    case 'no-active':
      return {
        title: '当前没有活动文章',
        description: '打开一个 Markdown 文件以查看发布设置。',
      };
    case 'non-markdown':
      return {
        title: '此文件不是可发布的 Markdown',
        description: 'Pages Publish 只把 Markdown 作为内容候选。',
      };
    case 'out-of-scope':
      return {
        title: '此文章不在内容范围内',
        description: `${state.sourcePath} 尚未映射到公开路径。`,
      };
    case 'out-of-scope-online':
      return {
        title: '此文章当前仍在线，但已移出内容范围',
        description: `下一次发布前需要确认是恢复范围还是下线。当前线上 URL：${state.onlineUrl}`,
      };
    case 'missing-pinned':
      return {
        title: '固定的文章已移动或删除',
        description: '取消固定后，面板会继续跟随当前活动文件。',
      };
    case 'config-error':
      return {
        title: '站点配置无效，发布功能已暂停',
        description: state.message,
      };
    case 'no-site':
      return {
        title: '尚未创建发布站点',
        description: '先完成本地站点设置，再管理当前文章的发布意图。',
      };
  }
}

function publicationStateLabel(
  state: CurrentArticlePanelArticle['publicationState'],
): string {
  switch (state) {
    case 'private':
      return '未加入发布 · 默认私密或已明确设为私密';
    case 'pending-first-publish':
      return '等待首次发布 · 尚无线上版本';
    case 'synced':
      return '与线上一致 · 显示最近成功发布时间';
    case 'updated':
      return '有更新 · 等待下一次发布';
    case 'url-changed':
      return 'URL 待更新 · 发布后保留已知旧地址重定向';
    case 'visibility-changed':
      return '可见性待更新 · 当前线上值与待发布值不同';
    case 'pending-takedown':
      return '待下线 · 下一次整站发布将移除线上页面';
    case 'blocked':
      return '无法发布 · 请先修复当前文章的阻塞问题';
    case 'unknown':
      return '状态未知 · 缺少可比较的最近成功部署事实';
  }
}

function publicationStateIcon(
  state: CurrentArticlePanelArticle['publicationState'],
): string {
  switch (state) {
    case 'synced':
      return 'circle-check';
    case 'private':
      return 'lock-keyhole';
    case 'pending-first-publish':
      return 'clock-3';
    case 'updated':
      return 'refresh-cw';
    case 'url-changed':
      return 'link-2';
    case 'visibility-changed':
      return 'eye';
    case 'pending-takedown':
      return 'circle-minus';
    case 'blocked':
      return 'circle-alert';
    case 'unknown':
      return 'circle-help';
  }
}

function visibilityDescription(value: string): string {
  switch (value) {
    case 'public':
      return '任何人可访问，并出现在列表、搜索和图谱中。';
    case 'unlisted':
      return '知道 URL 的人可访问，但不出现在列表、搜索和图谱中。';
    default:
      return '不进入公开构建；已上线内容将在下一次发布时下线。';
  }
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    default: '默认值',
    'first-h1': '来自首个 H1',
    filename: '来自文件名',
    'body-summary': '来自正文摘要',
    'frontmatter.date': '来自文件属性',
    'frontmatter.tags': '来自文件标签',
    'deployment.first_published_at': '来自首次成功发布',
    'deployment.last_published_at': '来自最近成功发布',
  };
  return labels[source] ?? `显式覆盖 · ${source}`;
}

function severityOrder(severity: 'blocker' | 'warning'): number {
  return severity === 'blocker' ? 0 : 1;
}

function propertyDraftKey(
  sourcePath: string,
  field: CurrentArticlePropertyEditor,
): string {
  return `${sourcePath}\u0000${field}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
