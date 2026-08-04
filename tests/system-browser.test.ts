import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInSystemBrowser } from '../src/plugin/system-browser';

describe('system browser opener', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens external URLs through the desktop shell without creating an Obsidian web view', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('window', { open: windowOpen });
    const shell = {
      openExternal: vi.fn(async () => undefined),
    };

    await openInSystemBrowser('https://dash.cloudflare.com/oauth2/auth?state=fresh', shell);

    expect(shell.openExternal).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://dash.cloudflare.com/oauth2/auth?state=fresh',
    );
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
