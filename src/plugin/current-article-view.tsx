import { ItemView, MarkdownView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { PagesPublishApplication } from '../application';
import type { ArticleIntentPatch, PreparedArticleIntentEdit } from '../publication/article-metadata';
import type { CurrentArticlePanelArticle, CurrentArticlePanelState } from '../publication/current-article-panel';
import {
  ArticleInspectorScreen,
  type ArticleEditorField,
  type ArticleEditorState,
  type ArticleInspectorScreenProps,
} from '../ui/article-inspector/article-inspector-screen';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { mountPreactView, type MountedPreactView } from '../ui/runtime/mount-preact-view';
import { LatestCurrentArticleProjection } from './current-article-controller';
import { openPluginSettingsInHost } from './settings-navigation';
import { openSiteConfigForRepair } from './site-config-repair-view';

export const CURRENT_ARTICLE_VIEW_TYPE = 'pages-publish-current-article';

/** Obsidian host/controller for the Preact article inspector. */
export class CurrentArticleView extends ItemView {
  private lastActivePath: string | undefined;
  private state: CurrentArticlePanelState | undefined;
  private loading = true;
  private busy = false;
  private editor: ArticleEditorState | undefined;
  private focusActionField: ArticleEditorField | undefined;
  private mounted: MountedPreactView<ArticleInspectorScreenProps> | undefined;
  private readonly drafts = new Map<string, string>();
  private readonly draftsNeedingReview = new Set<string>();
  private readonly externalLinkResults = new Map<string, string[]>();
  private readonly projection: LatestCurrentArticleProjection;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly application: PagesPublishApplication,
    private readonly openPublishCenter: () => Promise<void>,
  ) {
    super(leaf);
    this.projection = new LatestCurrentArticleProjection((context) =>
      this.application.getCurrentArticlePanel(context));
  }

  getViewType(): string { return CURRENT_ARTICLE_VIEW_TYPE; }
  getDisplayText(): string { return '当前文章发布'; }
  getIcon(): string { return 'file-up'; }

  async onOpen(): Promise<void> {
    this.containerEl?.addClass?.('pages-publish-article-panel-host');
    this.contentEl.addClass('pages-publish-article-panel');
    this.mounted = mountPreactView(
      this.contentEl,
      (props) => <ArticleInspectorScreen {...props} />,
      this.screenProps(),
    );
    this.registerEvent(this.app.workspace.on('file-open', () => {
      const nextPath = this.app.workspace.getActiveFile()?.path;
      if (nextPath !== this.lastActivePath) this.editor = undefined;
      void this.refresh();
    }));
    this.register(this.application.subscribeCurrentArticleChanges(() => {
      if (this.editor) {
        const key = editorKey(this.editor.sourcePath, this.editor.field);
        this.draftsNeedingReview.add(key);
        this.editor = { ...this.editor, needsReview: true };
      }
      void this.refresh(false);
    }));
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.mounted?.unmount();
    this.mounted = undefined;
    this.contentEl.removeClass('pages-publish-article-panel');
    this.containerEl?.removeClass?.('pages-publish-article-panel-host');
  }

  private screenProps(): ArticleInspectorScreenProps {
    const article = this.articleState();
    return {
      editor: this.editor,
      environmentReady: this.application.getInitialSetupEnvironment?.().stage === 'ready',
      externalLinkResults: article ? (this.externalLinkResults.get(article.sourcePath) ?? []) : [],
      focusActionField: this.focusActionField,
      loading: this.loading,
      state: this.state,
      onCancelEdit: () => this.cancelEditor(),
      onCheckExternalLinks: () => this.checkExternalLinks(),
      onDraftChange: (value) => this.changeDraft(value),
      onEdit: (field) => this.startEditor(field),
      onEmptyAction: (state) => this.handleEmptyAction(state),
      onLegacyMigration: () => this.migrateLegacyFields(),
      onLocateContentIssue: (index) => this.locateContentIssue(index),
      onLocateRouteIssue: (index) => this.locateRouteIssue(index),
      onOpenOnline: () => this.openOnline(),
      onOpenPublishCenter: () => this.openPublishCenter(),
      onPreview: () => this.preview(),
      onRecheck: () => this.refresh(),
      onRepairEnvironment: () => this.repairEnvironment(),
      onSaveEdit: () => this.saveEditor(),
      onVisibilityChange: (value) => this.changeVisibility(value),
    };
  }

  private update(): void {
    this.mounted?.update(this.screenProps());
  }

  private async refresh(showLoading = true): Promise<void> {
    const activePath = this.app.workspace.getActiveFile()?.path;
    this.lastActivePath = activePath;
    if (showLoading && this.state === undefined) {
      this.loading = true;
      this.update();
    }
    const state = await this.projection.resolve({ activePath });
    if (!state) return;
    this.state = state;
    this.loading = false;
    if (this.editor && (state.status !== 'article' || state.sourcePath !== this.editor.sourcePath)) {
      this.editor = undefined;
    }
    this.update();
  }

  private articleState(): CurrentArticlePanelArticle | undefined {
    return this.state?.status === 'article' ? this.state : undefined;
  }

  private startEditor(field: ArticleEditorField): void {
    const state = this.articleState();
    if (!state) return;
    const key = editorKey(state.sourcePath, field);
    this.focusActionField = undefined;
    this.editor = {
      busy: false,
      draft: this.drafts.get(key) ?? initialEditorValue(state, field),
      field,
      needsReview: this.draftsNeedingReview.has(key),
      sourcePath: state.sourcePath,
    };
    this.update();
  }

  private changeDraft(value: string): void {
    if (!this.editor) return;
    this.drafts.set(editorKey(this.editor.sourcePath, this.editor.field), value);
    this.editor = { ...this.editor, draft: value };
    this.update();
  }

  private cancelEditor(): void {
    if (!this.editor) return;
    const { field, sourcePath } = this.editor;
    const key = editorKey(sourcePath, field);
    this.drafts.delete(key);
    this.draftsNeedingReview.delete(key);
    this.editor = undefined;
    this.focusActionField = field;
    this.update();
  }

  private async saveEditor(): Promise<void> {
    const state = this.articleState();
    const editor = this.editor;
    if (!state || !editor || editor.busy || editor.sourcePath !== state.sourcePath) return;
    let patch: ArticleIntentPatch;
    try {
      patch = editorPatch(editor.field, editor.draft);
    } catch (error) {
      new Notice(errorMessage(error));
      return;
    }
    this.editor = { ...editor, busy: true };
    this.update();
    try {
      const prepared = await this.prepareEdit(state.sourcePath, editor.field, patch);
      if (!await this.confirmPrepared(prepared)) return;
      const result = await this.application.commitArticleIntentEdit(prepared, {
        confirmTakedown: prepared.confirmation !== undefined,
      });
      const key = editorKey(state.sourcePath, editor.field);
      this.drafts.delete(key);
      this.draftsNeedingReview.delete(key);
      this.editor = undefined;
      this.focusActionField = editor.field;
      new Notice(result.scanError
        ? `属性覆盖已保存，但重新扫描失败：${result.scanError.message}`
        : '属性覆盖已保存；线上内容尚未改变。');
    } catch (error) {
      this.editor = { ...editor, busy: false };
      new Notice(`无法保存属性覆盖：${errorMessage(error)}`);
    }
    await this.refresh(false);
  }

  private prepareEdit(
    sourcePath: string,
    field: ArticleEditorField,
    patch: ArticleIntentPatch,
  ): Promise<PreparedArticleIntentEdit> {
    if (field === 'slug') return this.application.prepareArticleUrlIntentEdit(sourcePath, patch.slug ?? null);
    if (field === 'kind' || field === 'redirects') {
      return this.application.prepareArticleRouteIntentEdit(sourcePath, {
        ...(patch.kind === undefined ? {} : { kind: patch.kind }),
        ...(patch.redirects === undefined ? {} : { redirects: patch.redirects }),
      });
    }
    return this.application.prepareArticleIntentEdit(sourcePath, patch);
  }

  private async changeVisibility(value: 'public' | 'unlisted' | 'private'): Promise<void> {
    const state = this.articleState();
    if (!state || this.busy || state.metadata.visibility.value === value) return;
    this.busy = true;
    try {
      const prepared = await this.application.prepareArticleRouteIntentEdit(state.sourcePath, { visibility: value });
      if (!await this.confirmPrepared(prepared)) return;
      const result = await this.application.commitArticleIntentEdit(prepared, {
        confirmTakedown: prepared.confirmation !== undefined,
      });
      new Notice(result.scanError
        ? `发布意图已保存，但重新扫描失败：${result.scanError.message}`
        : '发布意图已保存；线上内容尚未改变。');
    } catch (error) {
      new Notice(`无法保存发布意图：${errorMessage(error)}`);
    } finally {
      this.busy = false;
      await this.refresh(false);
    }
  }

  private async confirmPrepared(prepared: PreparedArticleIntentEdit): Promise<boolean> {
    if (!prepared.confirmation) return true;
    return openConfirmationModal(this.app, {
      eyebrow: '下一版影响',
      title: '确认将文章设为待下线？',
      description: '本地 Markdown 不会被删除，当前线上页面也不会立即改变。下一次整站发布才会移除页面。',
      facts: prepared.confirmation.onlineUrl
        ? [{ label: '线上地址', value: prepared.confirmation.onlineUrl, tone: 'danger' }]
        : undefined,
      cancelLabel: '取消',
      confirmLabel: '确认待下线',
      confirmTone: 'destructive',
    });
  }

  private async migrateLegacyFields(): Promise<void> {
    const state = this.articleState();
    if (!state?.legacyMigration || this.busy) return;
    this.busy = true;
    try {
      const result = await this.application.commitArticleIntentEdit(state.legacyMigration);
      new Notice(result.scanError
        ? `迁移已保存，但重新扫描失败：${result.scanError.message}`
        : '迁移已保存到 publication；旧字段仍保留。');
    } catch (error) {
      new Notice(`无法迁移旧字段：${errorMessage(error)}`);
    } finally {
      this.busy = false;
      await this.refresh(false);
    }
  }

  private async checkExternalLinks(): Promise<void> {
    const state = this.articleState();
    if (!state || this.busy) return;
    this.busy = true;
    try {
      const issues = await this.application.checkExternalLinks();
      const current = issues
        .filter((issue) => issue.sourcePath === state.sourcePath)
        .map((issue) => `第 ${issue.line} 行 · ${issue.message}`);
      this.externalLinkResults.set(state.sourcePath, current);
      new Notice(current.length === 0 ? '当前文章的外链检查通过。' : `当前文章有 ${current.length} 个临时外链警告。`);
    } catch (error) {
      new Notice(`无法检查外链：${errorMessage(error)}`);
    } finally {
      this.busy = false;
      this.update();
    }
  }

  private async locateContentIssue(index: number): Promise<void> {
    const issue = this.articleState()?.contentIssues[index];
    if (!issue) return;
    await this.app.workspace.openLinkText(issue.sourcePath, '', false);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    view.editor.setCursor({ line: Math.max(0, issue.line - 1), ch: Math.max(0, issue.column - 1) });
    view.editor.focus();
  }

  private async locateRouteIssue(index: number): Promise<void> {
    const state = this.articleState();
    const issue = state?.route.issues[index];
    if (!state || !issue) return;
    await this.app.workspace.openLinkText(issue.sourcePath ?? state.sourcePath, '', false);
  }

  private async openOnline(): Promise<void> {
    const state = this.articleState();
    if (!state) return;
    try { await this.application.openArticleOnlinePage(state.sourcePath); }
    catch (error) { new Notice(`无法打开线上页面：${errorMessage(error)}`); }
  }

  private async preview(): Promise<void> {
    const state = this.articleState();
    if (!state) return;
    try {
      await this.application.openArticlePreview(state.sourcePath);
      new Notice('本地预览已打开；没有发布线上内容。');
    } catch (error) { new Notice(`无法打开本地预览：${errorMessage(error)}`); }
  }

  private async repairEnvironment(): Promise<void> {
    try { await this.application.repairInitialSetupEnvironment(); }
    catch (error) { new Notice(`无法修复本地环境：${errorMessage(error)}`); }
    await this.refresh(false);
  }

  private async handleEmptyAction(
    state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>,
  ): Promise<void> {
    if (state.status === 'no-site' || state.status === 'out-of-scope-online') {
      await this.openPublishCenter();
    } else if (state.status === 'out-of-scope') {
      if (!openPluginSettingsInHost(this.app, 'pages-publish')) new Notice('请从 Obsidian 设置中打开 Pages Publish 的内容范围。');
    } else if (state.status === 'config-error') {
      await openSiteConfigForRepair({ workspace: this.app.workspace });
    }
  }
}

function editorKey(sourcePath: string, field: ArticleEditorField): string {
  return `${sourcePath}\u0000${field}`;
}

function initialEditorValue(state: CurrentArticlePanelArticle, field: ArticleEditorField): string {
  const value = state.metadata[field];
  if (!value || value.source !== `publication.${field}`) return '';
  if (Array.isArray(value.value)) return value.value.join(', ');
  return String(value.value);
}

function editorPatch(field: ArticleEditorField, draft: string): ArticleIntentPatch {
  const value = draft.trim();
  if (field === 'tags' || field === 'redirects') {
    const values = draft.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    return { [field]: values.length === 0 ? null : values };
  }
  if (field === 'kind') return { kind: value === '' ? null : value as 'article' | 'index' };
  if (field === 'order') {
    if (value === '') return { order: null };
    const order = Number(value);
    if (!Number.isFinite(order)) throw new Error('排序必须是有限数字。');
    return { order };
  }
  return { [field]: value || null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
