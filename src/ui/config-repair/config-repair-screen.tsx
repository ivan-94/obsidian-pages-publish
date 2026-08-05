import { EmptyState } from '../components/empty-state';
import { InlineAlert } from '../components/inline-alert';
import { StatusLabel, type UiTone } from '../components/status-label';
import { ObsidianButton } from '../obsidian/obsidian-button';

export interface ConfigValidationState {
  detail: string;
  issues: readonly string[];
  title: string;
  tone: UiTone;
}

export type ConfigRepairScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry: () => void | Promise<void> }
  | {
    status: 'ready';
    draftSource: string;
    diskSource?: string;
    dirty: boolean;
    busy: boolean;
    validation: ConfigValidationState;
    onDraftChange: (source: string) => void;
    onReadDisk: () => void | Promise<void>;
    onDiscard: () => void | Promise<void>;
    onSave: () => void | Promise<void>;
  };

export function ConfigRepairScreen({ state }: { state: ConfigRepairScreenState }) {
  if (state.status === 'loading') {
    return (
      <main class="plugin-view config-repair">
        <EmptyState description="正在安全读取隐藏配置文件。" icon="loader-circle" title="正在载入站点配置" />
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main class="plugin-view config-repair">
        <InlineAlert
          action={<ObsidianButton label="重新读取" onClick={state.onRetry} />}
          icon="circle-x"
          title="无法读取 .publish/site.yml"
          tone="danger"
        >
          {state.message}
        </InlineAlert>
      </main>
    );
  }

  return <ReadyConfigRepairScreen state={state} />;
}

function ReadyConfigRepairScreen({
  state,
}: {
  state: Extract<ConfigRepairScreenState, { status: 'ready' }>;
}) {
  return (
    <main class="plugin-view config-repair">
      <header class="compact-page-header">
        <div>
          <div class="eyebrow">高级维护</div>
          <h1>修复站点配置</h1>
          <div class="compact-meta">
            <StatusLabel
              icon={state.dirty ? 'pencil-line' : 'file-check'}
              tone={state.dirty ? 'warning' : 'success'}
            >
              {state.dirty ? '草稿有未保存修改' : '已载入当前磁盘版本'}
            </StatusLabel>
            <code>.publish/site.yml</code>
          </div>
        </div>
      </header>

      <InlineAlert
        action={state.dirty
          ? <ObsidianButton disabled={state.busy} label="放弃草稿" onClick={state.onDiscard} tone="destructive" />
          : undefined}
        icon="shield-alert"
        title="只修复本地配置"
        tone={state.dirty ? 'warning' : 'neutral'}
      >
        只有验证通过后才会原子替换配置；不会预览、上传或发布站点。
      </InlineAlert>

      <div class="yaml-layout">
        <section class="editor-shell" aria-labelledby="pp-yaml-editor-title">
          <div class="editor-label" id="pp-yaml-editor-title">
            site.yml · 修复草稿
          </div>
            <textarea
              aria-label="站点配置 YAML 修复编辑器"
              class="yaml-editor"
              disabled={state.busy}
              onInput={(event) => state.onDraftChange(event.currentTarget.value)}
              spellcheck={false}
              value={state.draftSource}
            />
        </section>

        <aside class="validation-panel section-stack" data-tone={state.validation.tone} aria-live="polite">
          <div class="eyebrow">验证结果</div>
          <h2>
            <StatusLabel
              icon={validationIcon(state.validation.tone)}
              tone={state.validation.tone}
            >
              {state.validation.title}
            </StatusLabel>
          </h2>
          <p>{state.validation.detail}</p>
          {state.validation.issues.length > 0 ? (
            <ul aria-label="配置校验问题">
              {state.validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : null}
          <dl class="key-value-list">
            <div><dt>保存影响</dt><dd>重载设置并重新扫描</dd></div>
            <div><dt>不会执行</dt><dd>预览、上传或发布</dd></div>
          </dl>
          <div class="validation-actions">
            <ObsidianButton
              busy={state.busy}
              busyLabel="正在验证并保存…"
              icon="check"
              label="验证并保存修复"
              onClick={state.onSave}
              tone="cta"
            />
            <ObsidianButton
              disabled={state.busy}
              icon="refresh-cw"
              label="查看磁盘版本"
              onClick={state.onReadDisk}
            />
          </div>
        </aside>
      </div>

      {state.diskSource !== undefined ? (
        <details class="config-disk-source">
          <summary>当前磁盘配置（修复草稿仍保留）</summary>
          <pre>{state.diskSource}</pre>
        </details>
      ) : null}
    </main>
  );
}

function validationIcon(tone: UiTone): string {
  if (tone === 'success') return 'circle-check';
  if (tone === 'danger') return 'circle-x';
  if (tone === 'warning') return 'triangle-alert';
  return 'circle-dot';
}
