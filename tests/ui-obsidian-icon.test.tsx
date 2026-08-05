// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setIconMock = vi.hoisted(() => vi.fn((element: HTMLElement, icon: string) => {
  element.setAttribute('data-rendered-icon', icon);
}));

vi.mock('../src/ui/obsidian/obsidian-api', () => ({
  setIcon: setIconMock,
}));

import { ObsidianIcon } from '../src/ui/obsidian/obsidian-icon';

afterEach(() => {
  document.body.replaceChildren();
  setIconMock.mockClear();
});

describe('ObsidianIcon', () => {
  it('updates the host icon and clears Obsidian-owned children on unmount', () => {
    const result = render(<ObsidianIcon icon="cloud" label="发布" />);
    const icon = screen.getByRole('img', { name: '发布' });

    expect(icon.getAttribute('data-rendered-icon')).toBe('cloud');
    result.rerender(<ObsidianIcon icon="circle-check" label="已完成" />);
    expect(screen.getByRole('img', { name: '已完成' }).getAttribute('data-rendered-icon'))
      .toBe('circle-check');
    expect(setIconMock).toHaveBeenCalledTimes(2);

    result.unmount();
    expect(icon.children).toHaveLength(0);
  });
});
