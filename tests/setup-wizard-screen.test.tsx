// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupWizardScreenProps } from '../src/ui/setup/setup-wizard-screen';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({ ObsidianIcon({ icon }: { icon: string }) { return <span aria-hidden="true" data-icon={icon} />; } }));
vi.mock('../src/ui/obsidian/obsidian-button', () => ({ ObsidianButton({ disabled, label, onClick }: { disabled?: boolean; label: string; onClick: () => void }) { return <button disabled={disabled} onClick={onClick}>{label}</button>; } }));

import { SetupExecutionScreen, SetupWizardScreen } from '../src/ui/setup/setup-wizard-screen';

afterEach(() => document.body.replaceChildren());

describe('SetupWizardScreen', () => {
  it('shows truthful environment tasks and blocks continuation until ready', () => {
    render(<SetupWizardScreen {...props({ environment: { stage: 'failed', nextAction: 'repair', impact: '引擎校验失败。' } as never })} />);
    expect(screen.getByRole('heading', { name: '确认本地环境' })).toBeTruthy();
    expect(screen.getByText('引擎校验失败。')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续：站点信息' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '重试环境准备' })).toBeTruthy();
  });

  it('keeps site identity controlled and enforces the 160-character boundary', () => {
    const onUpdate = vi.fn();
    const value = '站'.repeat(161);
    const input = props({ step: 1, onUpdate });
    input.draft.config.site.description = value;
    render(<SetupWizardScreen {...input} />);
    expect(screen.getByText('161 / 160').classList.contains('is-danger')).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续：内容范围' }).disabled).toBe(true);
    fireEvent.input(screen.getByRole('textbox', { name: '站点名称' }), { target: { value: '新站点' } });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('requires both a fresh scan and explicit Vault-root confirmation', () => {
    const input = props({ step: 2 });
    input.draft.config.contentRoots = [{ path: '.', publicRoot: '/' }];
    input.review = { candidateCount: 4, eligibleCount: 3, config: input.draft.config, cloudflare: input.draft.cloudflare, issues: [], examples: [], roots: [{ path: '.', candidateCount: 4 }] };
    render(<SetupWizardScreen {...input} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续：Cloudflare' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '确认整个 Vault' })).toBeTruthy();
  });

  it('uses OAuth first and keeps API token in an advanced disclosure', () => {
    render(<SetupWizardScreen {...props({ step: 3 })} />);
    expect(screen.getByRole('button', { name: '使用 Cloudflare 登录' })).toBeTruthy();
    expect(screen.getByText('高级方式 · 使用 API token')).toBeTruthy();
    expect(screen.getByRole('group', { name: '项目动作' })).toBeTruthy();
  });

  it('freezes the final plan into will/will-not review and shows five execution stages', () => {
    const { rerender } = render(<SetupWizardScreen {...props({ step: 4 })} />);
    expect(screen.getByText('将执行')).toBeTruthy();
    expect(screen.getByText('不会执行')).toBeTruthy();
    rerender(<SetupExecutionScreen onContinue={() => undefined} onRetry={() => undefined} onReturn={() => undefined} stage="domain" state="running" />);
    expect(screen.getByRole('list', { name: '创建站点进度' }).querySelectorAll('li')).toHaveLength(5);
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toContain('域名计划');
  });
});

function props(overrides: Partial<SetupWizardScreenProps> = {}): SetupWizardScreenProps {
  return {
    accounts: [{ id: 'a', name: 'Demo account' }], canUseApiToken: true, canUseOAuth: true,
    connection: { state: 'connected', account: { id: 'a', name: 'Demo account' } },
    draft: { config: { version: 1, site: { name: 'Demo', homeLayout: 'sections' }, contentRoots: [{ path: 'notes', publicRoot: '/notes' }], assets: { exclude: [] }, features: { search: true, graph: true }, cloudflare: { projectName: 'demo' } }, cloudflare: { account: { id: 'a', name: 'Demo account' }, action: 'create', projectName: 'demo', domain: { kind: 'pages-dev' } } },
    environment: { stage: 'ready', nextAction: 'continue' } as never, projects: [], step: 0, vaultRootConfirmed: false,
    onAddRoot: () => undefined, onBack: () => undefined, onCancelEnvironment: () => undefined, onCheckProject: () => undefined,
    onConnectApiToken: () => undefined, onConnectOAuth: () => undefined, onConfirm: () => undefined, onConfirmVaultRoot: () => undefined,
    onContinue: () => undefined, onExit: () => undefined, onRemoveRoot: () => undefined, onRepairEnvironment: () => undefined,
    onScanScope: () => undefined, onSelectAccount: () => undefined, onSelectProject: () => undefined, onUpdate: () => undefined,
    ...overrides,
  };
}
