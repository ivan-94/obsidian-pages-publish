import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { SiteConfigV1 } from '../../config/site-config';
import type { SiteConfigEditorState, SiteUrlChange } from '../../config/site-settings';
import { BUILTIN_THEME_CATALOG } from '../../theme/builtin-theme-catalog';
import { isExternalThemeReference } from '../../theme/theme-contract';
import { InlineAlert } from '../components/inline-alert';
import { StatusLabel } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';
import { ObsidianToggle } from '../obsidian/obsidian-toggle';

export interface SettingsEnvironmentSummary {
  cache: string;
  connection: string;
  engine: string;
  preview: string;
  runtime: string;
  stage: string;
}

export interface SettingsScreenProps {
  busy?: string;
  environment: SettingsEnvironmentSummary;
  pendingUrlChanges?: SiteUrlChange[];
  state: SiteConfigEditorState;
  onAddRoot: () => void;
  onBindDomain: (domain: string) => void | Promise<void>;
  onBindProject: (project: string) => void | Promise<void>;
  onClearCache: () => void | Promise<void>;
  onConnectToken: (token: string) => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  onExportDiagnostics: () => void | Promise<void>;
  onOpenConfig: () => void;
  onOpenLogs: () => void | Promise<void>;
  onOpenPublish: () => void | Promise<void>;
  onOpenThemeManager: () => void | Promise<void>;
  onReloadConflict: () => void | Promise<void>;
  onRemoveRoot: (index: number) => void | Promise<void>;
  onRepairEnvironment: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
  onStartOAuth?: () => void | Promise<void>;
  onStartPreview: () => void | Promise<void>;
  onUpdate: (change: (draft: SiteConfigV1) => void) => void;
  onValidate: () => void | Promise<void>;
}

export function SettingsScreen(props: SettingsScreenProps) {
  const { draft } = props.state;
  const [project, setProject] = useState(draft.cloudflare.projectName);
  const [domain, setDomain] = useState(draft.cloudflare.customDomain ?? '');
  const [token, setToken] = useState('');
  const remoteDisabled = props.state.status !== 'clean' || Boolean(props.busy);
  const theme = draft.site.theme;
  const themeValue = theme?.source === 'builtin' ? theme.id : theme && isExternalThemeReference(theme) ? 'external' : 'quartz-default';

  return <main class="settings-frame">
    <div class="settings-document">
    {props.busy ? <InlineAlert icon="loader-circle" title={props.busy} tone="accent">完成前会保留当前配置和线上状态。</InlineAlert> : null}
    {props.state.status === 'conflict' && props.state.comparison ? <InlineAlert action={<ObsidianButton label="重新载入外部版本" onClick={props.onReloadConflict} />} icon="git-compare-arrows" title="配置文件已在外部修改" tone="danger"><p>当前草稿不会被静默覆盖。重新载入会放弃本页草稿。</p><details><summary>查看两个版本</summary><h4>外部版本</h4><pre>{props.state.comparison.currentSource}</pre><h4>本页草稿</h4><pre>{JSON.stringify(props.state.comparison.draft, undefined, 2)}</pre></details></InlineAlert> : null}

    <SettingsSection id="site" title="站点与内容" description="定义网站身份与候选文件范围。">
      <SettingsRow label="站点名称" hint="支持中文；不会自动决定域名。"><input aria-label="站点名称" type="text" value={draft.site.name} onInput={(event) => props.onUpdate((next) => { next.site.name = event.currentTarget.value; })} /></SettingsRow>
      <SettingsRow label="站点简介" hint={`${visibleCharacters(draft.site.description ?? '')} / 160 个可见字符`} wide><textarea aria-label="站点简介" maxlength={160} value={draft.site.description ?? ''} onInput={(event) => props.onUpdate((next) => { next.site.description = event.currentTarget.value || undefined; })} /></SettingsRow>
      <SettingsRow label="时区" hint="IANA 时区标识，例如 Asia/Shanghai。"><input aria-label="时区" placeholder="Asia/Shanghai" type="text" value={draft.site.timezone ?? ''} onInput={(event) => props.onUpdate((next) => { next.site.timezone = event.currentTarget.value || undefined; })} /></SettingsRow>
      {draft.contentRoots.map((root, index) => <SettingsRow key={`${index}-${root.path}`} label={`内容目录 ${index + 1}`} hint="Vault 相对目录 → 站点公开路径" wide><div class="pp-settings-root-stack"><div class="pp-settings-root"><input aria-label={`内容目录 ${index + 1}`} placeholder="Notes" type="text" value={root.path} onInput={(event) => props.onUpdate((next) => { const target = next.contentRoots[index]; if (target) target.path = event.currentTarget.value; })} /><input aria-label={`公开路径 ${index + 1}`} placeholder="/notes" type="text" value={root.publicRoot} onInput={(event) => props.onUpdate((next) => { const target = next.contentRoots[index]; if (target) target.publicRoot = event.currentTarget.value; })} /><ObsidianButton disabled={draft.contentRoots.length === 1} icon="x" label="移除" onClick={() => props.onRemoveRoot(index)} tone="destructive" /></div>{index === draft.contentRoots.length - 1 ? <div class="settings-inline-action"><ObsidianButton icon="plus" label="添加内容目录" onClick={props.onAddRoot} /></div> : null}</div></SettingsRow>)}
      <SettingsRow label="资源排除" hint="每行一个仓库相对匹配模式。" wide><textarea aria-label="资源排除" value={draft.assets.exclude.join('\n')} onInput={(event) => props.onUpdate((next) => { next.assets.exclude = event.currentTarget.value.split('\n').map((entry) => entry.trim()).filter(Boolean); })} /></SettingsRow>
    </SettingsSection>

    <SettingsSection id="cloudflare" title="Cloudflare" description={remoteDisabled ? '存在未保存草稿时，远端动作会暂停。' : '远端动作会单独验证；保存设置不会隐式操作 Cloudflare。'}>
      {props.onStartOAuth ? <SettingsRow label="Cloudflare OAuth" hint="推荐方式；凭据保存在 Obsidian 安全存储。"><ObsidianButton disabled={remoteDisabled} icon="cloud" label="使用 Cloudflare 登录" onClick={props.onStartOAuth} tone="cta" /></SettingsRow> : null}
      <SettingsRow label="API token" hint="高级备用方式；只在点击连接后验证并保存。"><div class="pp-settings-action-field"><input aria-label="Cloudflare API token" type="password" value={token} onInput={(event) => setToken(event.currentTarget.value)} /><ObsidianButton disabled={remoteDisabled || !token.trim()} label="连接" onClick={async () => { await props.onConnectToken(token.trim()); setToken(''); }} /></div></SettingsRow>
      <SettingsRow label="Pages 项目" hint={`当前：${draft.cloudflare.projectName}`}><div class="pp-settings-action-field"><input aria-label="Pages 项目" type="text" value={project} onInput={(event) => setProject(event.currentTarget.value)} /><ObsidianButton disabled={remoteDisabled || !project.trim()} label="验证并绑定" onClick={() => props.onBindProject(project.trim())} /></div></SettingsRow>
      <SettingsRow label="自定义域名" hint={`当前：${draft.cloudflare.customDomain ?? '未配置'}`}><div class="pp-settings-action-field"><input aria-label="自定义域名" placeholder="docs.example.com" type="text" value={domain} onInput={(event) => setDomain(event.currentTarget.value)} /><ObsidianButton disabled={remoteDisabled || !domain.trim()} label="连接域名" onClick={() => props.onBindDomain(domain.trim())} /></div></SettingsRow>
    </SettingsSection>

    <SettingsSection id="features" title="发布行为" description="控制站点体验；不会绕过发布中心。">
      <SettingsRow label="首页布局" hint="决定首页内容的主要组织方式。"><select aria-label="首页布局" value={draft.site.homeLayout} onChange={(event) => props.onUpdate((next) => { next.site.homeLayout = event.currentTarget.value as 'sections' | 'latest'; })}><option value="sections">按目录展示分区</option><option value="latest">按最新文章展示</option></select></SettingsRow>
      <SettingsRow label="全文搜索" hint="在构建产物中生成搜索索引。"><ObsidianToggle label="全文搜索" value={draft.features.search} onChange={(value) => props.onUpdate((next) => { next.features.search = value; })} /></SettingsRow>
      <SettingsRow label="知识图谱" hint="在文章页显示局部知识图谱。"><ObsidianToggle label="知识图谱" value={draft.features.graph} onChange={(value) => props.onUpdate((next) => { next.features.graph = value; })} /></SettingsRow>
    </SettingsSection>

    <SettingsSection id="theme" title="站点主题" description="选择先进入草稿，保存后用于下一次预览和发布。">
      <SettingsRow label="当前主题" hint={themeDescription(theme)}><div class="pp-settings-action-field pp-settings-select-action"><select aria-label="内置主题" value={themeValue} onChange={(event) => props.onUpdate((next) => { const selected = event.currentTarget.value; if (selected === 'external') return; if (selected === 'quartz-default') delete next.site.theme; else next.site.theme = { source: 'builtin', id: selected as typeof BUILTIN_THEME_CATALOG[number]['id'] }; })}><option value="quartz-default">Quartz 默认主题</option>{BUILTIN_THEME_CATALOG.map((item) => <option value={item.id}>{item.displayName}</option>)}{themeValue === 'external' ? <option value="external">自定义主题（当前草稿）</option> : null}</select><ObsidianButton icon="palette" label="管理自定义主题" onClick={props.onOpenThemeManager} /></div></SettingsRow>
    </SettingsSection>

    <SettingsSection id="environment" title="维护" description="用于诊断配置与部署问题；不会暴露令牌。">
      <SettingsRow label="Node.js 运行时" hint={props.environment.runtime}><StatusLabel>{props.environment.stage}</StatusLabel></SettingsRow>
      <SettingsRow label="Pages 发布引擎" hint={props.environment.engine}><StatusLabel>{props.environment.cache}</StatusLabel></SettingsRow>
      <SettingsRow label="本地预览" hint={props.environment.preview}><ObsidianButton icon="external-link" label="启动预览" onClick={props.onStartPreview} /></SettingsRow>
      <SettingsRow label="站点配置" hint="查看或修复底层 YAML。"><ObsidianButton label="打开配置" onClick={props.onOpenConfig} /></SettingsRow>
      <SettingsRow label="日志与诊断" hint={`连接：${props.environment.connection} · 诊断包不含令牌与文章正文。`}><div class="pp-settings-row-actions"><ObsidianButton label="修复环境" onClick={props.onRepairEnvironment} /><ObsidianButton label="清理缓存" onClick={props.onClearCache} /><ObsidianButton label="打开日志" onClick={props.onOpenLogs} /><ObsidianButton label="导出诊断包" onClick={props.onExportDiagnostics} /></div></SettingsRow>
    </SettingsSection>

    {props.pendingUrlChanges?.length ? <InlineAlert icon="route" title={`公开路径变化将影响 ${props.pendingUrlChanges.length} 篇已上线文章`} tone="warning"><p>再次保存会把每个已知旧 URL 写入 redirects；不会自动发布。</p><ul>{props.pendingUrlChanges.map((change) => <li>{change.sourcePath}：{change.onlineUrl} → {change.pendingUrl}</li>)}</ul></InlineAlert> : null}
    </div>
    <footer class="sticky-actions settings-actions"><div class="sticky-copy"><strong>{footerText(props.state.status)}</strong><span>本地设置与远端操作保持分离 · {canonicalOrigin(draft)}</span></div><div class="sticky-buttons"><ObsidianButton className="button-ghost" icon="cloud" label="返回发布中心" onClick={props.onOpenPublish} /><ObsidianButton disabled={!props.state.canSave || props.state.status === 'clean' || Boolean(props.busy)} icon="check" label="保存设置" onClick={props.onSave} tone="cta" /></div></footer>
  </main>;
}

export function SettingsMessageScreen({ action, description, title, tone = 'warning' }: { action?: ComponentChildren; description: string; title: string; tone?: 'danger' | 'warning' }) { return <main class="pp-settings pp-settings--message"><InlineAlert action={action} icon={tone === 'danger' ? 'circle-x' : 'triangle-alert'} title={title} tone={tone}>{description}</InlineAlert></main>; }

function SettingsSection({ children, description, id, title }: { children: ComponentChildren; description: string; id: string; title: string }) { return <section class="settings-section" id={`settings-${id}`}><header class="settings-heading"><h2>{title}</h2><p class="muted">{description}</p></header>{children}</section>; }
function SettingsRow({ children, hint, label, wide = false }: { children: ComponentChildren; hint: string; label: string; wide?: boolean }) { return <div class={`setting-row${wide ? ' is-wide' : ''}`}><div class="setting-info"><strong>{label}</strong><span>{hint}</span></div><div class="setting-control">{children}</div></div>; }
function canonicalOrigin(draft: SiteConfigV1): string { return draft.cloudflare.customDomain ? `https://${draft.cloudflare.customDomain}` : draft.cloudflare.pagesDevDomain ? `https://${draft.cloudflare.pagesDevDomain}` : `${draft.cloudflare.projectName}.pages.dev`; }
function footerText(status: SiteConfigEditorState['status']): string { return status === 'clean' ? '配置已保存；发布仍需在发布中心明确执行。' : status === 'dirty' ? '更改仅存在于本页草稿，尚未写入 site.yml。' : '先解决外部文件冲突，才能保存。'; }
function themeDescription(theme: SiteConfigV1['site']['theme']): string { if (!theme) return 'Quartz 默认主题 · 始终可恢复'; if (theme.source === 'builtin') return `内置主题 · ${theme.id}`; return `${theme.source === 'npm' ? `${theme.package}@${theme.version}` : theme.artifact} · ${theme.integrity.slice(0, 16)}…`; }
function visibleCharacters(value: string): number { return [...value].filter((character) => !/[\uFE00-\uFE0F\u200D]/u.test(character)).length; }
