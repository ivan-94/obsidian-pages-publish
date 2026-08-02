import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { SafeDiagnosticLogEntry } from '../maintenance/maintenance-service';
import { PAGES_PUBLISH_LOG_VIEW_TYPE } from './maintenance-log-host';

/**
 * A session-local, read-only view of schema-validated diagnostic entries.
 * It intentionally renders no provider response, path, message, URL, or
 * source content. `createEl({ text })` keeps even the constrained fields out
 * of the HTML parser.
 */
export class PagesPublishMaintenanceLogView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly entries: () => readonly SafeDiagnosticLogEntry[],
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
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    container.createDiv({ cls: 'pages-publish-view__eyebrow', text: '本地诊断' });
    container.createEl('h2', { text: 'Pages Publish 本地日志' });
    container.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: '仅显示时间、阶段、代码和聚合计数；不包含凭据、文章内容、私密路径、URL 或构建产物。',
    });
    const entries = this.entries();
    if (entries.length === 0) {
      container.createEl('p', { text: '本次会话尚无安全日志。' });
      return;
    }
    const table = container.createEl('table', { cls: 'pages-publish-view__articles' });
    const header = table.createEl('thead').createEl('tr');
    for (const label of ['时间', '阶段', '代码', '计数']) {
      header.createEl('th', { attr: { scope: 'col' }, text: label });
    }
    const body = table.createEl('tbody');
    for (const entry of entries) {
      const row = body.createEl('tr');
      row.createEl('td', { attr: { 'data-label': '时间' }, text: entry.at });
      row.createEl('td', { attr: { 'data-label': '阶段' }, text: entry.stage });
      row.createEl('td', { attr: { 'data-label': '代码' }, text: entry.code });
      row.createEl('td', {
        attr: { 'data-label': '计数' },
        text: formatCounts(entry.counts),
      });
    }
  }
}

function formatCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts || Object.keys(counts).length === 0) return '—';
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}
