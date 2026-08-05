import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepairScreenState } from '../src/ui/config-repair/config-repair-screen';

const testHost = vi.hoisted(() => ({
  current: undefined as { state: ConfigRepairScreenState } | undefined,
  notices: [] as string[],
}));

vi.mock('obsidian', () => ({
  ItemView: class {
    readonly app = {};
    readonly contentEl = { addClass() {}, removeClass() {} };
    constructor(_: unknown) {}
  },
  Notice: class { constructor(message: string) { testHost.notices.push(message); } },
}));

vi.mock('../src/ui/runtime/mount-preact-view', () => ({
  mountPreactView(_: unknown, __: unknown, initial: { state: ConfigRepairScreenState }) {
    testHost.current = initial;
    return {
      update(next: { state: ConfigRepairScreenState }) { testHost.current = next; },
      unmount() {},
    };
  },
}));

vi.mock('../src/ui/obsidian/open-confirmation-modal', () => ({
  openConfirmationModal: vi.fn(async () => true),
}));

import { PagesPublishSiteConfigRepairView } from '../src/plugin/site-config-repair-view';

describe('site configuration repair view controller', () => {
  const vaults: string[] = [];

  beforeEach(() => {
    testHost.current = undefined;
    testHost.notices.length = 0;
  });

  afterEach(async () => {
    await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })));
  });

  it('saves edited raw YAML without reformatting it', async () => {
    const vault = await createVault(vaults, source('Before'));
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    const repaired = source('After', '# operator note');
    ready().onDraftChange(repaired);
    await ready().onSave();

    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toBe(repaired);
    expect(ready().validation.title).toBe('校验通过 · 修复已保存');
    expect(testHost.notices).toContain('站点配置已修复并保存；没有发布。请回到设置页重新载入。');
  });

  it('does not write an invalid draft and exposes validation issues', async () => {
    const original = source('Before');
    const vault = await createVault(vaults, original);
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    ready().onDraftChange('version: [\n');
    await ready().onSave();

    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toBe(original);
    expect(ready().validation.tone).toBe('danger');
    expect(ready().validation.issues).toHaveLength(1);
    expect(testHost.notices.at(-1)).toMatch(/^无法保存修复：/);
  });

  it('stops on revision conflict and reloads disk only after confirmed discard', async () => {
    const vault = await createVault(vaults, source('Before'));
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    ready().onDraftChange(source('Local draft'));
    await writeFile(join(vault, '.publish', 'site.yml'), source('External edit'), 'utf8');

    await ready().onSave();
    expect(testHost.notices.at(-1)).toMatch(/^无法保存修复：Site configuration changed outside this editor/);
    expect(ready().draftSource).toBe(source('Local draft'));

    await ready().onDiscard();
    expect(ready().draftSource).toBe(source('External edit'));
    expect(ready().dirty).toBe(false);
  });
});

function ready(): Extract<ConfigRepairScreenState, { status: 'ready' }> {
  const state = testHost.current?.state;
  if (state?.status !== 'ready') throw new Error(`Expected ready state, got ${state?.status ?? 'none'}.`);
  return state;
}

async function createVault(vaults: string[], config: string): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'pages-publish-repair-view-'));
  vaults.push(vault);
  await mkdir(join(vault, '.publish'), { recursive: true });
  await writeFile(join(vault, '.publish', 'site.yml'), config, 'utf8');
  return vault;
}

function source(name: string, comment = ''): string {
  return [
    comment, 'version: 1', 'site:', `  name: ${name}`, '  home_layout: sections',
    'content_roots:', '  - path: notes', '    public_root: /notes', 'features:',
    '  search: true', '  graph: true', 'cloudflare:', '  project_name: repaired-wiki', '',
  ].filter((line, index) => line.length > 0 || index > 0).join('\n');
}
