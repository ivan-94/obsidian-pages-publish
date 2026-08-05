import { useEffect, useRef } from 'preact/hooks';
import type { EffectiveValue } from '../../publication/article-metadata';
import type {
  CurrentArticlePanelArticle,
  CurrentArticlePanelState,
} from '../../publication/current-article-panel';
import { articleContentIssueLabel } from '../../plugin/current-article-controller';
import { EmptyState } from '../components/empty-state';
import { InlineAlert } from '../components/inline-alert';
import { StatusLabel, type UiTone } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export type ArticleEditorField =
  | 'title' | 'summary' | 'date' | 'tags' | 'cover'
  | 'slug' | 'kind' | 'order' | 'redirects';

export interface ArticleEditorState {
  busy: boolean;
  draft: string;
  field: ArticleEditorField;
  needsReview: boolean;
  sourcePath: string;
}

export interface ArticleInspectorScreenProps {
  editor?: ArticleEditorState;
  environmentReady: boolean;
  externalLinkResults: readonly string[];
  focusActionField?: ArticleEditorField;
  loading: boolean;
  state?: CurrentArticlePanelState;
  onCancelEdit: () => void;
  onCheckExternalLinks: () => void | Promise<void>;
  onDraftChange: (value: string) => void;
  onEdit: (field: ArticleEditorField) => void;
  onEmptyAction: (state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>) => void | Promise<void>;
  onLegacyMigration: () => void | Promise<void>;
  onLocateContentIssue: (index: number) => void | Promise<void>;
  onLocateRouteIssue: (index: number) => void | Promise<void>;
  onOpenOnline: () => void | Promise<void>;
  onOpenPublishCenter: () => void | Promise<void>;
  onPreview: () => void | Promise<void>;
  onRecheck: () => void | Promise<void>;
  onRepairEnvironment: () => void | Promise<void>;
  onSaveEdit: () => void | Promise<void>;
  onVisibilityChange: (value: 'public' | 'unlisted' | 'private') => void | Promise<void>;
}

export function ArticleInspectorScreen(props: ArticleInspectorScreenProps) {
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.focusActionField) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`.pp-article-property-action--${props.focusActionField}`)
      ?.focus();
  }, [props.focusActionField]);

  return (
    <section class="article-inspector" ref={rootRef}>
      <div class="inspector-body" role="region" aria-label="当前文章发布详情">
        {props.loading ? (
          <EmptyState description="正在读取文章意图、检查结果与线上事实。" icon="loader-circle" title="正在检查文章" />
        ) : props.state?.status === 'article' ? (
          <ArticleBody {...props} state={props.state} />
        ) : props.state ? (
          <ArticleEmptyState state={props.state} onAction={props.onEmptyAction} />
        ) : null}
      </div>

      {props.state?.status === 'article' ? (
        <footer class="inspector-actions" aria-label="文章发布操作">
          {!props.environmentReady ? (
            <InlineAlert
              action={<ObsidianButton icon="wrench" label="修复环境" onClick={props.onRepairEnvironment} />}
              icon="triangle-alert"
              title="本地预览暂不可用"
              tone="warning"
            >
              文章意图仍可编辑；先修复本地环境再预览。
            </InlineAlert>
          ) : null}
          <div class="inspector-action-buttons">
            <ObsidianButton
              disabled={!props.environmentReady}
              icon="eye"
              label="预览文章"
              onClick={props.onPreview}
              tone="cta"
            />
            <ObsidianButton icon="panel-top-open" label="发布中心" onClick={props.onOpenPublishCenter} />
          </div>
        </footer>
      ) : null}
    </section>
  );
}

function ArticleBody(
  props: ArticleInspectorScreenProps & { state: CurrentArticlePanelArticle },
) {
  const { state } = props;
  const issues = state.route.issues.length + state.contentIssues.length;
  return (
    <article class="inspector-document">
      <section class="inspector-section"><div class="inspector-identity">
        <ObsidianIcon className="pp-article-identity__icon" icon="file-text" />
        <div>
          <h3>{state.metadata.title.value}</h3>
          <code title={state.sourcePath}>{state.sourcePath}</code>
        </div>
      </div></section>

      <section class="inspector-section inspector-publication" aria-labelledby="pp-intent-online-title">
        <header>
          <h4 id="pp-intent-online-title">发布状态</h4>
          <StatusLabel
            icon={publicationStateIcon(state.publicationState)}
            tone={publicationStateTone(state.publicationState)}
          >
            {publicationStateShortLabel(state.publicationState)}
          </StatusLabel>
        </header>
        <dl class="compare-block">
          <div>
            <dt>下一版</dt>
            <dd><code>{state.route.pendingUrl ?? '不生成公开页面'}</code></dd>
            <dd><ObsidianButton className="pp-article-property-action--slug" label="编辑 URL" onClick={() => props.onEdit('slug')} /></dd>
          </div>
          <div>
            <dt>当前线上</dt>
            <dd><code>{state.route.onlineUrl ?? '尚未上线'}</code></dd>
            <dd>{state.route.onlineUrl ? <ObsidianButton label="打开" onClick={props.onOpenOnline} /> : null}</dd>
          </div>
        </dl>
        {props.editor?.field === 'slug' ? <PropertyEditor editor={props.editor} label="Slug" {...props} /> : null}
      </section>

      {state.sitePublicationFailed ? (
        <InlineAlert icon="triangle-alert" title="上次整站发布失败" tone="warning">
          这不会覆盖文章自身的部署事实；线上仍保持旧版本。
        </InlineAlert>
      ) : null}

      <section class="inspector-section pp-inspector-section pp-inspector-section--intent">
        <header><h4>下一版意图</h4></header>
        <label class="pp-visibility-field">
          <span><strong>公开方式</strong><small>{visibilityDescription(state.metadata.visibility.value)}</small></span>
          <select
            aria-label="公开方式"
            disabled={props.editor?.busy}
            onChange={(event) => {
              void props.onVisibilityChange(event.currentTarget.value as 'public' | 'unlisted' | 'private');
            }}
            value={state.metadata.visibility.value}
          >
            <option value="public">公开</option>
            <option value="unlisted">不列出</option>
            <option value="private">私密</option>
          </select>
        </label>
      </section>

      <details class="inspector-section pp-inspector-section pp-inspector-checks" open={issues > 0}>
        <summary>
          <span>检查</span>
          <StatusLabel tone={issues > 0 ? 'warning' : 'success'}>
            {issues > 0 ? `${issues} 个问题` : '已通过'}
          </StatusLabel>
        </summary>
        <div class="pp-inspector-section__content">
          <ObsidianButton label="重新检查" onClick={props.onRecheck} />
          {issues === 0 ? <p class="pp-checks-passed">未发现阻塞或警告。</p> : null}
          {[...state.contentIssues]
            .sort((left, right) => severityOrder(left.severity) - severityOrder(right.severity))
            .map((issue) => {
              const index = state.contentIssues.indexOf(issue);
              return (
                <article class={`pp-issue is-${issue.severity}`} key={`content:${index}`}>
                  <strong>{articleContentIssueLabel(issue)} · 第 {issue.line} 行</strong>
                  <code>{issue.sourcePath}:{issue.line}</code>
                  <p>{issue.message}</p><small>{issue.impact}</small>
                  <ObsidianButton label="定位" onClick={() => props.onLocateContentIssue(index)} />
                </article>
              );
            })}
          {[...state.route.issues]
            .sort((left, right) => severityOrder(left.severity) - severityOrder(right.severity))
            .map((issue) => {
              const index = state.route.issues.indexOf(issue);
              return (
                <article class={`pp-issue is-${issue.severity}`} key={`route:${index}`}>
                  <strong>{issue.severity === 'blocker' ? '阻塞' : '警告'} · 文件级路由检查</strong>
                  <code>{issue.sourcePath ?? state.sourcePath}</code>
                  <p>{issue.message}</p>
                  <small>{issue.severity === 'blocker' ? '发布被阻塞。' : '发布会继续，但请确认 URL 与重定向结果。'}</small>
                  <ObsidianButton label="定位" onClick={() => props.onLocateRouteIssue(index)} />
                </article>
              );
            })}
        </div>
      </details>

      <section class="inspector-section pp-inspector-section">
        <header><h4>文章属性</h4></header>
        <div class="pp-property-list">
          <PropertyRow field="title" label="标题" value={state.metadata.title} {...props} />
          <PropertyRow field="summary" label="摘要" value={state.metadata.summary} {...props} />
          <PropertyRow field="date" label="日期" value={state.metadata.date} {...props} />
          <PropertyRow field="tags" label="标签" value={{ ...state.metadata.tags, value: state.metadata.tags.value.join(', ') || '未设置' }} {...props} />
          <PropertyRow field="cover" label="封面" value={state.metadata.cover} {...props} />
        </div>
      </section>

      <details class="inspector-section pp-inspector-section">
        <summary>高级：类型、排序、重定向</summary>
        <div class="pp-property-list pp-inspector-section__content">
          <PropertyRow field="kind" label="类型" value={state.metadata.kind} {...props} />
          <PropertyRow field="order" label="排序" value={state.metadata.order} {...props} />
          <PropertyRow field="redirects" label="重定向" value={{ ...state.metadata.redirects, value: state.metadata.redirects.value.join(', ') || '未设置' }} {...props} />
        </div>
      </details>

      <details class="inspector-section pp-inspector-section">
        <summary>依赖与联网检查</summary>
        <div class="pp-inspector-section__content">
          <p>图片 {state.dependencies.images} · 笔记 {state.dependencies.notes} · 外链 {state.dependencies.externalLinks}</p>
          <p class="pp-muted">本地依赖随扫描检查；外链仅在你明确点击后联网检查。</p>
          {state.dependencies.externalLinks > 0 ? <ObsidianButton label="检查外链" onClick={props.onCheckExternalLinks} /> : null}
          {props.externalLinkResults.map((result) => <InlineAlert key={result} title="外链警告" tone="warning">{result}</InlineAlert>)}
        </div>
      </details>

      {state.legacyMigration ? (
        <details class="inspector-section pp-inspector-section">
          <summary>检测到旧发布字段</summary>
          <div class="pp-inspector-section__content">
            <p>可迁移到 publication schema；旧字段会原样保留。</p>
            <ObsidianButton label="迁移到新 schema" onClick={props.onLegacyMigration} />
          </div>
        </details>
      ) : null}

      <details class="inspector-section pp-inspector-section">
        <summary>部署事实（只读）</summary>
        <div class="pp-deployment-facts pp-inspector-section__content">
          {!state.metadata.deployment ? <p>尚无成功部署记录。</p> : (
            <dl>
              {fact('线上 URL', state.metadata.deployment.url)}
              {fact('首次发布', state.metadata.deployment.firstPublishedAt)}
              {fact('最近发布', state.metadata.deployment.lastPublishedAt)}
              {fact('源摘要', state.metadata.deployment.sourceDigest)}
              {fact('部署标识', state.metadata.deployment.deploymentId)}
            </dl>
          )}
        </div>
      </details>
    </article>
  );
}

function PropertyRow(props: ArticleInspectorScreenProps & {
  field: ArticleEditorField;
  label: string;
  value: EffectiveValue<unknown, string> | undefined;
}) {
  return (
    <div class="pp-property-row">
      <div><span>{props.label}</span><strong>{props.value === undefined ? '未设置' : String(props.value.value)}</strong><small>{props.value === undefined ? '无来源' : sourceLabel(props.value.source)}</small></div>
      <ObsidianButton className={`pp-article-property-action--${props.field}`} label="编辑" onClick={() => props.onEdit(props.field)} />
      {props.editor?.field === props.field && props.editor.sourcePath === (props.state?.status === 'article' ? props.state.sourcePath : '')
        ? <PropertyEditor {...props} editor={props.editor} />
        : null}
    </div>
  );
}

function PropertyEditor(props: ArticleInspectorScreenProps & { editor: ArticleEditorState; label: string }) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  useEffect(() => inputRef.current?.focus(), [props.editor.field]);
  const common = {
    'aria-label': `${props.label}显式覆盖`,
    disabled: props.editor.busy,
    value: props.editor.draft,
  };
  return (
    <div class="pp-property-editor">
      {props.editor.needsReview ? (
        <InlineAlert title="草稿需要复核" tone="warning">文件或站点配置已变化；未保存输入仍保留。</InlineAlert>
      ) : null}
      {props.editor.field === 'tags' || props.editor.field === 'redirects' ? (
        <textarea {...common} onInput={(event) => props.onDraftChange(event.currentTarget.value)} ref={inputRef as never} />
      ) : props.editor.field === 'kind' ? (
        <select {...common} onChange={(event) => props.onDraftChange(event.currentTarget.value)} ref={inputRef as never}>
          <option value="">使用默认值</option><option value="article">文章</option><option value="index">栏目索引</option>
        </select>
      ) : (
        <input {...common} inputMode={props.editor.field === 'order' ? 'decimal' : 'text'} onInput={(event) => props.onDraftChange(event.currentTarget.value)} ref={inputRef as never} />
      )}
      <small>留空保存会删除显式覆盖，并恢复动态来源。</small>
      <div><ObsidianButton busy={props.editor.busy} label="保存" onClick={props.onSaveEdit} tone="cta" /><ObsidianButton disabled={props.editor.busy} label="取消编辑" onClick={props.onCancelEdit} /></div>
    </div>
  );
}

function ArticleEmptyState({ state, onAction }: {
  state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>;
  onAction: (state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>) => void | Promise<void>;
}) {
  const copy = emptyStateCopy(state);
  const action = emptyStateAction(state);
  return <EmptyState action={action ? <ObsidianButton label={action} onClick={() => onAction(state)} tone={state.status === 'no-site' ? 'cta' : 'default'} /> : undefined} description={copy.description} icon={emptyStateIcon(state.status)} title={copy.title} />;
}

function fact(label: string, value: string | undefined) {
  return value ? <div><dt>{label}</dt><dd><code>{value}</code></dd></div> : null;
}

function publicationStateShortLabel(state: CurrentArticlePanelArticle['publicationState']): string {
  const labels: Record<CurrentArticlePanelArticle['publicationState'], string> = {
    private: '保持私密', 'pending-first-publish': '等待首次发布', synced: '与线上一致', updated: '有更新',
    'url-changed': 'URL 待更新', 'visibility-changed': '可见性待更新', 'pending-takedown': '等待下线',
    blocked: '发布被阻塞', unknown: '状态未知',
  };
  return labels[state];
}

function publicationStateIcon(state: CurrentArticlePanelArticle['publicationState']): string {
  if (state === 'synced') return 'circle-check';
  if (state === 'private') return 'lock-keyhole';
  if (state === 'blocked') return 'circle-alert';
  if (state === 'unknown') return 'circle-help';
  return 'refresh-cw';
}

function publicationStateTone(state: CurrentArticlePanelArticle['publicationState']): UiTone {
  if (state === 'synced' || state === 'private') return 'success';
  if (state === 'blocked') return 'danger';
  if (state === 'unknown') return 'neutral';
  return 'warning';
}

function visibilityDescription(value: string): string {
  if (value === 'public') return '任何人可访问，并出现在列表、搜索和图谱中。';
  if (value === 'unlisted') return '知道 URL 的人可访问，但不出现在列表、搜索和图谱中。';
  return '不进入公开构建；已上线内容将在下一次发布时下线。';
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    default: '默认值', 'first-h1': '来自首个 H1', filename: '来自文件名',
    'body-summary': '来自正文摘要', 'frontmatter.date': '来自文件属性',
    'frontmatter.tags': '来自文件标签', 'deployment.first_published_at': '来自首次成功发布',
    'deployment.last_published_at': '来自最近成功发布',
  };
  return labels[source] ?? `显式覆盖 · ${source}`;
}

function severityOrder(severity: 'blocker' | 'warning'): number { return severity === 'blocker' ? 0 : 1; }

function emptyStateCopy(state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>) {
  switch (state.status) {
    case 'no-active': return { title: '当前没有活动文章', description: '打开一个 Markdown 文件以查看发布设置。' };
    case 'non-markdown': return { title: '此文件不是可发布的 Markdown', description: 'Pages Publish 只把 Markdown 作为内容候选。' };
    case 'out-of-scope': return { title: '此文章不在内容范围内', description: `${state.sourcePath} 尚未映射到公开路径。` };
    case 'out-of-scope-online': return { title: '此文章当前仍在线，但已移出内容范围', description: `下一次发布前需要确认是恢复范围还是下线。当前线上 URL：${state.onlineUrl}` };
    case 'missing-pinned': return { title: '指定的文章已移动或删除', description: '请在发布中心重新选择文章。' };
    case 'config-error': return { title: '站点配置无效，发布功能已暂停', description: state.message };
    case 'no-site': return { title: '尚未创建发布站点', description: '先完成本地站点设置，再管理当前文章的发布意图。' };
  }
}

function emptyStateAction(state: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>): string | undefined {
  if (state.status === 'no-site') return '开始设置';
  if (state.status === 'out-of-scope') return '打开内容范围设置';
  if (state.status === 'out-of-scope-online') return '查看发布中心';
  if (state.status === 'config-error') return '打开并定位';
  return undefined;
}

function emptyStateIcon(status: Exclude<CurrentArticlePanelState, CurrentArticlePanelArticle>['status']): string {
  if (status === 'config-error') return 'file-warning';
  if (status === 'no-site') return 'cloud';
  if (status === 'missing-pinned') return 'file-x';
  return 'file-question';
}
