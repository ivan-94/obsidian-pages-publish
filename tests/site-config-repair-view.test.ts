import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const obsidianMock = vi.hoisted(() => {
  class Element {
    readonly children: Element[] = [];
    readonly listeners: Record<string, () => void | Promise<void>> = {};
    readonly attributes: Record<string, string> = {};
    text = '';
    value = '';

    constructor(readonly tag: string, input: { cls?: string; text?: string } = {}) {
      this.text = input.text ?? '';
      if (input.cls) this.attributes.class = input.cls;
    }

    createEl(tag: string, input: { cls?: string; text?: string } = {}): Element {
      const child = new Element(tag, input);
      this.children.push(child);
      return child;
    }
    createDiv(input: { cls?: string; text?: string } = {}): Element {
      const child = new Element('div', input);
      this.children.push(child);
      return child;
    }
    addClass(value: string): void { this.attributes.class = value; }
    empty(): void { this.children.length = 0; }
    setText(value: string): void { this.text = value; }
    setAttr(name: string, value: string): void { this.attributes[name] = value; }
    addEventListener(type: string, listener: () => void | Promise<void>): void {
      this.listeners[type] = listener;
    }
  }

  class ButtonComponent {
    readonly buttonEl = new Element('button');
    private action: (() => void | Promise<void>) | undefined;
    constructor(container: Element) { container.children.push(this.buttonEl); buttons.push(this); }
    setButtonText(text: string): this { this.buttonEl.text = text; return this; }
    setIcon(_: string): this { return this; }
    setCta(): this { return this; }
    setDestructive(): this { return this; }
    onClick(action: () => void | Promise<void>): this { this.action = action; return this; }
    async trigger(): Promise<void> { await this.action?.(); }
  }

  class ItemView {
    readonly contentEl = new Element('div');
    constructor(_: unknown) {}
  }

  const buttons: ButtonComponent[] = [];
  const notices: string[] = [];
  return { ButtonComponent, Element, ItemView, buttons, notices };
});

vi.mock('obsidian', () => ({
  ButtonComponent: obsidianMock.ButtonComponent,
  ItemView: obsidianMock.ItemView,
  Notice: class {
    constructor(message: string) { obsidianMock.notices.push(message); }
  },
}));

import { PagesPublishSiteConfigRepairView } from '../src/plugin/site-config-repair-view';

type ElementModel = InstanceType<typeof obsidianMock.Element>;

describe('site configuration repair view', () => {
  const vaults: string[] = [];

  beforeEach(() => {
    obsidianMock.buttons.length = 0;
    obsidianMock.notices.length = 0;
  });

  afterEach(async () => {
    await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })));
  });

  it('saves the edited raw YAML from the repair editor without reformatting it', async () => {
    const vault = await createVault(vaults, source('Before'));
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    const editor = textarea(view.contentEl as unknown as ElementModel);
    const repaired = source('After', '# operator note');
    editor.value = repaired;
    await editor.listeners.input?.();

    await button('验证并保存修复').trigger();

    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toBe(repaired);
    expect(text(view.contentEl as unknown as ElementModel)).toContain('站点配置');
    expect(obsidianMock.notices).toContain('站点配置已修复并保存；没有发布。请回到设置页重新载入。');
  });

  it('does not write an invalid editor draft', async () => {
    const original = source('Before');
    const vault = await createVault(vaults, original);
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    const editor = textarea(view.contentEl as unknown as ElementModel);
    editor.value = 'version: [\n';
    await editor.listeners.input?.();

    await button('验证并保存修复').trigger();

    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toBe(original);
    expect(obsidianMock.notices.at(-1)).toMatch(/^无法保存修复：/);
    expect(text(view.contentEl as unknown as ElementModel)).toContain('1 个校验问题');
  });

  it('loads the latest disk source after a conflict so a corrected draft can be saved', async () => {
    const vault = await createVault(vaults, source('Before'));
    const view = new PagesPublishSiteConfigRepairView({} as never, vault);
    await view.onOpen();
    const editor = textarea(view.contentEl as unknown as ElementModel);
    editor.value = source('Local draft');
    await editor.listeners.input?.();
    await writeFile(join(vault, '.publish', 'site.yml'), source('External edit'), 'utf8');

    await button('验证并保存修复').trigger();
    expect(obsidianMock.notices.at(-1)).toMatch(/^无法保存修复：Site configuration changed outside this editor/);

    await button('载入当前配置并放弃修复草稿').trigger();
    expect(editor.value).toBe(source('Local draft'));
    await button('再次点击以放弃修复草稿').trigger();
    expect(editor.value).toBe(source('External edit'));

    await button('验证并保存修复').trigger();
    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toBe(source('External edit'));
  });
});

async function createVault(vaults: string[], config: string): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'pages-publish-repair-view-'));
  vaults.push(vault);
  await mkdir(join(vault, '.publish'), { recursive: true });
  await writeFile(join(vault, '.publish', 'site.yml'), config, 'utf8');
  return vault;
}

function source(name: string, comment = ''): string {
  return [
    comment,
    'version: 1',
    'site:',
    `  name: ${name}`,
    '  home_layout: sections',
    'content_roots:',
    '  - path: notes',
    '    public_root: /notes',
    'features:',
    '  search: true',
    '  graph: true',
    'cloudflare:',
    '  project_name: repaired-wiki',
    '',
  ].filter((line, index) => line.length > 0 || index > 0).join('\n');
}

function button(textValue: string): InstanceType<typeof obsidianMock.ButtonComponent> {
  const result = obsidianMock.buttons.find((candidate) => candidate.buttonEl.text === textValue);
  if (!result) throw new Error(`Missing button: ${textValue}`);
  return result;
}

function textarea(root: ElementModel): ElementModel {
  const result = descendants(root).find((element) => element.tag === 'textarea');
  if (!result) throw new Error('Missing repair editor.');
  return result;
}

function descendants(root: ElementModel): ElementModel[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function text(root: ElementModel): string {
  return [root.text, ...descendants(root).map((element) => element.text)].join('');
}
