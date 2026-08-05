// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({
  ObsidianIcon({ icon }: { icon: string }) {
    return <span aria-hidden="true" data-icon={icon} />;
  },
}));

import { mountPreactView } from '../src/ui/runtime/mount-preact-view';
import { EmptyState } from '../src/ui/components/empty-state';
import { InlineAlert } from '../src/ui/components/inline-alert';
import { StatusLabel } from '../src/ui/components/status-label';

afterEach(() => {
  document.body.replaceChildren();
});

describe('Preact view runtime', () => {
  it('mounts, updates, and unmounts one root without replacing the host', () => {
    render(<div data-testid="preact-host" />);
    const host = screen.getByTestId('preact-host');
    host.createDiv = (options = {}) => {
      const classes = typeof options === 'string' ? options : (options.cls ?? '');
      const className = Array.isArray(classes) ? classes.join(' ') : classes;
      render(<div class={className} />, { container: host });
      return host.firstElementChild as HTMLDivElement;
    };
    const mounted = mountPreactView<string>(host, (label) => <button>{label}</button>, '开始');
    const root = host.firstElementChild;

    expect(screen.getByRole('button', { name: '开始' })).toBeTruthy();
    mounted.update('继续');
    expect(host.firstElementChild).toBe(root);
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy();

    mounted.unmount();
    mounted.unmount();
    expect(host.children).toHaveLength(0);
  });

  it('renders status, alert, and empty-state semantics', () => {
    const onAction = vi.fn();
    render(
      <main>
        <StatusLabel icon="circle-check" tone="success">已连接</StatusLabel>
        <InlineAlert
          action={<button onClick={onAction}>查看问题</button>}
          icon="triangle-alert"
          title="发布被阻塞"
          tone="danger"
        >
          一张私密图片不会进入下一版。
        </InlineAlert>
        <EmptyState description="完成首次设置后会显示文章。" icon="cloud" title="尚未创建站点" />
      </main>,
    );

    expect(
      screen.getByText('已连接').closest('.pp-status-label')?.classList.contains('is-success'),
    ).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('一张私密图片不会进入下一版。');
    fireEvent.click(screen.getByRole('button', { name: '查看问题' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: '尚未创建站点' })).toBeTruthy();
  });
});
