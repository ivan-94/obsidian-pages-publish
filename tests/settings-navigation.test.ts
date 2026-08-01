import { describe, expect, it, vi } from 'vitest';
import { openPluginSettingsInHost } from '../src/plugin/settings-navigation';

describe('settings navigation compatibility boundary', () => {
  it('opens the plugin settings when the desktop host exposes a settings modal', () => {
    const open = vi.fn();
    const openTabById = vi.fn();

    expect(
      openPluginSettingsInHost({ setting: { open, openTabById } }, 'pages-publish'),
    ).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(openTabById).toHaveBeenCalledWith('pages-publish');
  });

  it('returns false instead of calling an undocumented host shape', () => {
    expect(openPluginSettingsInHost({}, 'pages-publish')).toBe(false);
    expect(
      openPluginSettingsInHost({ setting: { open: vi.fn() } }, 'pages-publish'),
    ).toBe(false);
  });
});
