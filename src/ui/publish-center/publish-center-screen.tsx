import type { InitialSetupConnection, PublicationServiceStatus } from '../../application';
import type { ScanIssue } from '../../content/site-scanner';
import type { CurrentArticlePanelArticle } from '../../publication/current-article-panel';
import type { PublishCenterArticle, PublishCenterState } from '../../publication/publish-center';
import { EmptyState } from '../components/empty-state';
import { StatusLabel, type UiTone } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export type PublishCenterTab = 'changes' | 'all' | 'unpublished' | 'issues';
export type PublishCenterFilter = 'all' | 'public' | 'unlisted' | 'private' | 'blocker' | 'warning';

export interface PublishCenterScreenProps {
  activeTab: PublishCenterTab;
  center: PublishCenterState;
  connection: InitialSetupConnection;
  filter: PublishCenterFilter;
  previewBusy: boolean;
  publication: PublicationServiceStatus;
  query: string;
  selectedDetail?: CurrentArticlePanelArticle;
  selectedSourcePath?: string;
  onAcknowledgeUploadUncertain: () => void | Promise<void>;
  onChangeFilter: (filter: PublishCenterFilter) => void;
  onChangeInclusion: (article: PublishCenterArticle, included: boolean) => void | Promise<void>;
  onChangeQuery: (query: string) => void;
  onChangeTab: (tab: PublishCenterTab) => void;
  onCheckConnection: () => void | Promise<void>;
  onCloseReview: () => void;
  onLocateIssue: (issue: ScanIssue) => void | Promise<void>;
  onOpenLogs: () => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenSite: () => void | Promise<void>;
  onOpenSiteConfig: () => void | Promise<void>;
  onPreview: () => void | Promise<void>;
  onPublish: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onSelectArticle: (article: PublishCenterArticle) => void | Promise<void>;
}

export function PublishCenterScreen(props: PublishCenterScreenProps) {
  const { center } = props;
  const selected = center.articles.find((article) => article.sourcePath === props.selectedSourcePath);
  const articles = center.articles.filter((article) =>
    matchesTab(article, props.activeTab)
      && matchesFilter(article, props.filter)
      && matchesQuery(article, props.query));
  const connection = connectionLabel(props.connection);
  const publishDisabled = !center.canPublish
    || props.connection.state === 'expired'
    || props.connection.state === 'disconnected'
    || props.publication.state === 'unavailable'
    || props.publication.state === 'running'
    || props.publication.state === 'reconciliation-required';

  return (
    <main class="plugin-view pc-view">
      <header class="pc-header">
        <div>
          <div class="pc-title-line"><h1>{center.siteName}</h1><span class="pc-connected"><i class={`status-dot ${connection.tone === 'success' ? 'success' : connection.tone === 'danger' ? 'danger' : 'warning'}`} />{connection.label}</span></div>
          <div class="pc-meta"><code>{center.lastPublishedAt && center.siteUrl ? center.siteUrl : '尚无已确认成功的线上站点'}</code><span>{center.lastPublishedAt ? `上次发布：${new Date(center.lastPublishedAt).toLocaleString()}` : '从未成功发布'}</span></div>
        </div>
        <div class="pc-header-actions"><ObsidianButton className="button-ghost" disabled={!center.lastPublishedAt || !center.siteUrl} icon="external-link" label="打开站点" onClick={props.onOpenSite} /><ObsidianButton ariaLabel="重新扫描" className="button-ghost icon-button" icon="refresh-cw" label="" onClick={props.onRefresh} /><ObsidianButton ariaLabel="打开设置" className="button-ghost icon-button" icon="settings" label="" onClick={props.onOpenSettings} /></div>
      </header>

      <section class="pc-snapshot" aria-label="发布快照">
        <div class="pc-snapshot-title"><strong>{center.summary.changes} 项变化</strong><span>{selectedCount(center.articles)} 篇文章进入下一版{center.summary.takedowns ? ` · ${center.summary.takedowns} 项待下线` : ''}</span></div>
        <div class="pc-metrics"><span class="pc-metric"><b>+{center.summary.added}</b>新增</span><span class="pc-metric"><b>{center.summary.updated}</b>更新</span><span class="pc-metric"><b>{center.summary.urlChanged}</b>URL 变化</span><span class="pc-metric is-attention"><b>{center.summary.takedowns}</b>待下线</span><span class="pc-metric"><b>{center.summary.blockers}</b>阻塞</span><span class="pc-metric is-attention"><b>{center.summary.warnings}</b>警告</span></div>
        <div class="pc-scan"><strong>{center.output.status === 'known' ? `完整构建 · ${center.output.fileCount} 个文件` : '等待完整构建'}</strong>{center.baseline === 'unknown' ? '缺少可比较的部署清单' : '扫描于刚刚完成'}</div>
      </section>

      <div class="pc-gates">
        {!center.canPublish ? <aside class="pc-gate is-required"><ObsidianIcon icon="circle-x" /><div class="pc-gate-copy"><strong>当前问题阻止发布</strong><span>{center.issues.find((issue) => issue.severity === 'blocker')?.message ?? '修复阻塞问题后重新扫描。'}</span></div><ObsidianButton label="查看" onClick={() => props.onChangeTab('issues')} /></aside> : null}
        {center.summary.warnings > 0 ? <aside class="pc-gate is-warning"><ObsidianIcon icon="triangle-alert" /><div class="pc-gate-copy"><strong>{center.summary.warnings} 个非阻塞警告</strong><span>发布可以继续；请在执行前复核降级结果。</span></div><ObsidianButton className="button-ghost" label="查看" onClick={() => props.onChangeTab('issues')} /></aside> : null}
      </div>

      <PublicationStatus status={props.publication} onAcknowledge={props.onAcknowledgeUploadUncertain} onOpenLogs={props.onOpenLogs} />

      <section class="pc-workbench">
        <div class="pc-toolbar">
          <nav class="tab-list" aria-label="发布内容模式" role="tablist">{tabDefinitions(center).map((tab) => <button aria-selected={props.activeTab === tab.id} class={`tab-button${props.activeTab === tab.id ? ' is-active' : ''}`} key={tab.id} onClick={() => props.onChangeTab(tab.id)} role="tab">{tab.label} <span class="count">{tab.count}</span></button>)}</nav>
          {props.activeTab !== 'issues' ? <div class="pc-filters"><label class="input-shell"><ObsidianIcon icon="search" /><input aria-label="搜索文章或路径" onInput={(event) => props.onChangeQuery(event.currentTarget.value)} placeholder="搜索标题或路径" type="search" value={props.query} /></label><select aria-label="筛选文章" onChange={(event) => props.onChangeFilter(event.currentTarget.value as PublishCenterFilter)} value={props.filter}><option value="all">全部公开方式</option><option value="public">公开</option><option value="unlisted">不列出</option><option value="private">私密</option><option value="blocker">有阻塞</option><option value="warning">有警告</option></select></div> : null}
        </div>

        <div class={`review-grid${selected ? ' has-review' : ''}`}>
          <div class="list-region">{props.activeTab === 'issues' ? <IssueList issues={center.issues} onLocate={props.onLocateIssue} /> : articles.length === 0 ? <EmptyState description="调整关键词或公开方式；当前发布快照不会改变。" icon="search-x" title="没有匹配的文章" /> : <table class="data-table pc-table"><caption class="sr-only">{articles.length} 篇发布内容</caption><thead><tr><th class="pc-col-select" scope="col">上线</th><th class="pc-col-article" scope="col">文章</th><th class="pc-col-change" scope="col">变化</th><th class="pc-col-visibility" scope="col">公开方式</th><th class="pc-col-check" scope="col">检查</th><th class="pc-col-open" scope="col"><span class="sr-only">审阅</span></th></tr></thead><tbody>{articles.map((article) => <ArticleRow article={article} key={article.sourcePath} onChangeInclusion={props.onChangeInclusion} onSelect={props.onSelectArticle} selected={selected?.sourcePath === article.sourcePath} />)}</tbody></table>}</div>
          {selected ? <><button aria-label="关闭文章审阅" class="review-drawer-scrim" onClick={props.onCloseReview} /><ReviewPane article={selected} detail={props.selectedDetail} onClose={props.onCloseReview} /></> : null}
        </div>
      </section>

      <footer class="sticky-actions pc-actions"><div class="sticky-copy"><strong>{center.canPublish ? '已准备好生成下一版' : '发布尚未就绪'}</strong><span>{publishDisabled ? publishDisabledReason(props) : `${selectedCount(center.articles)} 篇已选择 · ${center.summary.warnings} 个警告 · 发布成功前线上站点不变`}</span></div><div class="sticky-buttons"><ObsidianButton busy={props.previewBusy} busyLabel="正在准备预览…" icon="eye" label="预览" onClick={props.onPreview} /><ObsidianButton disabled={publishDisabled} icon="cloud-upload" label={publishButtonLabel(center.canPublish, props.publication)} onClick={props.onPublish} tone="cta" /></div></footer>
    </main>
  );
}

function ArticleRow({ article, selected, onChangeInclusion, onSelect }: { article: PublishCenterArticle; selected: boolean; onChangeInclusion: PublishCenterScreenProps['onChangeInclusion']; onSelect: PublishCenterScreenProps['onSelectArticle'] }) {
  const checkTone = article.issues.some((issue) => issue.severity === 'blocker') ? 'danger' : article.issues.length > 0 ? 'warning' : 'success';
  return <tr class={selected ? 'is-selected' : ''} onClick={(event) => { if (!(event.target as HTMLElement).closest('button,input,label')) void onSelect(article); }}>
    <td class="pc-col-select" data-label="下一版"><label class="checkbox-hit"><input aria-label={`下一版包含 ${article.title}`} checked={article.nextIncluded} disabled={article.availability !== 'ready'} onChange={(event) => { void onChangeInclusion(article, event.currentTarget.checked); }} type="checkbox" /></label></td>
    <td class="article-cell pc-col-article" data-label="文章"><button class="article-title" onClick={() => { void onSelect(article); }}>{article.title}</button><span class="article-path">{article.sourcePath}</span></td>
    <td class="pc-col-change" data-label="变化"><StatusLabel className="state-label" tone={changeTone(article.change)}>{changeLabel(article.change)}</StatusLabel></td>
    <td class="pc-col-visibility" data-label="公开方式"><StatusLabel className="state-label" icon={visibilityIcon(article.visibility)}>{visibilityLabel(article.visibility)}</StatusLabel></td>
    <td class="pc-col-check" data-label="检查"><StatusLabel className="state-label" icon={checkTone === 'success' ? 'circle-check' : checkTone === 'danger' ? 'circle-x' : 'triangle-alert'} tone={checkTone}>{article.issues.length === 0 ? '通过' : `${article.issues.length} 项`}</StatusLabel></td>
    <td class="pc-col-open" data-label="审阅"><button aria-label={`审阅 ${article.title}`} class="icon-button button-ghost" onClick={() => { void onSelect(article); }}><ObsidianIcon icon="chevron-right" /></button></td>
  </tr>;
}

function ReviewPane({ article, detail, onClose }: { article: PublishCenterArticle; detail?: CurrentArticlePanelArticle; onClose: () => void }) {
  return <aside aria-label={`审阅 ${article.title}`} aria-modal="true" class="review-pane" role="dialog">
    <header class="pc-drawer-header"><div><div class="eyebrow">文章审阅</div><h2>{article.title}</h2><code class="muted">{article.sourcePath}</code></div><button aria-label="关闭文章审阅" class="icon-button button-ghost" onClick={onClose}><ObsidianIcon icon="x" /></button></header>
    <div class="pc-drawer-body"><section class="pc-review-section"><h3>下一版结果</h3><div class="pc-review-result"><ObsidianIcon icon="info" /><strong>{changeLabel(article.change)} · {visibilityLabel(article.visibility)}</strong></div></section><section class="pc-review-section"><h3>线上与待发布</h3><div class="pc-review-facts"><div><span>待发布</span><code>{article.nextIncluded ? article.url ?? '等待生成 URL' : '不包含'}</code></div><div><span>当前线上</span><code>{article.onlineUrl ?? '尚未发布'}</code></div></div></section><section class="pc-review-section"><h3>检查</h3>{article.issues.length > 0 ? <IssueList issues={article.issues} /> : <StatusLabel className="state-label" icon="circle-check" tone="success">当前文章检查通过</StatusLabel>}</section>{detail ? <section class="pc-review-section"><h3>文章事实</h3><p class="small muted">图片 {detail.dependencies.images} · 笔记 {detail.dependencies.notes} · 外链 {detail.dependencies.externalLinks}</p></section> : null}</div>
  </aside>;
}

function IssueList({ issues, onLocate }: { issues: readonly ScanIssue[]; onLocate?: (issue: ScanIssue) => void | Promise<void> }) {
  if (issues.length === 0) return <EmptyState description="扫描没有发现阻塞或警告。" icon="circle-check" title="检查已通过" />;
  return <ul class="pc-issues">{[...issues].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity)).map((issue, index) => <li class="pc-issue" key={`${issue.path}:${issue.line ?? 0}:${index}`}><ObsidianIcon className={issue.severity === 'blocker' ? 'danger-text' : 'warning-text'} icon={issue.severity === 'blocker' ? 'circle-x' : 'triangle-alert'} /><div><strong>{issue.severity === 'blocker' ? '阻塞' : '警告'} · {issue.path}{issue.line ? `:${issue.line}` : ''}</strong><p>{issue.message}</p></div>{onLocate ? <ObsidianButton className="button-ghost" label="定位" onClick={() => onLocate(issue)} /> : null}</li>)}</ul>;
}

function PublicationStatus({ status, onAcknowledge, onOpenLogs }: { status: PublicationServiceStatus; onAcknowledge: () => void | Promise<void>; onOpenLogs: () => void | Promise<void> }) {
  if (status.state === 'idle' || status.state === 'unavailable') return null;
  const tone: UiTone = status.state === 'succeeded' ? 'success' : status.state === 'running' ? 'accent' : 'danger';
  return <section aria-busy={status.state === 'running'} aria-live="polite" class={`pp-publication-status is-${status.state}`} role="status">
    <StatusLabel icon={status.state === 'running' ? 'loader-circle' : status.state === 'succeeded' ? 'circle-check' : 'circle-x'} tone={tone}>{publicationStatusLabel(status)}</StatusLabel>
    <p>{publicationStatusDetail(status)}</p>
    {status.state === 'running' ? <ol aria-label="发布进度" class="pp-task-progress">{(['prepare', 'build', 'upload', 'activate'] as const).map((stage, index, stages) => { const active = stages.indexOf(status.stage); return <li aria-current={index === active ? 'step' : undefined} class={index < active ? 'is-complete' : index === active ? 'is-active' : 'is-upcoming'} key={stage}><ObsidianIcon icon={index < active ? 'check' : index === active ? 'loader-circle' : 'circle'} /><span>{stageLabel(stage)}</span></li>; })}</ol> : null}
    <div><ObsidianButton icon="file-clock" label="查看日志" onClick={onOpenLogs} />{status.state === 'reconciliation-required' && status.reconciliation === 'upload-uncertain' ? <ObsidianButton label="已核验，解除阻塞" onClick={onAcknowledge} tone="destructive" /> : null}</div>
  </section>;
}

function tabDefinitions(center: PublishCenterState): Array<{ id: PublishCenterTab; label: string; count: number }> { return [{ id: 'changes', label: '当前变化', count: center.summary.changes }, { id: 'all', label: '全部内容', count: center.articles.length }, { id: 'unpublished', label: '未发布', count: center.summary.added }, { id: 'issues', label: '问题', count: center.issues.length }]; }
function matchesTab(article: PublishCenterArticle, tab: PublishCenterTab): boolean { return tab === 'all' || (tab === 'changes' && article.change !== 'unchanged') || (tab === 'unpublished' && article.change === 'added') || (tab === 'issues' && article.issues.length > 0); }
function matchesFilter(article: PublishCenterArticle, filter: PublishCenterFilter): boolean { return filter === 'all' || (filter === 'blocker' || filter === 'warning' ? article.issues.some((issue) => issue.severity === filter) : article.visibility === filter); }
function matchesQuery(article: PublishCenterArticle, query: string): boolean { const value = query.trim().toLocaleLowerCase(); return !value || `${article.title}\n${article.sourcePath}`.toLocaleLowerCase().includes(value); }
function connectionLabel(connection: InitialSetupConnection): { icon: string; label: string; tone: UiTone } { if (connection.state === 'connected') return { icon: 'cloud-check', label: `Cloudflare 已连接${connection.account ? `：${connection.account.name}` : ''}`, tone: 'success' }; if (connection.state === 'expired') return { icon: 'cloud-off', label: 'Cloudflare 授权已失效', tone: 'danger' }; if (connection.state === 'disconnected') return { icon: 'cloud-off', label: 'Cloudflare 尚未连接', tone: 'warning' }; return { icon: 'cloud', label: 'Cloudflare 状态不可用', tone: 'neutral' }; }
function visibilityLabel(value: PublishCenterArticle['visibility']): string { return value === 'public' ? '公开' : value === 'unlisted' ? '不列出' : value === 'private' ? '私密' : '—'; }
function visibilityIcon(value: PublishCenterArticle['visibility']): string { return value === 'public' ? 'globe-2' : value === 'unlisted' ? 'link' : value === 'private' ? 'lock-keyhole' : 'circle-help'; }
function changeLabel(value: PublishCenterArticle['change']): string { return ({ added: '新增', updated: '内容更新', 'url-changed': 'URL 已变化', 'visibility-changed': '公开方式已变化', takedown: '待下线', unchanged: '无变化', unknown: '状态未知' })[value]; }
function changeTone(value: PublishCenterArticle['change']): UiTone { return value === 'added' ? 'success' : value === 'unchanged' ? 'neutral' : value === 'unknown' ? 'warning' : value === 'takedown' ? 'danger' : 'accent'; }
function severityOrder(value: 'blocker' | 'warning'): number { return value === 'blocker' ? 0 : 1; }
function stageLabel(stage: 'prepare' | 'build' | 'upload' | 'activate'): string { return ({ prepare: '准备', build: '构建与检查', upload: '上传', activate: '激活' })[stage]; }
function publicationStatusLabel(status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>): string { if (status.state === 'running') return `${stageLabel(status.stage)}中`; if (status.state === 'succeeded') return '发布成功'; if (status.state === 'reconciliation-required') return status.reconciliation === 'upload-uncertain' ? '上传结果未确认' : '本地发布事实待协调'; return '发布失败'; }
function publicationStatusDetail(status: Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>): string { if (status.state === 'running') return '任务在后台继续运行；关闭页面不会取消。'; if (status.state === 'succeeded') return `${status.deployment.output.fileCount} 个文件已激活。`; if (status.state === 'reconciliation-required') return status.message; return `${status.message} 新版本未激活，现有线上站点保持不变。`; }
function publishButtonLabel(canPublish: boolean, status: PublicationServiceStatus): string { if (!canPublish) return '发布站点（不可用）'; if (status.state === 'running') return '发布中'; if (status.state === 'failed') return '重试发布'; if (status.state === 'reconciliation-required') return '本地同步待修复'; if (status.state === 'unavailable') return '发布站点（需要连接）'; return '发布站点'; }
function publishDisabledReason(props: PublishCenterScreenProps): string { if (!props.center.canPublish) return '先修复阻塞问题'; if (props.connection.state !== 'connected') return '先恢复 Cloudflare 连接'; if (props.publication.state === 'running') return '发布任务正在运行'; if (props.publication.state === 'reconciliation-required') return '先协调上次发布结果'; return '当前宿主未提供发布能力'; }
function selectedCount(articles: readonly PublishCenterArticle[]): number { return articles.filter((article) => article.nextIncluded).length; }
