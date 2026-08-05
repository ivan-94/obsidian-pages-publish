import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { SafeDiagnosticLogEntry } from '../maintenance/maintenance-service';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { mountPreactView, type MountedPreactView } from '../ui/runtime/mount-preact-view';
import { SafeLogsScreen, type SafeLogsScreenProps } from '../ui/safe-logs/safe-logs-screen';
import { PAGES_PUBLISH_LOG_VIEW_TYPE } from './maintenance-log-host';

export interface DiagnosticExportSummary {
  included: readonly string[];
  excluded: readonly string[];
}

/** Session-local view: only schema-validated safe fields cross into the Preact UI. */
export class PagesPublishMaintenanceLogView extends ItemView {
  private mounted: MountedPreactView<SafeLogsScreenProps> | undefined;
  private exporting = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly entries: () => readonly SafeDiagnosticLogEntry[],
    private readonly describeDiagnosticExport?: () => DiagnosticExportSummary,
    private readonly exportDiagnostics?: () => Promise<{ path: string }>,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PAGES_PUBLISH_LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Pages Publish 本地日志';
  }

  getIcon(): string {
    return 'list-tree';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('pages-publish-view');
    this.mounted = mountPreactView(
      this.contentEl,
      (props) => <SafeLogsScreen {...props} />,
      this.screenProps(),
    );
  }

  async onClose(): Promise<void> {
    this.mounted?.unmount();
    this.mounted = undefined;
    this.contentEl.removeClass('pages-publish-view');
  }

  private screenProps(): SafeLogsScreenProps {
    return {
      entries: this.entries(),
      exporting: this.exporting,
      exportAvailable: this.exportDiagnostics !== undefined,
      onRequestExport: () => this.requestExport(),
    };
  }

  private refresh(): void {
    this.mounted?.update(this.screenProps());
  }

  private async requestExport(): Promise<void> {
    if (!this.exportDiagnostics || this.exporting) return;
    const summary = this.describeDiagnosticExport?.() ?? {
      included: ['经过校验的结构化日志'],
      excluded: ['凭据', '文章正文', '私密路径'],
    };
    const confirmed = await openConfirmationModal(this.app, {
      eyebrow: '导出范围',
      title: '导出安全诊断包',
      description: '导出本地 JSON 诊断包，便于提交问题或离线排查。请先确认数据边界。',
      facts: [
        { label: '将包含', value: summary.included.join('、'), tone: 'success' },
        { label: '始终排除', value: summary.excluded.join('、'), tone: 'warning' },
      ],
      confirmLabel: '确认并导出',
      confirmTone: 'cta',
    });
    if (!confirmed) return;

    this.exporting = true;
    this.refresh();
    try {
      const result = await this.exportDiagnostics();
      new Notice(`诊断包已导出：${result.path}`);
    } catch (error) {
      new Notice(`无法导出诊断包：${errorMessage(error)}`);
    } finally {
      this.exporting = false;
      this.refresh();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
