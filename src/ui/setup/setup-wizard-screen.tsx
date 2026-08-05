import { useState } from 'preact/hooks';
import type { InitialSetupConnection, InitialSetupEnvironmentStatus } from '../../application';
import type { SetupAccount, SetupDraft, SetupProject, SetupReview } from '../../setup/site-setup';
import type { SetupProgressStage } from '../../setup/site-setup';
import { InlineAlert } from '../components/inline-alert';
import { StatusLabel } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export interface SetupWizardScreenProps {
  accounts: readonly SetupAccount[];
  canUseApiToken: boolean;
  canUseOAuth: boolean;
  connection: InitialSetupConnection;
  draft: SetupDraft;
  environment: InitialSetupEnvironmentStatus;
  projectAvailability?: { name: string; available: boolean };
  projects: readonly SetupProject[];
  review?: SetupReview;
  step: number;
  vaultRootConfirmed: boolean;
  onAddRoot: () => void;
  onBack: () => void;
  onCancelEnvironment: () => void | Promise<void>;
  onCheckProject: () => void | Promise<void>;
  onConnectApiToken: (token: string) => void | Promise<void>;
  onConnectOAuth: () => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
  onConfirmVaultRoot: () => void;
  onContinue: () => void;
  onExit: () => void;
  onRemoveRoot: (index: number) => void;
  onRepairEnvironment: () => void | Promise<void>;
  onScanScope: () => void | Promise<void>;
  onSelectAccount: (account: SetupAccount) => void | Promise<void>;
  onSelectProject: (project: SetupProject) => void;
  onUpdate: () => void;
}

const labels = ['环境准备', '站点信息', '内容范围', 'Cloudflare', '确认'];

export function SetupWizardScreen(props: SetupWizardScreenProps) {
  const ready = canContinue(props);
  return <main class="plugin-view setup-shell">
    <header class="compact-page-header">
      <div><div class="eyebrow">首次设置 · 约 3 分钟</div><h1>连接 Vault 与 Cloudflare Pages</h1><div class="compact-meta"><span>五个步骤</span><span>完成设置不会发布内容</span></div></div>
      <div class="compact-actions"><ObsidianButton className="button-ghost" icon="x" label="退出" onClick={props.onExit} /></div>
    </header>
    <ol aria-label="首次设置进度" class="setup-progress">
      {labels.map((label, index) => <li aria-current={index === props.step ? 'step' : undefined} class={index < props.step ? 'is-complete' : index === props.step ? 'is-active' : ''} data-number={index + 1} key={label}>{label}</li>)}
    </ol>
    <section class="setup-panel">
      {props.step === 0 ? <EnvironmentStep {...props} /> : null}
      {props.step === 1 ? <SiteStep {...props} /> : null}
      {props.step === 2 ? <ContentStep {...props} /> : null}
      {props.step === 3 ? <CloudflareStep {...props} /> : null}
      {props.step === 4 ? <ReviewStep {...props} /> : null}
    </section>
    <footer class="sticky-actions setup-actions"><div class="sticky-copy"><strong>设置草稿尚未写入</strong><span>仅最后一步保存本地配置；不会发布站点</span></div><div class="sticky-buttons">
      <ObsidianButton disabled={props.step === 0} label="返回" onClick={props.onBack} />
      {props.step < 4
        ? <ObsidianButton disabled={!ready} label={continuationLabel(props.step)} onClick={props.onContinue} tone="cta" />
        : <ObsidianButton disabled={!ready} label={ready ? '创建站点并开始扫描' : '创建站点（需要完成连接）'} onClick={props.onConfirm} tone="cta" />}
    </div></footer>
  </main>;
}

export interface SetupExecutionScreenProps {
  candidateCount?: number;
  domain?: string;
  eligibleCount?: number;
  message?: string;
  stage?: SetupProgressStage;
  state: 'running' | 'success' | 'failed';
  onContinue: () => void | Promise<void>;
  onReturn: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}

export function SetupExecutionScreen(props: SetupExecutionScreenProps) {
  if (props.state === 'success') return <main class="pp-setup-result"><StatusLabel icon="circle-check" tone="success">首次设置完成</StatusLabel><h1>站点已创建</h1><p>找到 {props.candidateCount} 篇候选，其中 {props.eligibleCount} 篇可以加入首次发布。{props.domain}</p><InlineAlert icon="shield-check" title="没有执行发布" tone="success">没有文章被发布，也没有修改文章 Frontmatter。</InlineAlert><ObsidianButton label="进入发布中心" onClick={props.onContinue} tone="cta" /></main>;
  const stages: Array<{ id: SetupProgressStage; label: string }> = [{ id: 'validate', label: '验证计划' }, { id: 'project', label: 'Pages 项目' }, { id: 'domain', label: '域名计划' }, { id: 'config', label: '写入配置' }, { id: 'scan', label: '扫描候选' }];
  const active = props.stage ? stages.findIndex((stage) => stage.id === props.stage) : 0;
  return <main class="pp-setup-result"><StatusLabel icon={props.state === 'running' ? 'loader-circle' : 'circle-x'} tone={props.state === 'running' ? 'accent' : 'danger'}>{props.state === 'running' ? '正在创建站点' : '站点创建未完成'}</StatusLabel><h1>{props.state === 'running' ? '正在执行已确认计划' : '可以安全重试'}</h1><ol aria-label="创建站点进度" class="pp-task-progress pp-task-progress--five">{stages.map((stage, index) => <li aria-current={index === active ? 'step' : undefined} class={index < active ? 'is-complete' : index === active ? props.state === 'running' ? 'is-active' : 'is-failed' : 'is-upcoming'} key={stage.id}><ObsidianIcon icon={index < active ? 'check' : index === active ? props.state === 'running' ? 'loader-circle' : 'circle-x' : 'circle'} /><span>{stage.label}</span></li>)}</ol>{props.state === 'failed' ? <InlineAlert icon="circle-x" title="当前步骤失败" tone="danger">{props.message}</InlineAlert> : <p>请保持 Obsidian 运行；安全重试会复用匹配的远端项目。</p>}<div class="pp-setup-step__actions">{props.state === 'failed' ? <><ObsidianButton label="返回确认" onClick={props.onReturn} /><ObsidianButton label="重试已确认计划" onClick={props.onRetry} tone="cta" /></> : null}</div></main>;
}

function EnvironmentStep(props: SetupWizardScreenProps) {
  const environment = props.environment;
  const ready = environment.stage === 'ready';
  const runtime = 'runtime' in environment ? environment.runtime : undefined;
  const engine = 'engine' in environment ? environment.engine : undefined;
  return <div class="pp-setup-step"><div class="eyebrow">第 1 步，共 5 步</div><h2 tabIndex={-1}>确认本地环境</h2><p class="muted">先检查运行时、Vault 写入权限和网络，避免授权后才发现环境问题。</p>
    <ul class="stage-list">
      <Task checked={ready} current={environment.stage === 'checking-system'} label="检查系统与 Vault" />
      <Task checked={Boolean(runtime)} current={environment.stage.includes('runtime')} label={runtime ? `${runtime.source === 'obsidian' ? 'Obsidian Node.js' : 'Node.js'} ${runtime.version}` : '查找兼容的 Node.js 运行时'} />
      <Task checked={Boolean(engine)} current={['verifying-engine', 'downloading-engine', 'installing-engine', 'smoke-testing', 'installing'].includes(environment.stage)} label={engine ? `Pages 发布引擎 ${engine.version}` : '准备 Pages 发布引擎'} />
      <Task checked={false} current={false} label="创建站点后按需验证本地预览" />
    </ul>
    <InlineAlert icon={ready ? 'circle-check' : 'info'} title={ready ? '本地环境已就绪' : '准备完成前不能继续'} tone={ready ? 'success' : 'neutral'}>{ready ? '可以继续填写站点计划。' : environment.impact ?? '任务只影响插件管理的本地环境。'}</InlineAlert>
    <div class="pp-setup-step__actions">{(environment.stage === 'failed' || environment.stage === 'idle') && environment.nextAction === 'repair' ? <ObsidianButton label="重试环境准备" onClick={props.onRepairEnvironment} /> : null}{isPreparing(environment.stage) ? <ObsidianButton label="取消环境准备" onClick={props.onCancelEnvironment} /> : null}</div>
    <details><summary>技术详情</summary><p>运行时与引擎仅供当前插件使用；不会修改系统 Node.js、npm、PATH 或全局包。</p></details>
  </div>;
}

function SiteStep(props: SetupWizardScreenProps) {
  const site = props.draft.config.site;
  const count = Array.from(site.description ?? '').length;
  return <div class="pp-setup-step"><div class="eyebrow">第 2 步，共 5 步</div><h2 tabIndex={-1}>定义站点身份</h2><p class="muted">这些信息会出现在站点元数据中；域名可在首次部署完成后继续调整。</p>
    <label class="pp-form-field"><span><strong>站点名称</strong><small>必填；支持中文，不决定域名。</small></span><input aria-label="站点名称" onInput={(event) => { site.name = event.currentTarget.value; props.onUpdate(); }} value={site.name} /></label>
    <label class="pp-form-field"><span><strong>站点简介</strong><small>可选，最多 160 个字符。</small></span><textarea aria-label="站点简介" onInput={(event) => { site.description = event.currentTarget.value || undefined; props.onUpdate(); }} value={site.description ?? ''} /><small class={count > 160 ? 'is-danger' : ''}>{count} / 160</small></label>
  </div>;
}

function ContentStep(props: SetupWizardScreenProps) {
  const usesRoot = props.draft.config.contentRoots.some((root) => root.path.trim() === '.');
  return <div class="pp-setup-step"><div class="eyebrow">第 3 步，共 5 步</div><h2 tabIndex={-1}>选择候选内容</h2>
    <p class="pp-muted">内容目录与公开路径成对定义；扫描只生成本地报告，不写入配置。</p>
    <div class="pp-content-roots">{props.draft.config.contentRoots.map((root, index) => <div class="pp-content-root" key={index}>
      <label><span>内容目录 {index + 1}</span><input aria-label={`内容目录 ${index + 1}`} onInput={(event) => { root.path = event.currentTarget.value; props.onUpdate(); }} value={root.path} /></label>
      <label><span>公开路径</span><input aria-label={`公开路径 ${index + 1}`} onInput={(event) => { root.publicRoot = event.currentTarget.value; props.onUpdate(); }} value={root.publicRoot} /></label>
      {props.draft.config.contentRoots.length > 1 ? <ObsidianButton label="移除" onClick={() => props.onRemoveRoot(index)} tone="destructive" /> : null}
      <StatusLabel tone={props.review ? 'success' : 'neutral'}>{props.review?.roots?.find((item) => item.path === root.path)?.candidateCount ?? '待扫描'}{props.review ? ' 篇候选' : ''}</StatusLabel>
    </div>)}</div>
    <ObsidianButton icon="plus" label="添加内容目录" onClick={props.onAddRoot} />
    {usesRoot ? <InlineAlert action={!props.vaultRootConfirmed ? <ObsidianButton label="确认整个 Vault" onClick={props.onConfirmVaultRoot} /> : undefined} icon="triangle-alert" title="Vault 根目录会扩大候选范围" tone="warning">{props.vaultRootConfirmed ? '已明确确认整个 Vault 的 Markdown 都进入候选扫描。' : '继续前必须明确确认。'}</InlineAlert> : null}
    <ObsidianButton icon="scan-search" label={props.review ? '重新扫描内容范围' : '扫描内容范围'} onClick={props.onScanScope} tone="cta" />
    {props.review ? <section class="pp-scan-result"><strong>找到 {props.review.candidateCount} 篇候选，{props.review.eligibleCount} 篇当前无 Blocker</strong>{props.review.examples.map((example) => <code key={example.sourcePath}>{example.sourcePath} → {example.url}</code>)}</section> : null}
  </div>;
}

function CloudflareStep(props: SetupWizardScreenProps) {
  const draft = props.draft.cloudflare;
  const connected = props.connection.state === 'connected';
  return <div class="pp-setup-step"><div class="eyebrow">第 4 步，共 5 步</div><h2 tabIndex={-1}>连接 Cloudflare</h2>
    <InlineAlert icon={connected ? 'cloud-check' : 'cloud-off'} title={connected ? `已连接：${'account' in props.connection && props.connection.account ? props.connection.account.name : draft.account.name}` : '尚未连接 Cloudflare'} tone={connected ? 'success' : 'warning'}>凭据保存在 Obsidian 安全存储；最终确认前不会创建或绑定项目。</InlineAlert>
    {props.canUseOAuth ? <ObsidianButton icon="cloud" label="使用 Cloudflare 登录" onClick={props.onConnectOAuth} tone="cta" /> : null}
    {props.canUseApiToken ? <ApiTokenConnect onConnect={props.onConnectApiToken} /> : null}
    {props.accounts.length > 0 ? <fieldset class="pp-choice-group"><legend>目标账号</legend>{props.accounts.map((account) => <button aria-pressed={draft.account.id === account.id} key={account.id} onClick={() => { void props.onSelectAccount(account); }}>{account.name}</button>)}</fieldset> : null}
    <label class="pp-form-field"><span><strong>Pages 项目标识</strong><small>创建或绑定计划；最终确认前不调用远端。</small></span><input aria-label="Pages 项目标识" onInput={(event) => { draft.projectName = event.currentTarget.value; props.draft.config.cloudflare.projectName = event.currentTarget.value; props.onUpdate(); }} value={draft.projectName} /></label>
    <div class="pp-setup-step__actions"><ObsidianButton label="检查可用性" onClick={props.onCheckProject} />{props.projectAvailability?.name === draft.projectName.trim() ? <StatusLabel tone={props.projectAvailability.available ? 'success' : 'warning'}>{props.projectAvailability.available ? '标识可用' : '项目已存在'}</StatusLabel> : null}</div>
    <fieldset class="pp-choice-group"><legend>项目动作</legend><button aria-pressed={draft.action === 'create'} onClick={() => { draft.action = 'create'; props.onUpdate(); }}>创建新项目</button><button aria-pressed={draft.action === 'bind'} onClick={() => { draft.action = 'bind'; props.onUpdate(); }}>绑定已有项目</button></fieldset>
    {draft.action === 'bind' && props.projects.length > 0 ? <fieldset class="pp-choice-group"><legend>已有项目</legend>{props.projects.map((project) => <button disabled={!project.compatible} key={project.id} onClick={() => props.onSelectProject(project)}>{project.compatible ? project.name : `不兼容 · ${project.name}`}</button>)}</fieldset> : null}
    <fieldset class="pp-choice-group"><legend>域名</legend><button aria-pressed={draft.domain.kind === 'pages-dev'} onClick={() => { draft.domain = { kind: 'pages-dev' }; props.onUpdate(); }}>使用 pages.dev</button><button aria-pressed={draft.domain.kind === 'custom'} onClick={() => { draft.domain = { kind: 'custom', hostname: '' }; props.onUpdate(); }}>连接自定义域名</button></fieldset>
    {draft.domain.kind === 'custom' ? <label class="pp-form-field"><span><strong>自定义域名</strong><small>确认后请求绑定，可能需要等待 DNS 验证。</small></span><input aria-label="自定义域名" onInput={(event) => { if (draft.domain.kind === 'custom') draft.domain.hostname = event.currentTarget.value; props.onUpdate(); }} value={draft.domain.hostname} /></label> : null}
  </div>;
}

function ReviewStep(props: SetupWizardScreenProps) {
  const draft = props.draft;
  return <div class="pp-setup-step"><div class="eyebrow">第 5 步，共 5 步</div><h2 tabIndex={-1}>确认设置计划</h2>
    <dl class="pp-setup-review"><div><dt>站点</dt><dd>{draft.config.site.name}</dd></div><div><dt>内容范围</dt><dd>{draft.config.contentRoots.map((root) => `${root.path} → ${root.publicRoot}`).join('；')}</dd></div><div><dt>Cloudflare</dt><dd>{draft.cloudflare.account.name} · {draft.cloudflare.action === 'create' ? '创建' : '绑定'} {draft.cloudflare.projectName}</dd></div><div><dt>域名</dt><dd>{draft.cloudflare.domain.kind === 'pages-dev' ? 'Cloudflare 分配的 pages.dev' : draft.cloudflare.domain.hostname}</dd></div></dl>
    <InlineAlert icon="check" title="将执行" tone="accent">验证草稿、创建或验证项目、原子写入 site.yml、扫描候选。</InlineAlert>
    <InlineAlert icon="shield-check" title="不会执行" tone="success">不会发布文章，也不会修改文章 Frontmatter。</InlineAlert>
  </div>;
}

function ApiTokenConnect({ onConnect }: { onConnect: (token: string) => void | Promise<void> }) { const [token, setToken] = useState(''); return <details><summary>高级方式 · 使用 API token</summary><div class="pp-api-token"><input aria-label="Cloudflare API token" onInput={(event) => setToken(event.currentTarget.value)} placeholder="粘贴 API token" type="password" value={token} /><ObsidianButton disabled={!token.trim()} label="连接" onClick={() => onConnect(token.trim())} /></div></details>; }
function Task({ checked, current, label }: { checked: boolean; current: boolean; label: string }) { return <li class={checked ? 'is-complete' : current ? 'is-active' : 'is-upcoming'}><ObsidianIcon icon={checked ? 'check' : current ? 'loader-circle' : 'circle'} /><span>{label}</span></li>; }
function isPreparing(stage: string): boolean { return ['checking-system', 'downloading-runtime', 'installing-runtime', 'verifying-engine', 'downloading-engine', 'installing-engine', 'smoke-testing', 'installing'].includes(stage); }
function continuationLabel(step: number): string { return ['继续：站点信息', '继续：内容范围', '继续：Cloudflare', '继续：确认'][step] ?? '继续'; }
function canContinue(props: SetupWizardScreenProps): boolean { if (props.step === 0) return props.environment.stage === 'ready'; if (props.step === 1) return props.draft.config.site.name.trim().length > 0 && Array.from(props.draft.config.site.description ?? '').length <= 160; if (props.step === 2) { const usesRoot = props.draft.config.contentRoots.some((root) => root.path.trim() === '.'); return props.review !== undefined && (!usesRoot || props.vaultRootConfirmed); } return props.connection.state === 'connected' && Boolean(props.draft.cloudflare.account.id) && ('account' in props.connection ? props.connection.account?.id === props.draft.cloudflare.account.id : false); }
