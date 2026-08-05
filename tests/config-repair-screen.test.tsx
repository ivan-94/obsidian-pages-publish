// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({
  ObsidianIcon({ icon }: { icon: string }) {
    return <span aria-hidden="true" data-icon={icon} />;
  },
}));

vi.mock('../src/ui/obsidian/obsidian-button', () => ({
  ObsidianButton({ disabled, label, onClick }: {
    disabled?: boolean;
    label: string;
    onClick: () => void;
  }) {
    return <button disabled={disabled} onClick={onClick}>{label}</button>;
  },
}));

import { ConfigRepairScreen } from '../src/ui/config-repair/config-repair-screen';

afterEach(() => document.body.replaceChildren());

describe('ConfigRepairScreen', () => {
  it('keeps draft editing, validation, and the sole primary save action together', () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    render(<ConfigRepairScreen state={{
      status: 'ready',
      draftSource: 'version: 1\nsite:\n  name: Demo',
      dirty: true,
      busy: false,
      validation: {
        title: '1 个校验问题',
        detail: '站点名称无效。',
        issues: ['site.name: 不能为空'],
        tone: 'danger',
      },
      onDraftChange,
      onReadDisk: () => undefined,
      onDiscard: () => undefined,
      onSave,
    }} />);

    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '站点配置 YAML 修复编辑器' });
    expect(document.querySelector('.editor-shell .yaml-editor')).toBe(editor);
    expect(document.querySelector('.pp-yaml-line-numbers')).toBeNull();
    fireEvent.input(editor, { target: { value: 'version: 2' } });
    expect(onDraftChange).toHaveBeenCalledWith('version: 2');
    expect(screen.getByText('site.name: 不能为空')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '验证并保存修复' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByText('不会执行').parentElement?.textContent).toContain('预览、上传或发布');
  });

  it('renders a retryable read error without an editor', () => {
    const onRetry = vi.fn();
    render(<ConfigRepairScreen state={{ status: 'error', message: '配置不存在', onRetry }} />);
    expect(screen.getByRole('alert').textContent).toContain('配置不存在');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
