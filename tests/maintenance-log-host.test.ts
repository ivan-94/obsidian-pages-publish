import { describe, expect, it, vi } from 'vitest';
import {
  PAGES_PUBLISH_LOG_VIEW_TYPE,
  openLatestMaintenanceLog,
} from '../src/plugin/maintenance-log-host';

describe('Obsidian maintenance-log host', () => {
  it('opens the registered safe-log ItemView rather than resolving plugin data as a Vault file', async () => {
    const setViewState = vi.fn(async () => undefined);
    const leaf = { setViewState } as unknown as import('obsidian').WorkspaceLeaf;
    const getLeaf = vi.fn(() => leaf);
    const revealLeaf = vi.fn(async () => undefined);
    const workspace: Pick<
      import('obsidian').Workspace,
      'getLeaf' | 'revealLeaf'
    > = { getLeaf, revealLeaf };

    await openLatestMaintenanceLog({
      workspace,
    });

    expect(getLeaf).toHaveBeenCalledWith('tab');
    expect(setViewState).toHaveBeenCalledWith({
      type: PAGES_PUBLISH_LOG_VIEW_TYPE,
      active: true,
    });
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });
});
