import { ButtonComponent, ItemView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
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
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    const entries = this.entries();
    const header = container.createEl('header', { cls: 'pages-publish-utility__header' });
    const heading = header.createDiv({ cls: 'pages-publish-utility__heading' });
    heading.createDiv({ cls: 'pages-publish-view__eyebrow', text: '本地诊断' });
    heading.createEl('h2', { text: 'Pages Publish 本地日志' });
    heading.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: '仅显示时间、阶段、代码和聚合计数；不包含凭据、文章内容、私密路径、URL 或构建产物。',
    });
    header.createDiv({
      cls: 'pages-publish-utility__entry-count',
      text: `${entries.length} 条安全日志`,
    });

    const toolbar = container.createDiv({ cls: 'pages-publish-utility__toolbar' });
    const scope = toolbar.createDiv({ cls: 'pages-publish-utility__scope' });
    const scopeLabel = scope.createEl('label', { text: '日志范围' });
    scopeLabel.setAttr('for', 'pages-publish-log-scope');
    const session = scope.createEl('select');
    session.setAttr('id', 'pages-publish-log-scope');
    session.setAttr('aria-label', '日志范围');
    session.createEl('option', { text: '本次会话' });
    let exportArmed = false;
    const exportButton = new ButtonComponent(toolbar)
      .setIcon('upload')
      .setButtonText('导出诊断包')
      .setDisabled(this.exportDiagnostics === undefined)
      .onClick(async () => {
        if (!this.exportDiagnostics) return;
        if (!exportArmed) {
          exportArmed = true;
          exportButton.setButtonText('确认并导出诊断包').setCta();
          new Notice('再次点击将导出经过脱敏的本地诊断包。');
          return;
        }
        try {
          const result = await this.exportDiagnostics();
          exportArmed = false;
          exportButton.setButtonText('导出诊断包');
          new Notice(`诊断包已导出：${result.path}`);
        } catch (error) {
          new Notice(`无法导出诊断包：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });

    const logRegion = container.createEl('section', {
      cls: 'pages-publish-utility__log-region',
      attr: { 'aria-label': '安全诊断日志' },
    });
    if (entries.length === 0) {
      logRegion.createEl('p', {
        cls: 'pages-publish-utility__empty',
        text: '本次会话尚无安全日志。',
      });
    } else {
      const table = logRegion.createEl('table', {
        cls: 'pages-publish-view__articles pages-publish-utility__table',
      });
      table.createEl('caption', { text: `本次会话的 ${entries.length} 条安全日志` });
      const columns = table.createEl('colgroup');
      for (const name of ['time', 'stage', 'code', 'counts']) {
        columns.createEl('col', { cls: `pages-publish-utility__column--${name}` });
      }
      const tableHeader = table.createEl('thead').createEl('tr');
      for (const label of ['时间', '阶段', '代码', '计数']) {
        tableHeader.createEl('th', { attr: { scope: 'col' }, text: label });
      }
      const body = table.createEl('tbody');
      for (const entry of entries) {
        const row = body.createEl('tr');
        const timeCell = row.createEl('td', { attr: { 'data-label': '时间' } });
        const timestamp = timeCell.createEl('time', {
          text: formatLocalDiagnosticTime(entry.at),
          attr: { datetime: entry.at, title: entry.at },
        });
        timestamp.setAttr('aria-label', `记录时间 ${formatAccessibleLocalTime(entry.at)}`);
        const stageCell = row.createEl('td', { attr: { 'data-label': '阶段' } });
        stageCell.createSpan({
          cls: 'pages-publish-utility__stage',
          attr: { 'data-stage': entry.stage, title: entry.stage },
          text: localizeStage(entry.stage),
        });
        const tone = diagnosticTone(entry.code);
        const codeCell = row.createEl('td', {
          cls: `pages-publish-utility__code pages-publish-utility__code--${tone}`,
          attr: {
            'data-label': '代码',
            'data-state': tone,
            'aria-label': `${diagnosticToneLabel(tone)}：${entry.code}`,
          },
        });
        const codeIcon = codeCell.createSpan({
          cls: 'pages-publish-utility__code-icon',
        });
        codeIcon.setAttr('aria-hidden', 'true');
        setIcon(codeIcon, diagnosticIcon(tone));
        codeCell.createSpan({
          cls: 'pages-publish-utility__code-label',
          text: entry.code,
        });
        row.createEl('td', {
          attr: { 'data-label': '计数' },
          text: formatCounts(entry.counts),
        });
      }
    }
    const footer = container.createDiv({ cls: 'pages-publish-utility__footer' });
    footer.createSpan({ text: `共 ${entries.length} 条` });
    footer.createSpan({ text: '仅保留最近 200 条' });
  }
}

type DiagnosticTone = 'success' | 'warning' | 'danger' | 'neutral';

function diagnosticTone(code: string): DiagnosticTone {
  if (/(?:success|complete|ok)$/i.test(code)) return 'success';
  if (/(?:warn|warning)/i.test(code)) return 'warning';
  if (/(?:error|fail|blocked)/i.test(code)) return 'danger';
  return 'neutral';
}

function diagnosticIcon(tone: DiagnosticTone): 'circle-check' | 'triangle-alert' | 'circle-x' | 'circle-dot' {
  if (tone === 'success') return 'circle-check';
  if (tone === 'warning') return 'triangle-alert';
  if (tone === 'danger') return 'circle-x';
  return 'circle-dot';
}

function diagnosticToneLabel(tone: DiagnosticTone): string {
  if (tone === 'success') return '成功';
  if (tone === 'warning') return '警告';
  if (tone === 'danger') return '错误';
  return '信息';
}

function localizeStage(stage: SafeDiagnosticLogEntry['stage']): string {
  const labels: Record<SafeDiagnosticLogEntry['stage'], string> = {
    scan: '扫描',
    build: '构建',
    upload: '上传',
    activate: '激活',
    maintenance: '维护',
  };
  return labels[stage];
}

function formatLocalDiagnosticTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${twoDigits(date.getMonth() + 1)}/${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

function formatAccessibleLocalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function formatCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts || Object.keys(counts).length === 0) return '—';
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}
