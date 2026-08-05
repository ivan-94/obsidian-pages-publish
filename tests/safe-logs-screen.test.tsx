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

import { SafeLogsScreen } from '../src/ui/safe-logs/safe-logs-screen';

afterEach(() => document.body.replaceChildren());

describe('SafeLogsScreen', () => {
  it('renders only safe structured fields and requests an export review', () => {
    const onRequestExport = vi.fn();
    render(<SafeLogsScreen
      entries={[{
        at: '2026-08-04T14:31:08+08:00',
        stage: 'build',
        code: 'build.complete',
        counts: { articles: 18 },
      }]}
      exportAvailable
      exporting={false}
      onRequestExport={onRequestExport}
    />);

    expect(screen.getByRole('heading', { name: '安全维护日志' })).toBeTruthy();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索日志' });
    expect(search.placeholder).toBe('搜索事件或阶段');
    expect(search.parentElement?.textContent).toBe('');
    expect(screen.getByRole('list', { name: /1 条安全维护日志/ }).textContent).toContain('build.complete');
    expect(screen.getByRole('list', { name: /1 条安全维护日志/ }).textContent).toContain('articles=18');
    expect(screen.queryByText('日志范围')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }));
    expect(onRequestExport).toHaveBeenCalledOnce();
  });

  it('explains the empty session instead of rendering an empty table', () => {
    render(<SafeLogsScreen
      entries={[]}
      exportAvailable={false}
      exporting={false}
      onRequestExport={() => undefined}
    />);

    expect(screen.getByRole('heading', { name: '本次会话尚无安全日志' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出诊断包' }).disabled).toBe(true);
  });
});
