import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  type Options = { cls?: string; text?: string; attr?: Record<string, string> };
  class Element {
    readonly children: Element[] = [];
    readonly attributes: Record<string, string> = {};

    constructor(readonly tag: string, options: Options = {}) {
      if (options.text !== undefined) this.text = options.text;
      Object.assign(this.attributes, options.attr);
    }

    text = '';

    createEl(tag: string, options: Options = {}): Element {
      const child = new Element(tag, options);
      this.children.push(child);
      return child;
    }

    createDiv(options: Options = {}): Element {
      const child = new Element('div', options);
      this.children.push(child);
      return child;
    }

    createSpan(options: Options = {}): Element {
      const child = new Element('span', options);
      this.children.push(child);
      return child;
    }

    addClass(): void {}
    addEventListener(): void {}
    empty(): void {
      this.children.length = 0;
    }
    setAttr(name: string, value: string): void {
      this.attributes[name] = value;
    }
  }
  class ButtonComponent {
    readonly buttonEl = new Element('button');

    constructor(container?: Element) {
      container?.children.push(this.buttonEl);
    }

    setButtonText(text: string): this {
      this.buttonEl.text = text;
      return this;
    }

    setTooltip(): this { return this; }
    setClass(): this { return this; }
    setCta(): this { return this; }
    setDisabled(): this { return this; }
    onClick(): this { return this; }
  }
  class ItemView {
    readonly contentEl = new Element('div');
    readonly app = { workspace: {} };

    constructor(_: unknown) {}
  }
  class Modal {
    readonly contentEl = new Element('div');
    readonly app = { workspace: {} };

    constructor(_: unknown) {}
    open(): void {}
    close(): void {}
  }

  return {
    ButtonComponent,
    ItemView,
    MarkdownView: class {},
    Modal,
    Notice: class {},
    Setting: class {},
  };
});

import { PagesPublishView } from '../src/plugin/view';

type ElementModel = {
  tag: string;
  attributes: Record<string, string>;
  children: ElementModel[];
};

describe('publish-center table accessibility', () => {
  it('renders semantic column headers and real narrow-row field labels', () => {
    const view = new PagesPublishView({} as never, {
      getPublicationStatus: () => ({ state: 'idle' }),
    } as never);
    const content = view.contentEl as unknown as ElementModel;
    const render = view as unknown as {
      renderPublishCenter(container: ElementModel, center: unknown): void;
    };

    render.renderPublishCenter(content, {
      siteName: 'Accessible Wiki',
      baseline: 'first-publish',
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 1, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 1,
        added: 1,
        updated: 0,
        urlChanged: 0,
        visibilityChanged: 0,
        takedowns: 0,
        unknown: 0,
        blockers: 0,
        warnings: 0,
      },
      issues: [],
      articles: [{
        sourcePath: 'notes/accessible.md',
        title: 'Accessible article',
        visibility: 'public',
        nextIncluded: true,
        availability: 'ready',
        change: 'added',
        issues: [],
      }],
    });

    const table = findElement(content, 'table');
    expect(table).toBeDefined();
    const headers = descendants(table!, 'th');
    expect(headers.map((header) => header.attributes.scope)).toEqual([
      'col', 'col', 'col', 'col', 'col',
    ]);
    expect(descendants(table!, 'td').map((cell) => cell.attributes['data-label'])).toEqual([
      '下一版包含', '文章 / 路径', '公开方式', '状态变化', '检查',
    ]);
  });
});

function findElement(root: ElementModel, tag: string): ElementModel | undefined {
  return descendants(root, tag)[0];
}

function descendants(root: ElementModel, tag: string): ElementModel[] {
  return root.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}
