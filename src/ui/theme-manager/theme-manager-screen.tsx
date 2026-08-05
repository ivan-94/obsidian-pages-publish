import { useState } from 'preact/hooks';
import type { ThemeCandidate, ThemePanelState } from '../../theme/theme-management';
import type { ExternalThemeReference } from '../../theme/theme-contract';
import { EmptyState } from '../components/empty-state';
import { InlineAlert } from '../components/inline-alert';
import { StatusLabel } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';

export interface ThemeManagerScreenProps {
  active?: ExternalThemeReference;
  busy?: string;
  panel?: ThemePanelState;
  onCancel: () => void;
  onConfirmTrust: (candidate: ThemeCandidate) => void | Promise<void>;
  onImportLocal: (file: File) => void | Promise<void>;
  onInstallNpm: (packageName: string, version: string) => void | Promise<void>;
  onRepair: () => void | Promise<void>;
  onReturnSettings: () => void | Promise<void>;
  onSelect: (candidate: ThemeCandidate) => void;
  onUninstall: (candidate: ThemeCandidate) => void | Promise<void>;
}

export function ThemeManagerScreen(props: ThemeManagerScreenProps) {
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('');
  const [source, setSource] = useState<'registry' | 'local'>('registry');
  return <main class="plugin-view theme-manager">
    <header class="compact-page-header"><div><div class="eyebrow">站点外观</div><h1>主题管理</h1><div class="compact-meta"><span>{activeLabel(props.active)}</span><StatusLabel className="state-label" icon="shield-check" tone="success">配置兼容</StatusLabel><span>仅影响发布网站</span></div></div><div class="compact-actions"><ObsidianButton className="button-ghost" icon="chevron-left" label="设置" onClick={props.onReturnSettings} /></div></header>
    <aside class="compact-note"><span aria-hidden="true">ⓘ</span><p>主题包在本地沙箱验证；加入设置草稿并保存后，才影响下一次预览。</p></aside>
    {props.busy ? <InlineAlert action={<ObsidianButton label="取消" onClick={props.onCancel} />} icon="loader-circle" title={props.busy} tone="accent">当前有效主题会一直保留到任务成功。</InlineAlert> : null}
    {!props.panel ? <EmptyState description="正在校验发布引擎与已安装主题。" icon="loader-circle" title="正在读取主题" /> : <>
      <section class="current-theme-panel"><div class="workbench"><div class="workbench-bar"><div><div class="eyebrow">当前主题</div><h2>{activeLabel(props.active)}</h2></div>{props.panel.configured ? <ThemeTrustSummary candidate={props.panel.configured} /> : <StatusLabel className="state-label" icon="circle-check" tone="success">已启用</StatusLabel>}</div><div class="workbench-body"><div class="theme-preview" role="img" aria-label="当前主题站点预览"><div class="theme-preview__bar"><strong>数字花园</strong><span>文章</span><span>关于</span></div><div class="theme-preview__body"><nav class="theme-preview__nav"><strong>目录</strong><span>设计系统</span><span>发布指南</span><span>工作笔记</span></nav><article class="theme-preview__article"><small>产品设计 · 8 分钟阅读</small><h3>把约束变成清晰的默认值</h3><p>从阅读顺序与操作后果出发，让常见选择更快，也让例外保持可解释。</p><code>publication: public</code></article></div></div></div></div><aside class="workbench theme-meta"><div class="workbench-bar"><h3>主题信息</h3></div><div class="workbench-body">{props.panel.configuredError ? <InlineAlert action={<ObsidianButton label="修复" onClick={props.onRepair} />} icon="circle-x" title="当前主题不可用" tone="danger">{props.panel.configuredError.message}</InlineAlert> : <dl class="key-value-list"><div><dt>来源</dt><dd>{props.active?.source === 'npm' ? `${props.active.package}@${props.active.version}` : props.active?.artifact ?? '内置主题'}</dd></div><div><dt>完整性</dt><dd>{props.active?.integrity.slice(0, 18) ?? '插件内置'}…</dd></div><div><dt>生效时机</dt><dd>保存设置并重新预览</dd></div></dl>}</div></aside></section>
      <section class="workbench install-panel"><div class="workbench-bar"><div class="tab-list" role="tablist" aria-label="安装主题方式"><button aria-selected={source === 'registry'} class={`tab-button${source === 'registry' ? ' is-active' : ''}`} onClick={() => setSource('registry')} role="tab">npm 包</button><button aria-selected={source === 'local'} class={`tab-button${source === 'local' ? ' is-active' : ''}`} onClick={() => setSource('local')} role="tab">本地归档</button></div><span class="small muted">安装前验证清单与兼容性</span></div>{source === 'registry' ? <div class="install-source"><div class="field"><label>主题包与精确版本</label><div class="cluster"><input aria-label="npm 包名" onInput={(event) => setPackageName(event.currentTarget.value)} placeholder="@scope/theme" value={packageName} /><input aria-label="npm 精确版本" onInput={(event) => setVersion(event.currentTarget.value)} placeholder="1.2.3" value={version} /><ObsidianButton disabled={!packageName.trim() || !version.trim() || Boolean(props.busy)} label="安装并校验" onClick={() => props.onInstallNpm(packageName.trim(), version.trim())} /></div><small>仅接受包含 Pages Publish 主题清单的精确版本。</small></div></div> : <div class="install-source"><div class="field"><label>本地 .tgz 归档</label><input accept=".tgz,application/gzip" aria-label="本地主题归档" disabled={Boolean(props.busy)} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void props.onImportLocal(file); }} type="file" /><small>归档复制进 Vault 的受管主题目录后执行隔离验证。</small></div></div>}</section>
      <section class="workbench install-panel"><div class="workbench-bar"><h2>其他已验证主题</h2><span class="small muted">{props.panel.installed.length} 个可选项</span></div>{props.panel.installed.length === 0 ? <EmptyState description="从 npm 精确版本安装，或导入本地 .tgz。" icon="palette" title="尚无外部主题" /> : <div class="dense-list">{props.panel.installed.map((candidate) => <article class="dense-row theme-option" key={candidate.integrity}><span aria-hidden="true">◈</span><div><strong>{candidate.displayName}</strong><small>{candidate.packageName}@{candidate.version}</small></div><small>{candidate.capabilities.join('、') || '仅样式'} · {candidate.trusted ? '已信任' : '待信任'}</small><div class="theme-option-actions">{!candidate.trusted ? <ObsidianButton label="查看并使用" onClick={() => props.onConfirmTrust(candidate)} /> : <ObsidianButton label={isActive(candidate, props.active) ? '当前草稿' : '选择主题'} disabled={isActive(candidate, props.active)} onClick={() => props.onSelect(candidate)} />}<ObsidianButton className="button-ghost" disabled={isActive(candidate, props.active)} label="移除" onClick={() => props.onUninstall(candidate)} tone="destructive" /></div></article>)}</div>}</section>
    </>}
  </main>;
}

function ThemeTrustSummary({ candidate }: { candidate: ThemeCandidate & { trusted?: boolean } }) { return <StatusLabel icon={candidate.trusted ? 'badge-check' : 'shield-alert'} tone={candidate.trusted ? 'success' : 'warning'}>{candidate.trusted ? '已信任此固定版本' : '尚未信任执行能力'}</StatusLabel>; }
function activeLabel(active: ExternalThemeReference | undefined): string { if (!active) return '内置默认主题'; return active.source === 'npm' ? `${active.package}@${active.version}` : active.artifact; }
function isActive(candidate: ThemeCandidate, active: ExternalThemeReference | undefined): boolean { return Boolean(active && candidate.integrity === active.integrity); }
