import {
  ButtonComponent,
  DropdownComponent,
  ItemView,
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
  articleIntentEditorFields,
  LatestCurrentArticleProjection,
} from './current-article-controller';

export const CURRENT_ARTICLE_VIEW_TYPE = 'pages-publish-current-article';

export class CurrentArticleView extends ItemView {
  private pinnedPath: string | undefined;
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
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        if (!this.pinnedPath) void this.render();
      }),
    );
    this.register(
      this.application.subscribeCurrentArticleChanges(() => {
        void this.render();
      }),
    );
    await this.render();
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-article-panel');
    const header = container.createDiv({
      cls: 'pages-publish-article-panel__header',
    });
    header.createEl('h2', { text: '当前文章发布' });
    const activePath = this.app.workspace.getActiveFile()?.path;
    const pin = new ButtonComponent(header)
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
    if (state.status !== 'article') {
      this.renderEmptyState(container, state);
      return;
    }
    this.renderArticle(container, state);
  }

  private renderArticle(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
  ): void {
    container.createEl('h3', { text: state.metadata.title.value });
    container.createEl('code', {
      cls: 'pages-publish-article-panel__path',
      text: state.sourcePath,
    });
    container.createDiv({
      cls: `pages-publish-article-panel__status pages-publish-article-panel__status--${state.publicationState}`,
      text: publicationStateLabel(state.publicationState),
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    if (state.legacyMigration) {
      const migration = container.createEl('details', {
        cls: 'pages-publish-article-panel__migration',
      });
      migration.createEl('summary', { text: '检测到旧发布字段' });
      migration.createEl('p', {
        text: `迁移预览：${state.legacyMigration.legacyFields
          .map((field) => `${field.path}: ${String(field.value)}`)
          .join('、')} → publication.visibility: ${state.legacyMigration.next.visibility.value}。旧字段会原样保留。`,
      });
      new ButtonComponent(migration)
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

    container.createEl('h4', { text: '发布' });
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
        const prepared = await this.application.prepareArticleIntentEdit(
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
        await this.render();
      }
    });

    container.createEl('h4', { text: '发布属性' });
    this.renderValue(container, '标题', state.metadata.title);
    this.renderValue(container, '摘要', state.metadata.summary);
    this.renderValue(container, '日期', state.metadata.date);
    this.renderValue(container, '更新', state.metadata.updated);
    this.renderValue(container, '标签', {
      value: state.metadata.tags.value.join(', ') || '未设置',
      source: state.metadata.tags.source,
    });
    this.renderValue(container, '封面', state.metadata.cover);
    this.renderValue(container, '类型', state.metadata.kind);
    this.renderValue(container, '排序', state.metadata.order);
    this.renderValue(container, '重定向', {
      value: state.metadata.redirects.value.join(', ') || '未设置',
      source: state.metadata.redirects.source,
    });
    for (const field of articleIntentEditorFields) {
      switch (field.kind) {
        case 'text':
          this.renderTextOverride(container, state, field.label, field.name);
          break;
        case 'list':
          this.renderListOverride(container, state, field.label, field.name);
          break;
        case 'select':
          this.renderKindOverride(container, state, field.label);
          break;
        case 'number':
          this.renderOrderOverride(container, state, field.label);
          break;
      }
    }

    const facts = container.createEl('details', {
      cls: 'pages-publish-article-panel__facts',
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

    const actions = container.createDiv({
      cls: 'pages-publish-article-panel__actions',
    });
    new ButtonComponent(actions)
      .setButtonText('预览当前文章')
      .setCta()
      .onClick(async () => {
        try {
          await this.application.openArticlePreview(state.sourcePath);
          new Notice('本地预览已打开；没有发布线上内容。');
        } catch (error) {
          new Notice(`无法打开本地预览：${errorMessage(error)}`);
        }
      });
    new ButtonComponent(actions)
      .setButtonText('打开发布中心')
      .onClick(() => this.openPublishCenter());
  }

  private renderTextOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
    field: 'title' | 'summary' | 'slug' | 'date' | 'updated' | 'cover',
  ): void {
    let draft =
      state.metadata[field]?.source === `publication.${field}`
        ? String(state.metadata[field]?.value ?? '')
        : '';
    new Setting(container)
      .setName(label)
      .setDesc('留空保存会删除显式覆盖，并恢复动态来源。')
      .addText((text) => {
        text
          .setPlaceholder(String(state.metadata[field]?.value ?? ''))
          .setValue(draft)
          .onChange((value) => {
            draft = value;
          });
      })
      .addButton((button) =>
        button.setButtonText('保存').onClick(async () => {
          button.setDisabled(true);
          try {
            const patch: ArticleIntentPatch = {
              [field]: draft.trim() || null,
            };
            const prepared = await this.application.prepareArticleIntentEdit(
              state.sourcePath,
              patch,
            );
            const result =
              await this.application.commitArticleIntentEdit(prepared);
            new Notice(
              result.scanError
                ? `属性覆盖已保存，但重新扫描失败：${result.scanError.message}`
                : '属性覆盖已保存；线上内容尚未改变。',
            );
          } catch (error) {
            new Notice(`无法保存属性覆盖：${errorMessage(error)}`);
          } finally {
            await this.render();
          }
        }),
      );
  }

  private renderListOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
    field: 'tags' | 'redirects',
  ): void {
    const metadata = state.metadata[field];
    let draft =
      metadata.source === `publication.${field}`
        ? metadata.value.join(', ')
        : '';
    new Setting(container)
      .setName(label)
      .setDesc('使用逗号或换行分隔；留空保存会恢复动态来源。')
      .addTextArea((text) => {
        text
          .setPlaceholder(metadata.value.join(', '))
          .setValue(draft)
          .onChange((value) => {
            draft = value;
          });
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
          );
        }),
      );
  }

  private renderKindOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
  ): void {
    let draft: '' | 'article' | 'index' =
      state.metadata.kind.source === 'publication.kind'
        ? state.metadata.kind.value
        : '';
    new Setting(container)
      .setName(label)
      .setDesc('留空使用默认 article。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('', '使用默认值')
          .addOption('article', '文章')
          .addOption('index', '栏目索引')
          .setValue(draft)
          .onChange((value) => {
            draft = value as '' | 'article' | 'index';
          }),
      )
      .addButton((button) =>
        button.setButtonText('保存').onClick(() =>
          this.saveOverride(
            state,
            { kind: draft === '' ? null : draft },
            button,
          ),
        ),
      );
  }

  private renderOrderOverride(
    container: HTMLElement,
    state: CurrentArticlePanelArticle,
    label: string,
  ): void {
    let draft =
      state.metadata.order?.source === 'publication.order'
        ? String(state.metadata.order.value)
        : '';
    new Setting(container)
      .setName(label)
      .setDesc('有限数字；留空删除显式排序。')
      .addText((text) =>
        text
          .setPlaceholder(
            state.metadata.order ? String(state.metadata.order.value) : '',
          )
          .setValue(draft)
          .onChange((value) => {
            draft = value;
          }),
      )
      .addButton((button) =>
        button.setButtonText('保存').onClick(async () => {
          const value = draft.trim() === '' ? null : Number(draft);
          if (value !== null && !Number.isFinite(value)) {
            new Notice('排序必须是有限数字。');
            return;
          }
          await this.saveOverride(state, { order: value }, button);
        }),
      );
  }

  private async saveOverride(
    state: CurrentArticlePanelArticle,
    patch: ArticleIntentPatch,
    button: ButtonComponent,
  ): Promise<void> {
    button.setDisabled(true);
    try {
      const prepared = await this.application.prepareArticleIntentEdit(
        state.sourcePath,
        patch,
      );
      const result = await this.application.commitArticleIntentEdit(prepared);
      new Notice(
        result.scanError
          ? `属性覆盖已保存，但重新扫描失败：${result.scanError.message}`
          : '属性覆盖已保存；线上内容尚未改变。',
      );
    } catch (error) {
      new Notice(`无法保存属性覆盖：${errorMessage(error)}`);
    } finally {
      await this.render();
    }
  }

  private renderValue(
    container: HTMLElement,
    label: string,
    value: EffectiveValue<unknown, string> | undefined,
  ): void {
    const row = container.createDiv({
      cls: 'pages-publish-article-panel__value',
    });
    row.createSpan({ text: label });
    const detail = row.createDiv();
    detail.createDiv({ text: value === undefined ? '未设置' : String(value.value) });
    detail.createEl('small', {
      text: value === undefined ? '无来源' : sourceLabel(value.source),
    });
  }

  private renderReadonlyFact(
    container: HTMLElement,
    label: string,
    value: string,
  ): void {
    const row = container.createDiv({
      cls: 'pages-publish-article-panel__fact',
    });
    row.createSpan({ text: label });
    row.createEl('code', { text: value });
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
    this.titleEl.setText('确认待下线');
    this.contentEl.createEl('p', {
      text: '保存后，该文章会在下一次整站发布时下线；当前线上页面不会立即改变。',
    });
    if (this.prepared.confirmation?.onlineUrl) {
      this.contentEl.createEl('code', {
        text: this.prepared.confirmation.onlineUrl,
      });
    }
    const actions = this.contentEl.createDiv({
      cls: 'pages-publish-article-panel__modal-actions',
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
        title: '当前文件不是 Markdown',
        description: '发布设置仅适用于内容范围内的 Markdown 文件。',
      };
    case 'out-of-scope':
      return {
        title: '这篇文章不在内容范围内',
        description: '可在插件设置中查看或调整内容范围。',
      };
    case 'missing-pinned':
      return {
        title: '固定的文章已不存在',
        description: '取消固定后，面板会继续跟随当前活动文件。',
      };
    case 'config-error':
      return {
        title: '无法读取发布配置',
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
    case 'deployed':
      return '已有线上版本 · 本地意图与线上事实分开显示';
    case 'pending-takedown':
      return '待下线 · 下一次整站发布将移除线上页面';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
