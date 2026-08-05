import { ItemView, Notice, type Workspace, type WorkspaceLeaf } from 'obsidian';
import type { ThemeCandidate, ThemeManagementService, ThemePanelState } from '../theme/theme-management';
import type { ExternalThemeReference } from '../theme/theme-contract';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { mountPreactView, type MountedPreactView } from '../ui/runtime/mount-preact-view';
import { ThemeManagerScreen, type ThemeManagerScreenProps } from '../ui/theme-manager/theme-manager-screen';

export const PAGES_PUBLISH_THEME_MANAGER_VIEW_TYPE = 'pages-publish-theme-manager';

export async function openThemeManager(workspace: Pick<Workspace, 'getLeaf' | 'revealLeaf'>): Promise<void> {
  const leaf = workspace.getLeaf('tab');
  await leaf.setViewState({ type: PAGES_PUBLISH_THEME_MANAGER_VIEW_TYPE, active: true });
  await workspace.revealLeaf(leaf);
}

export class PagesPublishThemeManagerView extends ItemView {
  private mounted: MountedPreactView<ThemeManagerScreenProps> | undefined;
  private panel: ThemePanelState | undefined;
  private busy: { label: string; controller: AbortController } | undefined;
  constructor(leaf: WorkspaceLeaf, private readonly service: ThemeManagementService, private readonly getActive: () => ExternalThemeReference | undefined, private readonly select: (reference: ExternalThemeReference) => void, private readonly returnSettings: () => void) { super(leaf); }
  getViewType(): string { return PAGES_PUBLISH_THEME_MANAGER_VIEW_TYPE; }
  getDisplayText(): string { return 'Pages Publish 主题管理'; }
  getIcon(): string { return 'palette'; }
  async onOpen(): Promise<void> { this.contentEl.addClass('pages-publish-view'); this.mounted = mountPreactView(this.contentEl, (props) => <ThemeManagerScreen {...props} />, this.props()); await this.refresh(); }
  async onClose(): Promise<void> { this.busy?.controller.abort(); this.mounted?.unmount(); this.mounted = undefined; this.contentEl.removeClass('pages-publish-view'); }
  private props(): ThemeManagerScreenProps { return { active: this.getActive(), busy: this.busy?.label, panel: this.panel, onCancel: () => this.busy?.controller.abort(), onConfirmTrust: (candidate) => this.confirmTrust(candidate), onImportLocal: (file) => this.run('正在导入并校验本地主题', async (signal) => this.service.importLocalArchive(file.name, new Uint8Array(await file.arrayBuffer()), signal)), onInstallNpm: (name, version) => this.run('正在安装并校验 npm 主题', (signal) => this.service.installNpm(name, version, signal)), onRepair: () => { const active = this.getActive(); return active ? this.run('正在修复当前主题', async (signal) => { await this.service.repair(active, signal); }) : Promise.resolve(); }, onReturnSettings: () => this.returnSettings(), onSelect: (candidate) => { this.select(structuredClone(candidate.reference)); new Notice('主题已加入设置草稿；保存设置后生效。'); this.update(); }, onUninstall: (candidate) => this.uninstall(candidate) }; }
  private update(): void { this.mounted?.update(this.props()); }
  private async refresh(): Promise<void> { try { this.panel = await this.service.panelState(this.getActive()); } catch (error) { new Notice(`无法读取主题：${message(error)}`); this.panel = { installed: [], configuredError: { code: 'theme-status-unavailable', message: message(error) } }; } this.update(); }
  private async run(label: string, operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> { if (this.busy) return; const controller = new AbortController(); this.busy = { label, controller }; this.update(); try { await operation(controller.signal); new Notice(`${label.replace('正在', '')}完成。`); } catch (error) { if (!controller.signal.aborted) new Notice(`主题操作失败：${message(error)}`); } finally { if (this.busy?.controller === controller) this.busy = undefined; await this.refresh(); } }
  private async confirmTrust(candidate: ThemeCandidate): Promise<void> { const confirmed = await openConfirmationModal(this.app, { eyebrow: '执行能力复核', title: `信任 ${candidate.displayName} ${candidate.version}？`, description: '只信任当前固定 integrity。更新版本或摘要后必须重新复核。', facts: [{ label: '来源', value: candidate.reference.source === 'npm' ? `${candidate.packageName}@${candidate.version}` : candidate.reference.artifact }, { label: '执行能力', value: candidate.capabilities.join('、') || '仅样式', tone: candidate.capabilities.length ? 'warning' : 'success' }, { label: 'Integrity', value: candidate.integrity }], confirmLabel: '确认信任此版本', confirmTone: 'cta' }); if (!confirmed) return; try { await this.service.confirmTrust(candidate); this.select(structuredClone(candidate.reference)); new Notice('已信任固定主题版本并加入设置草稿。'); await this.refresh(); } catch (error) { new Notice(`无法确认主题信任：${message(error)}`); } }
  private async uninstall(candidate: ThemeCandidate): Promise<void> { const confirmed = await openConfirmationModal(this.app, { eyebrow: '本地主题', title: `卸载 ${candidate.displayName}？`, description: '只删除插件管理的这个固定版本；不会修改 npm 全局环境。', facts: [{ label: '版本', value: candidate.version }, { label: 'Integrity', value: candidate.integrity }], confirmLabel: '卸载固定版本', confirmTone: 'destructive' }); if (!confirmed) return; try { await this.service.uninstall(candidate, this.getActive()); new Notice('主题版本已卸载。'); await this.refresh(); } catch (error) { new Notice(`无法卸载主题：${message(error)}`); } }
}
function message(error: unknown): string { return error instanceof Error ? error.message : '未知错误'; }
