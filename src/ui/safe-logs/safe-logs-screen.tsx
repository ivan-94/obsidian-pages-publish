import type { SafeDiagnosticLogEntry } from '../../maintenance/maintenance-service';
import { EmptyState } from '../components/empty-state';
import { StatusLabel } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';
import { ObsidianIcon } from '../obsidian/obsidian-icon';
import {
  diagnosticTone,
  diagnosticToneLabel,
  formatAccessibleLocalTime,
  formatCounts,
  formatLocalDiagnosticTime,
  localizeStage,
} from './safe-log-model';

export interface SafeLogsScreenProps {
  entries: readonly SafeDiagnosticLogEntry[];
  exporting: boolean;
  exportAvailable: boolean;
  onRequestExport: () => void | Promise<void>;
}

export function SafeLogsScreen({
  entries,
  exporting,
  exportAvailable,
  onRequestExport,
}: SafeLogsScreenProps) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'all' | 'info' | 'warning' | 'error'>('all');
  const visibleEntries = entries.filter((entry) => {
    const tone = diagnosticTone(entry.code);
    const matchesLevel = level === 'all' || (level === 'info' && (tone === 'neutral' || tone === 'success')) || (level === 'warning' && tone === 'warning') || (level === 'error' && tone === 'danger');
    return matchesLevel && `${entry.stage} ${entry.code} ${formatCounts(entry.counts)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  return (
    <main class="plugin-view safe-logs">
      <header class="compact-page-header">
        <div>
          <div class="eyebrow">本地诊断</div>
          <h1>安全维护日志</h1>
          <div class="compact-meta" aria-label="日志摘要">
            <span>{entries.length} 条记录</span>
            <StatusLabel icon="lock" tone="success">已脱敏</StatusLabel>
            <span>仅保留最近 200 条</span>
          </div>
        </div>
        <div class="compact-actions">
          <ObsidianButton
            busy={exporting}
            busyLabel="正在导出…"
            disabled={!exportAvailable}
            icon="download"
            label="导出诊断包"
            onClick={onRequestExport}
            tone="cta"
          />
        </div>
      </header>

      <aside class="compact-note">
        <ObsidianIcon icon="shield-check" />
        <p>不记录凭据、授权头、Markdown 正文、私密路径、URL 或构建产物。</p>
      </aside>

      <section class="workbench log-shell" aria-labelledby="pp-safe-log-heading">
        <div class="log-toolbar"><div class="cluster"><label class="input-shell"><ObsidianIcon icon="search" /><input aria-label="搜索日志" onInput={(event) => setQuery(event.currentTarget.value)} placeholder="搜索事件或阶段" type="search" value={query} /></label><label><select aria-label="日志级别" onChange={(event) => setLevel(event.currentTarget.value as typeof level)} value={level}><option value="all">全部级别</option><option value="info">信息</option><option value="warning">警告</option><option value="error">错误</option></select></label></div><StatusLabel tone="neutral">{visibleEntries.length} / 200</StatusLabel></div>
        <h2 class="sr-only" id="pp-safe-log-heading">本次会话</h2>
        <div class="log-head" aria-hidden="true"><span>时间</span><span>级别</span><span>事件</span></div>

        {visibleEntries.length === 0 ? (
          <EmptyState
            description={entries.length === 0 ? '扫描、构建、发布或维护发生后，经过安全校验的事件会出现在这里。' : '调整关键词或日志级别。筛选只影响当前视图，不会删除记录。'}
            icon="list-tree"
            title={entries.length === 0 ? '本次会话尚无安全日志' : '没有匹配的日志'}
          />
        ) : (
          <div class="log-list" role="list" aria-label={`本次会话的 ${visibleEntries.length} 条安全维护日志`}>
                {visibleEntries.map((entry, index) => {
                  const tone = diagnosticTone(entry.code);
                  return (
                    <article class="log-row" key={`${entry.at}:${entry.stage}:${entry.code}:${index}`} role="listitem">
                        <time
                          aria-label={`记录时间 ${formatAccessibleLocalTime(entry.at)}`}
                          dateTime={entry.at}
                          title={entry.at}
                        >
                          {formatLocalDiagnosticTime(entry.at)}
                        </time>
                        <strong class={tone === 'warning' ? 'warning-text' : tone === 'danger' ? 'danger-text' : ''}>{diagnosticToneLabel(tone)}</strong>
                        <p><b>{entry.code}</b> · {localizeStage(entry.stage)}{formatCounts(entry.counts) ? ` · ${formatCounts(entry.counts)}` : ''}</p>
                    </article>
                  );
                })}
          </div>
        )}
      </section>
    </main>
  );
}
import { useState } from 'preact/hooks';
