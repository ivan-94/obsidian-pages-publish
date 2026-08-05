// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/obsidian/obsidian-api', () => ({
  ToggleComponent: class {
    toggleEl: HTMLDivElement;
    private change?: (value: boolean) => void;
    private value = false;

    constructor(host: HTMLElement) {
      this.toggleEl = document.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLDivElement;
      this.toggleEl.setAttribute('role', 'checkbox');
      this.toggleEl.addEventListener('click', () => this.change?.(!this.value));
      host.append(this.toggleEl);
    }

    onChange(change: (value: boolean) => void) { this.change = change; return this; }
    getValue() { return this.value; }
    setDisabled(disabled: boolean) { this.toggleEl.setAttribute('aria-disabled', String(disabled)); return this; }
    setValue(value: boolean) {
      this.value = value;
      this.toggleEl.setAttribute('aria-checked', String(value));
      this.change?.(value);
      return this;
    }
  },
}));

import { ObsidianToggle } from '../src/ui/obsidian/obsidian-toggle';

afterEach(() => document.body.replaceChildren());

describe('ObsidianToggle', () => {
  it('keeps Obsidian ownership while exposing value, label and change events', () => {
    const onChange = vi.fn();
    const view = render(<ObsidianToggle label="全文搜索" onChange={onChange} value={false} />);
    const toggle = screen.getByRole('checkbox', { name: '全文搜索' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    view.rerender(<ObsidianToggle disabled label="全文搜索" onChange={onChange} value />);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
