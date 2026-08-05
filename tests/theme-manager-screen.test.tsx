// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeManagerScreenProps } from '../src/ui/theme-manager/theme-manager-screen';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({ ObsidianIcon({ icon }: { icon: string }) { return <span data-icon={icon} />; } }));
vi.mock('../src/ui/obsidian/obsidian-button', () => ({ ObsidianButton({ disabled, label, onClick }: { disabled?: boolean; label: string; onClick: () => void }) { return <button disabled={disabled} onClick={onClick}>{label}</button>; } }));

import { ThemeManagerScreen } from '../src/ui/theme-manager/theme-manager-screen';

afterEach(() => document.body.replaceChildren());

describe('ThemeManagerScreen', () => {
  it('requires an exact npm coordinate before installation', () => {
    const onInstallNpm = vi.fn();
    render(<ThemeManagerScreen {...props({ onInstallNpm })} />);
    const install = screen.getByRole<HTMLButtonElement>('button', { name: '安装并校验' });
    expect(install.disabled).toBe(true);
    fireEvent.input(screen.getByRole('textbox', { name: 'npm 包名' }), { target: { value: '@demo/theme' } });
    fireEvent.input(screen.getByRole('textbox', { name: 'npm 精确版本' }), { target: { value: '1.2.3' } });
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    expect(onInstallNpm).toHaveBeenCalledWith('@demo/theme', '1.2.3');
  });

  it('separates validation, execution trust, selection, and uninstall', () => {
    const onConfirmTrust = vi.fn();
    render(<ThemeManagerScreen {...props({ onConfirmTrust })} />);
    expect(screen.getByText(/待信任/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看并使用' }));
    expect(onConfirmTrust).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '移除' })).toBeTruthy();
  });

  it('keeps the active theme selected while a repair is running', () => {
    const input = props({ busy: '正在修复当前主题' });
    input.active = input.panel!.installed[0]!.reference;
    input.panel!.installed[0]!.trusted = true;
    render(<ThemeManagerScreen {...input} />);
    expect(screen.getByText('正在修复当前主题')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '当前草稿' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '移除' }).disabled).toBe(true);
  });
});

function props(overrides: Partial<ThemeManagerScreenProps> = {}): ThemeManagerScreenProps {
  const candidate = { displayName: 'Demo Theme', packageName: '@demo/theme', version: '1.2.3', integrity: 'sha512-demo', capabilities: ['buildPlugins'], trusted: false, reference: { source: 'npm', package: '@demo/theme', version: '1.2.3', integrity: 'sha512-demo', options: {} } };
  return { panel: { installed: [candidate] } as never, onCancel: () => undefined, onConfirmTrust: () => undefined, onImportLocal: () => undefined, onInstallNpm: () => undefined, onRepair: () => undefined, onReturnSettings: () => undefined, onSelect: () => undefined, onUninstall: () => undefined, ...overrides };
}
