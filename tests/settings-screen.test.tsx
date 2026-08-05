// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsScreenProps } from '../src/ui/settings/settings-screen';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({ ObsidianIcon({ icon }: { icon: string }) { return <span data-icon={icon} />; } }));
vi.mock('../src/ui/obsidian/obsidian-button', () => ({ ObsidianButton({ disabled, label, onClick }: { disabled?: boolean; label: string; onClick: () => void }) { return <button disabled={disabled} onClick={onClick}>{label}</button>; } }));
vi.mock('../src/ui/obsidian/obsidian-toggle', () => ({ ObsidianToggle({ label, onChange, value }: { label: string; onChange: (value: boolean) => void; value: boolean }) { return <input aria-label={label} checked={value} onChange={(event) => onChange(event.currentTarget.checked)} type="checkbox" />; } }));

import { SettingsScreen } from '../src/ui/settings/settings-screen';

afterEach(() => document.body.replaceChildren());

describe('SettingsScreen', () => {
  it('renders the five HTML prototype sections in task order with a persistent save decision', () => {
    render(<SettingsScreen {...props()} />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['站点与内容', 'Cloudflare', '发布行为', '站点主题', '维护']);
    expect(screen.getByRole('button', { name: '保存设置' })).toBeTruthy();
    expect(screen.getByText('更改仅存在于本页草稿，尚未写入 site.yml。')).toBeTruthy();
  });

  it('keeps model updates in callbacks and pauses remote mutations while dirty', () => {
    const onUpdate = vi.fn();
    render(<SettingsScreen {...props({ onUpdate })} />);
    fireEvent.input(screen.getByRole('textbox', { name: '站点名称' }), { target: { value: '新站点' } });
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '验证并绑定' }).disabled).toBe(true);
    expect(screen.getByText('存在未保存草稿时，远端动作会暂停。')).toBeTruthy();
  });

  it('keeps compact fields on one row and reserves wide rows for compound or long input', () => {
    render(<SettingsScreen {...props()} />);
    const siteName = screen.getByRole<HTMLInputElement>('textbox', { name: '站点名称' });
    expect(siteName.type).toBe('text');
    expect(siteName.closest('.setting-row')?.classList.contains('is-wide')).toBe(false);
    expect(screen.getByRole('textbox', { name: '站点简介' }).closest('.setting-row')?.classList.contains('is-wide')).toBe(true);
    const contentRootRow = screen.getByRole('textbox', { name: '内容目录 1' }).closest('.setting-row');
    expect(contentRootRow?.classList.contains('is-wide')).toBe(true);
    expect(contentRootRow?.querySelector('.settings-inline-action button')?.textContent).toBe('添加内容目录');
    expect(screen.getByRole('checkbox', { name: '全文搜索' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '内置主题' }).closest('.pp-settings-select-action')).toBeTruthy();
  });

  it('exposes conflicts and URL effects without silently overwriting either', () => {
    const input = props({ pendingUrlChanges: [{ sourcePath: 'notes/a.md', onlineUrl: '/a/', pendingUrl: '/docs/a/' }] });
    input.state.status = 'conflict'; input.state.canSave = false;
    input.state.comparison = { currentSource: 'version: 1', draft: structuredClone(input.state.draft) };
    render(<SettingsScreen {...input} />);
    expect(screen.getByRole('alert').textContent).toContain('配置文件已在外部修改');
    expect(screen.getByText(/公开路径变化将影响 1 篇/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存设置' }).disabled).toBe(true);
  });

  it('keeps external theme selection visible and routes management to the dedicated view', () => {
    const onOpenThemeManager = vi.fn();
    const input = props({ onOpenThemeManager });
    input.state.draft.site.theme = { source: 'npm', package: '@demo/theme', version: '1.2.3', integrity: 'sha512-abcdefghijklmnopqrstuvwxyz', options: {} };
    render(<SettingsScreen {...input} />);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '内置主题' }).value).toBe('external');
    fireEvent.click(screen.getByRole('button', { name: '管理自定义主题' }));
    expect(onOpenThemeManager).toHaveBeenCalledOnce();
  });
});

function props(overrides: Partial<SettingsScreenProps> = {}): SettingsScreenProps {
  return {
    environment: { cache: 'ready', connection: 'connected', engine: '4.5.1', preview: '未运行', runtime: 'Obsidian 内嵌 · 22.0.0', stage: 'ready' },
    state: { status: 'dirty', canSave: true, revision: 'r1', draft: { version: 1, site: { name: 'Demo Wiki', description: 'A demo', homeLayout: 'sections', timezone: 'Asia/Shanghai' }, contentRoots: [{ path: 'notes', publicRoot: '/notes' }], assets: { exclude: [] }, features: { search: true, graph: true }, cloudflare: { projectName: 'demo', pagesDevDomain: 'demo.pages.dev' } } },
    onAddRoot: () => undefined, onBindDomain: () => undefined, onBindProject: () => undefined, onClearCache: () => undefined,
    onConnectToken: () => undefined, onDiscard: () => undefined, onExportDiagnostics: () => undefined, onOpenConfig: () => undefined,
    onOpenLogs: () => undefined, onOpenPublish: () => undefined, onOpenThemeManager: () => undefined, onReloadConflict: () => undefined,
    onRemoveRoot: () => undefined, onRepairEnvironment: () => undefined, onSave: () => undefined, onStartPreview: () => undefined,
    onUpdate: () => undefined, onValidate: () => undefined, ...overrides,
  };
}
