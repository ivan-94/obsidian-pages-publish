import {
  Notice,
  Plugin,
  PluginSettingTab,
  type DataAdapter,
  type SettingDefinitionItem,
} from 'obsidian';
import { render as renderPreact } from 'preact';
import type { ComponentChildren } from 'preact';
import type {
  ConfiguredCustomDomainStatus,
  PagesPublishApplication,
} from '../application';
import {
  SiteConfigEditorSession,
  SiteSettingsService,
  type SiteConfigEditorState,
  type SiteUrlChange,
} from '../config/site-settings';
import {
  loadSiteConfigFromDirectory,
  validateSiteConfigForDirectory,
} from '../config/site-config';
import { openSiteConfigForRepair } from './site-config-repair-view';
import { MAX_LOCAL_THEME_BYTES } from '../theme/theme-installer';
import {
  isExternalThemeReference,
  type ExternalThemeReference,
} from '../theme/theme-contract';
import { SettingsMessageScreen, SettingsScreen, type SettingsEnvironmentSummary, type SettingsScreenProps } from '../ui/settings/settings-screen';
import { ObsidianButton } from '../ui/obsidian/obsidian-button';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { openThemeManager } from './theme-manager-view';

const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

export async function trashHiddenSiteConfig(adapter: Pick<DataAdapter, 'trashSystem' | 'trashLocal'>): Promise<void> {
  if (!(await adapter.trashSystem('.publish/site.yml'))) await adapter.trashLocal('.publish/site.yml');
}

export class PagesPublishSettingTab extends PluginSettingTab {
  private settingsRoot?: HTMLElement;
  private settingsBusy?: string;
  private session?: SiteConfigEditorSession;
  private editorState?: SiteConfigEditorState;
  private pendingUrlChanges?: SiteUrlChange[];
  private rendering = 0;
  private unsubscribeGlobalUiState: (() => void) | undefined;

  constructor(
    plugin: Plugin,
    private readonly vaultRoot: string,
    private readonly application: PagesPublishApplication,
  ) {
    super(plugin.app, plugin);
  }

  getExternalThemeDraft(): ExternalThemeReference | undefined {
    const reference = this.editorState?.draft.site.theme;
    return reference && isExternalThemeReference(reference)
      ? structuredClone(reference)
      : undefined;
  }

  setExternalThemeDraft(reference: ExternalThemeReference): void {
    this.updateDraft((draft) => {
      draft.site.theme = structuredClone(reference);
    });
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: '站点发布设置',
        desc: '站点、内容范围、Cloudflare、站点功能和本地配置',
        aliases: ['Pages Publish', 'site.yml'],
        render: (setting) => {
          const rendering = ++this.rendering;
          const container = setting.settingEl;
          container.empty();
          container.addClass('pages-publish-settings');
          this.settingsRoot = container.createDiv({ cls: 'pages-publish-settings__preact-root pages-publish-ui' });
          renderPreact(<SettingsMessageScreen description="正在读取 .publish/site.yml。" title="正在载入设置" />, this.settingsRoot);
          void this.render(container, rendering);
          return () => {
            if (rendering === this.rendering) this.rendering += 1;
            if (this.settingsRoot) renderPreact(null, this.settingsRoot);
            this.settingsRoot = undefined;
          };
        },
      },
    ];
  }

  hide(): void {
    this.unsubscribeGlobalUiState?.();
    this.unsubscribeGlobalUiState = undefined;
    this.session = undefined;
    this.editorState = undefined;
    this.pendingUrlChanges = undefined;
    this.rendering += 1;
    if (this.settingsRoot) renderPreact(null, this.settingsRoot);
    this.settingsRoot = undefined;
  }

  async notifyConfigFileChanged(): Promise<void> {
    if (!this.session) return;
    try {
      this.editorState = await this.session.detectExternalChange();
      this.update();
    } catch {
      this.editorState = this.session.getState();
      this.update();
    }
  }

  private async render(container: HTMLElement, rendering: number): Promise<void> {
    if (this.session) {
      const state = this.editorState ?? this.session.getState();
      this.editorState = state;
      this.renderEditor(container, state);
      return;
    }

    let loaded;
    try {
      loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    } catch (error) {
      if (rendering !== this.rendering) return;
      this.renderMessage(
        isMissingFile(error) ? '尚未创建站点配置' : '无法读取站点配置',
        isMissingFile(error) ? '请从 Ribbon 打开首次设置。' : errorMessage(error),
        isMissingFile(error) ? undefined : <ObsidianButton label="打开并定位配置" onClick={() => openSiteConfigForRepair({ workspace: this.app.workspace })} />,
      );
      return;
    }
    if (rendering !== this.rendering) return;

    if (loaded.status === 'future-version') {
      this.renderMessage('配置版本过新', `配置版本 ${loaded.version} 高于当前支持范围。当前版本不会保存或发布此配置。`);
      return;
    }

    if (!this.session) {
      this.session = await SiteConfigEditorSession.open(this.vaultRoot);
      this.editorState = this.session.getState();
    }
    if (rendering !== this.rendering || !this.session) return;
    const state = this.editorState ?? this.session.getState();
    this.editorState = state;
    this.renderEditor(container, state);
  }

  private renderEditor(container: HTMLElement, state: SiteConfigEditorState): void {
    if (!this.settingsRoot || !container.contains(this.settingsRoot)) {
      this.settingsRoot = container.createDiv({ cls: 'pages-publish-settings__preact-root pages-publish-ui' });
    }
    renderPreact(<SettingsScreen {...this.settingsProps(state)} />, this.settingsRoot);
  }

  private renderMessage(title: string, description: string, action?: ComponentChildren): void {
    if (!this.settingsRoot) return;
    renderPreact(<SettingsMessageScreen action={action} description={description} title={title} />, this.settingsRoot);
  }

  private settingsProps(state: SiteConfigEditorState): SettingsScreenProps {
    this.ensureOAuthResultSubscription();
    return {
      busy: this.settingsBusy,
      environment: this.environmentSummary(),
      pendingUrlChanges: this.pendingUrlChanges,
      state,
      onAddRoot: () => this.updateDraft((draft) => { draft.contentRoots.push({ path: '', publicRoot: '/' }); }),
      onBindDomain: (domain) => this.bindDomain(domain),
      onBindProject: (project) => this.bindProject(project),
      onClearCache: () => this.runSettingsAction('正在清理可重建缓存', async () => {
        await this.application.clearRebuildableCache();
        new Notice('可重建缓存已清理；Vault、线上站点和凭据未受影响。');
      }),
      onConnectToken: (token) => this.connectApiToken(token),
      onDiscard: () => this.discardSettings(),
      onExportDiagnostics: () => this.exportDiagnostics(),
      onOpenConfig: () => { this.closeSettings(); void openSiteConfigForRepair({ workspace: this.app.workspace }); },
      onOpenLogs: async () => { this.closeSettings(); await this.application.openMaintenanceLogs(); },
      onOpenPublish: async () => { this.closeSettings(); await this.openPublishCenter(); },
      onOpenThemeManager: async () => { this.closeSettings(); await openThemeManager(this.app.workspace); },
      onReloadConflict: () => this.reloadConflict(),
      onRemoveRoot: (index) => this.removeContentRoot(index),
      onRepairEnvironment: () => this.runSettingsAction('正在修复本地环境', async () => {
        await this.application.repairEnvironment();
        new Notice('本地环境已修复。');
      }),
      onSave: () => this.saveSettings(),
      ...(this.application.canConnectInitialSetupOAuth()
        ? { onStartOAuth: () => this.startOAuth() }
        : {}),
      onStartPreview: () => this.runSettingsAction('正在启动本地预览', async () => {
        await this.application.openPreview();
        new Notice('本地预览已打开。');
      }),
      onUpdate: (change) => this.updateDraft(change),
      onValidate: () => this.validateSettings(),
    };
  }

  private environmentSummary(): SettingsEnvironmentSummary {
    const environment = this.application.getInitialSetupEnvironment();
    const runtime = 'runtime' in environment ? environment.runtime : undefined;
    const engine = 'engine' in environment ? environment.engine : undefined;
    const preview = this.application.getPreviewStatus();
    const maintenance = this.application.getMaintenanceStatus();
    return {
      cache: 'cache' in maintenance ? maintenance.cache.state : '宿主未接入',
      connection: 'connection' in maintenance ? maintenance.connection.state : '宿主未接入',
      engine: engine ? engine.version : '尚未取得兼容版本',
      preview: preview.state === 'running' ? `运行中 · ${preview.url}` : '未运行',
      runtime: runtime ? `${runtime.source === 'obsidian' ? 'Obsidian 内嵌' : '插件管理'} · ${runtime.version}` : '尚未取得兼容运行时',
      stage: environment.stage,
    };
  }

  private async runSettingsAction(label: string, action: () => Promise<void>): Promise<void> {
    if (this.settingsBusy) return;
    this.settingsBusy = label;
    this.renderCurrentSettings();
    try {
      await action();
    } catch (error) {
      new Notice(`${label.replace('正在', '')}失败：${errorMessage(error)}`);
    } finally {
      this.settingsBusy = undefined;
      this.renderCurrentSettings();
    }
  }

  private renderCurrentSettings(): void {
    if (this.editorState && this.settingsRoot) {
      renderPreact(<SettingsScreen {...this.settingsProps(this.editorState)} />, this.settingsRoot);
    }
  }

  private async reloadConflict(): Promise<void> {
    if (!this.session) return;
    try {
      this.editorState = await this.session.reloadExternal();
      this.pendingUrlChanges = undefined;
      this.renderCurrentSettings();
    } catch (error) {
      new Notice(`无法重新载入配置：${errorMessage(error)}`);
    }
  }

  private async discardSettings(): Promise<void> {
    if (!this.session) return;
    const reloaded = await reloadSettingsDraft(this.session);
    this.editorState = reloaded.state;
    this.pendingUrlChanges = undefined;
    if (reloaded.error) new Notice(`无法重新载入配置；已保留当前草稿：${reloaded.error}`);
    this.renderCurrentSettings();
  }

  private async validateSettings(): Promise<void> {
    try {
      await validateSiteConfigForDirectory(this.vaultRoot, this.session?.getState().draft ?? this.editorState!.draft);
      new Notice('配置验证通过。');
    } catch (error) {
      new Notice(`配置验证失败：${errorMessage(error)}`);
    }
  }

  private async saveSettings(): Promise<void> {
    if (!this.session) return;
    await this.runSettingsAction('正在保存设置', async () => {
      const saveInput = this.session!.getSaveInput();
      const service = new SiteSettingsService(this.vaultRoot, { scan: () => this.application.requestScan('config-save') });
      const urlChanges = await service.previewUrlChanges(saveInput.draft);
      if (urlChanges.length > 0 && JSON.stringify(urlChanges) !== JSON.stringify(this.pendingUrlChanges ?? [])) {
        this.pendingUrlChanges = urlChanges;
        new Notice('请先审阅 URL 影响，然后再次点击“保存设置”确认。');
        return;
      }
      const result = await service.save(saveInput.draft, saveInput.expectedRevision);
      this.session = await SiteConfigEditorSession.open(this.vaultRoot);
      this.editorState = this.session.getState();
      this.pendingUrlChanges = undefined;
      const blockers = scanBlockerCount(result.scan);
      new Notice(blockers > 0 ? `配置已保存并完成扫描；发现 ${blockers} 个阻塞。没有执行发布。` : '配置已保存并完成扫描。没有执行发布。');
      if (blockers > 0) await this.openPublishCenter('issues');
    });
  }

  private async removeContentRoot(index: number): Promise<void> {
    const state = this.session?.getState();
    const root = state?.draft.contentRoots[index];
    if (!state || !root || state.draft.contentRoots.length === 1) return;
    try {
      const proposed = structuredClone(state.draft);
      proposed.contentRoots.splice(index, 1);
      const takedowns = await new SiteSettingsService(this.vaultRoot).previewTakedowns(proposed);
      const confirmed = await openConfirmationModal(this.app, {
        eyebrow: '内容范围',
        title: `移除 ${root.path || '此内容目录'}？`,
        description: '本地文件不会删除；受影响的已上线内容会在下一次发布时下线。',
        facts: [{ label: '待下线文章', value: `${takedowns.length} 篇`, tone: takedowns.length ? 'warning' : 'success' }],
        confirmLabel: '移除并标记待下线',
        confirmTone: 'destructive',
      });
      if (!confirmed) return;
      this.updateDraft((draft) => { draft.contentRoots.splice(index, 1); });
    } catch (error) {
      new Notice(`无法评估移除内容目录的影响：${errorMessage(error)}`);
    }
  }

  private async startOAuth(): Promise<void> {
    if (!this.ensureRemoteActionAvailable()) return;
    await this.runSettingsAction('正在打开 Cloudflare 授权', async () => {
      await this.application.beginInitialSetupOAuth();
      new Notice('已在浏览器打开 Cloudflare 授权；完成后将返回 Obsidian。');
    });
  }

  private async connectApiToken(token: string): Promise<void> {
    if (!this.ensureRemoteActionAvailable() || !token) return;
    await this.runSettingsAction('正在连接 Cloudflare', async () => {
      const connected = await this.application.connectInitialSetupApiToken(token);
      const account = 'account' in connected ? connected.account : undefined;
      if (connected.state !== 'connected' || !account) throw new Error('Cloudflare 未返回可用于 Pages 发布的账号。');
      new Notice(`Cloudflare 已连接：${account.name}`);
    });
  }

  private async bindProject(project: string): Promise<void> {
    if (!this.ensureRemoteActionAvailable()) return;
    await this.runSettingsAction('正在验证 Pages 项目', async () => {
      const bound = await this.application.bindConfiguredProject(project);
      if (!(await this.reconcileRemoteConfigChangeAfterSuccess(`Pages 项目已绑定：${bound.name}`))) return;
      new Notice(`已绑定 Pages 项目：${bound.name}。没有执行发布。`);
    });
  }

  private async bindDomain(domain: string): Promise<void> {
    if (!this.ensureRemoteActionAvailable()) return;
    await this.runSettingsAction('正在连接自定义域名', async () => {
      const status = await this.application.connectConfiguredCustomDomain(domain);
      if (!(await this.reconcileRemoteConfigChangeAfterSuccess('自定义域名连接请求已提交'))) return;
      new Notice(customDomainStatusNotice(status));
    });
  }

  private async exportDiagnostics(): Promise<void> {
    const summary = this.application.describeDiagnosticExport();
    const confirmed = await openConfirmationModal(this.app, {
      eyebrow: '隐私复核', title: '导出诊断包？',
      description: `包含：${summary.included.join('、')}。排除：${summary.excluded.join('、')}。`,
      facts: [{ label: '凭据与正文', value: '明确排除', tone: 'success' }],
      confirmLabel: '确认并导出', confirmTone: 'cta',
    });
    if (!confirmed) return;
    await this.runSettingsAction('正在导出诊断包', async () => {
      const result = await this.application.exportDiagnostics({ confirmed: true });
      new Notice(`诊断包已导出：${result.path}`);
    });
  }

  private updateDraft(change: Parameters<SiteConfigEditorSession['update']>[0]): void {
    if (!this.session) return;
    this.pendingUrlChanges = undefined;
    this.editorState = this.session.update(change);
    this.renderCurrentSettings();
  }

  private ensureRemoteActionAvailable(): boolean {
    const availability = settingsRemoteActionAvailability(
      this.session?.getState().status ?? 'clean',
    );
    if (availability.enabled) return true;
    new Notice(`${availability.reason}。`);
    return false;
  }

  private ensureOAuthResultSubscription(): void {
    if (this.unsubscribeGlobalUiState) return;
    this.unsubscribeGlobalUiState = this.application.subscribeGlobalUiState?.(() => {
      this.renderCurrentSettings();
    });
  }

  private async reconcileRemoteConfigChange(): Promise<void> {
    if (!this.session) {
      this.session = await SiteConfigEditorSession.open(this.vaultRoot);
      this.editorState = this.session.getState();
      return;
    }
    this.editorState = await this.session.detectExternalChange();
  }

  private async reconcileRemoteConfigChangeAfterSuccess(
    success: string,
  ): Promise<boolean> {
    try {
      await this.reconcileRemoteConfigChange();
      return true;
    } catch (error) {
      new Notice(
        `${success}，但无法刷新本地设置状态：${errorMessage(error)}。请重新打开设置后核对当前配置。`,
      );
      return false;
    }
  }

  private async openPublishCenter(tab: 'changes' | 'issues' = 'changes'): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PAGES_PUBLISH_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
      state: { tab },
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private closeSettings(): void {
    (this.app as typeof this.app & { setting?: { close(): void } }).setting?.close();
  }
}

export function settingsRemoteActionAvailability(
  status: SiteConfigEditorState['status'],
): { enabled: true } | { enabled: false; reason: string } {
  if (status === 'clean') return { enabled: true };
  return {
    enabled: false,
    reason: status === 'conflict'
      ? '请先解决配置文件外部修改冲突'
      : '请先保存或放弃本地设置更改',
  };
}

export function settingsLocalSaveDescription(
  status: SiteConfigEditorState['status'],
): string {
  if (status === 'dirty') {
    return '有未保存的设置。保存后将重新扫描，但不会自动发布。';
  }
  if (status === 'conflict') {
    return '站点配置已在外部修改。请先重新载入或查看差异，不能直接覆盖。';
  }
  return '配置有效。保存设置不会自动预览或发布。';
}

export function settingsHeaderStatusText(
  status: SiteConfigEditorState['status'],
): string {
  if (status === 'dirty') {
    return '有未保存的本地设置 · .publish/site.yml 仍是当前生效来源';
  }
  if (status === 'conflict') {
    return '.publish/site.yml 已在外部修改 · 本页草稿不会被直接覆盖';
  }
  return '配置有效 · .publish/site.yml 是唯一站点配置来源';
}

export function settingsRemoteActionStatusText(
  status: SiteConfigEditorState['status'],
): string {
  const availability = settingsRemoteActionAvailability(status);
  if (!availability.enabled) {
    return `${availability.reason}；Cloudflare 账号、项目和域名动作已禁用。`;
  }
  return 'Cloudflare 账号、项目和域名动作独立执行；普通保存设置不会触发这些动作。';
}

export async function reloadSettingsDraft<T>(session: {
  getState(): T;
  reloadExternal(): Promise<T>;
}): Promise<{ state: T; error?: string }> {
  try {
    return { state: await session.reloadExternal() };
  } catch (error) {
    return { state: session.getState(), error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

export interface LocalThemeSelection {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function readLocalThemeSelection(
  file: LocalThemeSelection,
): Promise<{ fileName: string; archive: Uint8Array }> {
  if (!file.name.toLowerCase().endsWith('.tgz')) {
    throw new Error('本地主题必须使用 .tgz 扩展名。');
  }
  if (file.size <= 0 || file.size > MAX_LOCAL_THEME_BYTES) {
    throw new Error(`本地主题大小必须在 1 到 ${MAX_LOCAL_THEME_BYTES} 字节之间。`);
  }
  const archive = new Uint8Array(await file.arrayBuffer());
  if (archive.byteLength !== file.size) {
    throw new Error('读取到的主题包大小与文件选择器报告不一致。');
  }
  return { fileName: file.name, archive };
}

function customDomainStatusNotice(status: ConfiguredCustomDomainStatus): string {
  if (status.state === 'unavailable') return '当前宿主无法读取自定义域名状态。';
  if (status.state === 'not-configured') return '当前站点未配置自定义域名。';
  if (status.state === 'active') return `自定义域名已生效：${status.hostname}`;
  if (status.state === 'pending') return `自定义域名等待验证：${status.hostname}`;
  return `自定义域名未生效：${status.hostname}`;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function scanBlockerCount(scan: unknown): number {
  const coordinated = recordValue(scan);
  const value = recordValue(coordinated?.value);
  const issues = value?.issues;
  if (!Array.isArray(issues)) return 0;
  return issues.filter((issue) => recordValue(issue)?.severity === 'blocker').length;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
