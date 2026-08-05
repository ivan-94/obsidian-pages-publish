import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  ItemView: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class { constructor(readonly app: unknown, _: unknown) {} update(): void {} },
}));

import {
  readLocalThemeSelection,
  reloadSettingsDraft,
  settingsHeaderStatusText,
  settingsRemoteActionAvailability,
  settingsRemoteActionStatusText,
  trashHiddenSiteConfig,
} from '../src/plugin/settings-tab';

describe('settings host safety helpers', () => {
  it('reads a pathless Obsidian file selection as bounded theme archive bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(readLocalThemeSelection({ name: 'theme.tgz', size: bytes.length, arrayBuffer: async () => bytes.buffer })).resolves.toEqual({ fileName: 'theme.tgz', archive: bytes });
  });

  it('rejects non-tgz, empty, and inconsistent local theme selections', async () => {
    await expect(readLocalThemeSelection({ name: 'theme.zip', size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer })).rejects.toThrow('.tgz');
    await expect(readLocalThemeSelection({ name: 'theme.tgz', size: 0, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow('大小');
    await expect(readLocalThemeSelection({ name: 'theme.tgz', size: 2, arrayBuffer: async () => new Uint8Array([1]).buffer })).rejects.toThrow('不一致');
  });

  it('moves hidden configuration to system trash first', async () => {
    const trashSystem = vi.fn(async () => true); const trashLocal = vi.fn(async () => undefined);
    await trashHiddenSiteConfig({ trashSystem, trashLocal });
    expect(trashSystem).toHaveBeenCalledWith('.publish/site.yml');
    expect(trashLocal).not.toHaveBeenCalled();
  });

  it('falls back to local trash when system trash declines', async () => {
    const trashSystem = vi.fn(async () => false); const trashLocal = vi.fn(async () => undefined);
    await trashHiddenSiteConfig({ trashSystem, trashLocal });
    expect(trashLocal).toHaveBeenCalledWith('.publish/site.yml');
  });

  it('keeps the visible draft when discarding cannot reload', async () => {
    const current = { status: 'dirty' };
    await expect(reloadSettingsDraft({ getState: () => current, reloadExternal: async () => { throw new Error('disk unavailable'); } })).resolves.toEqual({ state: current, error: 'disk unavailable' });
  });

  it('returns a freshly reloaded external draft on success', async () => {
    const fresh = { status: 'clean' };
    await expect(reloadSettingsDraft({ getState: () => ({ status: 'dirty' }), reloadExternal: async () => fresh })).resolves.toEqual({ state: fresh });
  });

  it('projects honest local and remote status copy', () => {
    expect(settingsHeaderStatusText('clean')).toContain('唯一站点配置来源');
    expect(settingsHeaderStatusText('dirty')).toContain('未保存');
    expect(settingsHeaderStatusText('conflict')).toContain('不会被直接覆盖');
    expect(settingsRemoteActionStatusText('dirty')).toContain('已禁用');
  });

  it('blocks remote mutations for dirty and conflicting drafts', () => {
    expect(settingsRemoteActionAvailability('clean')).toEqual({ enabled: true });
    expect(settingsRemoteActionAvailability('dirty')).toEqual({ enabled: false, reason: '请先保存或放弃本地设置更改' });
    expect(settingsRemoteActionAvailability('conflict')).toEqual({ enabled: false, reason: '请先解决配置文件外部修改冲突' });
  });
});
