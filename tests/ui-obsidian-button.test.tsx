// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/obsidian/obsidian-api', () => ({
  ButtonComponent: class {
    buttonEl: HTMLButtonElement;
    constructor(host: HTMLElement) {
      this.buttonEl = document.createElementNS('http://www.w3.org/1999/xhtml', 'button') as HTMLButtonElement;
      host.append(this.buttonEl);
    }
    onClick() { return this; }
    setButtonText(label: string) { this.buttonEl.textContent = label; return this; }
    setIcon(icon: string) {
      const marker = document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      marker.dataset.icon = icon;
      this.buttonEl.replaceChildren(marker);
      return this;
    }
    setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
    setTooltip(value: string) { this.buttonEl.title = value; return this; }
    setCta() { return this; }
    setDestructive() { return this; }
  },
}));

import { ObsidianButton } from '../src/ui/obsidian/obsidian-button';

afterEach(() => document.body.replaceChildren());

describe('ObsidianButton', () => {
  it('keeps icon and label while applying multiple prototype classes', () => {
    render(<ObsidianButton className="button-ghost icon-button" icon="cloud" label="发布" onClick={() => undefined} />);
    const button = screen.getByRole('button', { name: '发布' });
    expect(button.textContent).toContain('发布');
    expect(button.querySelector('[data-icon="cloud"]')).toBeTruthy();
    expect(button.classList.contains('button-ghost')).toBe(true);
    expect(button.classList.contains('icon-button')).toBe(true);
  });
});
