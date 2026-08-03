import { describe, expect, it, vi } from 'vitest';

type TestTextComponent = {
  inputEl: { type: string; value: string };
  trigger(value: string): void;
};
const textComponents = vi.hoisted(() => [] as TestTextComponent[]);
const settingDescriptions = vi.hoisted(() => [] as string[]);
const focusedElements = vi.hoisted(() => ({
  current: undefined as { attributes: Record<string, string> } | undefined,
}));
const menus = vi.hoisted(() => [] as Array<{
  items: Array<{ title: string; click?: () => void | Promise<void> }>;
  shown: boolean;
  showEvent?: unknown;
}>);

vi.mock('obsidian', () => {
  type Options = { cls?: string; text?: string; attr?: Record<string, string> };
  class Element {
    readonly children: Element[] = [];
    readonly attributes: Record<string, string> = {};
    readonly listeners: Record<string, (event?: unknown) => void | Promise<void>> = {};

    constructor(readonly tag: string, options: Options = {}) {
      if (options.text !== undefined) this.text = options.text;
      if (options.cls !== undefined) this.attributes.class = options.cls;
      Object.assign(this.attributes, options.attr);
    }

    text = '';
    value = '';
    hidden = false;
    click?: (event?: unknown) => void | Promise<void>;

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
    addEventListener(
      type: string,
      listener: (event?: unknown) => void | Promise<void>,
    ): void {
      this.listeners[type] = listener;
    }
    async trigger(type: string): Promise<void> {
      await this.listeners[type]?.({ target: this });
    }
    setText(value: string): void { this.text = value; }
    empty(): void {
      if (focusedElements.current
        && this.contains(focusedElements.current as unknown as Element)) {
        delete focusedElements.current.attributes['data-focused'];
        focusedElements.current = undefined;
      }
      this.children.length = 0;
    }
    setAttr(name: string, value: string): void {
      this.attributes[name] = value;
    }
    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
    }
    focus(): void {
      if (focusedElements.current) delete focusedElements.current.attributes['data-focused'];
      focusedElements.current = this;
      this.attributes['data-focused'] = 'true';
    }
    private contains(candidate: Element): boolean {
      return this === candidate || this.children.some((child) => child.contains(candidate));
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

    setTooltip(value: string): this {
      this.buttonEl.attributes['aria-label'] = value;
      return this;
    }
    setIcon(): this { return this; }
    setClass(value: string): this {
      if (!value) throw new Error('DOMTokenList class token must not be empty.');
      return this;
    }
    setCta(): this { return this; }
    setDestructive(): this { return this; }
    setDisabled(disabled = true): this {
      this.buttonEl.attributes.disabled = String(disabled);
      return this;
    }
    onClick(callback: (event?: unknown) => void | Promise<void>): this {
      this.buttonEl.click = callback;
      return this;
    }
  }
  class MenuItem {
    title = '';
    click?: () => void | Promise<void>;

    setTitle(value: string): this {
      this.title = value;
      return this;
    }
    setIcon(): this { return this; }
    onClick(callback: () => void | Promise<void>): this {
      this.click = callback;
      return this;
    }
  }
  class Menu {
    readonly items: MenuItem[] = [];
    shown = false;

    constructor() {
      menus.push(this);
    }
    addItem(callback: (item: MenuItem) => void): this {
      const item = new MenuItem();
      callback(item);
      this.items.push(item);
      return this;
    }
    showAtMouseEvent(event?: unknown): this {
      this.shown = true;
      menus.at(-1)!.showEvent = event;
      return this;
    }
  }
  class ItemView {
    readonly contentEl = new Element('div');
    readonly app = {
      workspace: {},
      vault: { getName: () => 'Test Vault' },
    };

    readonly leaf: unknown;

    constructor(leaf: unknown) {
      this.leaf = leaf;
    }
  }
  class TextComponent {
    readonly inputEl = { type: 'text', value: '' };
    private change: ((value: string) => void) | undefined;

    constructor() {
      textComponents.push(this);
    }

    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }

    setPlaceholder(): this { return this; }
    onChange(change: (value: string) => void): this {
      this.change = change;
      return this;
    }

    trigger(value: string): void {
      this.inputEl.value = value;
      this.change?.(value);
    }
  }
  class Setting {
    constructor(_: Element) {}

    setName(): this { return this; }
    setDesc(value: string): this {
      settingDescriptions.push(value);
      return this;
    }
    addText(callback: (text: TextComponent) => void): this {
      callback(new TextComponent());
      return this;
    }
    addTextArea(callback: (text: TextComponent) => void): this {
      callback(new TextComponent());
      return this;
    }
    addButton(callback: (button: ButtonComponent) => void): this {
      callback(new ButtonComponent());
      return this;
    }
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
    Menu,
    MarkdownView: class {},
    Modal,
    Notice: class {},
    Setting,
    setIcon: () => undefined,
  };
});

import { PagesPublishView, publicationStatusText } from '../src/plugin/view';

type ElementModel = {
  tag: string;
  text: string;
  value: string;
  hidden: boolean;
  click?: (event?: unknown) => void | Promise<void>;
  trigger(type: string): Promise<void>;
  attributes: Record<string, string>;
  children: ElementModel[];
};

describe('publish-center table accessibility', () => {
  it('keeps setup blocked when the local environment fails even if Cloudflare is connected', async () => {
    const account = { id: 'account-1', name: 'Test account' };
    const getInitialSetupConnection = vi.fn(async () => ({
      state: 'connected' as const,
      account,
    }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'failed',
        impact: '本地预览和发布暂不可用。',
        nextAction: 'repair',
        detailsAvailable: true,
      }),
      prepareInitialSetupEnvironment: async () => ({ stage: 'failed' }),
      repairInitialSetupEnvironment: async () => ({ stage: 'failed' }),
      getInitialSetupConnection,
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    expect(getInitialSetupConnection).not.toHaveBeenCalled();

    const content = view.contentEl as unknown as ElementModel;
    const continueButton = findSetupContinue(content);
    expect(continueButton?.attributes.disabled).toBe('true');
    expect(continueButton?.click).toBeTypeOf('function');
    await continueButton?.click?.();
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('准备本地发布环境');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .not.toContain('站点信息');
  });

  it('prepares an idle local environment and unlocks setup only after it is ready', async () => {
    let environment: { stage: 'idle' | 'checking-system' | 'ready' } = { stage: 'idle' };
    let finishPreparation: (() => void) | undefined;
    let globalUiListener: (() => void) | undefined;
    const prepareInitialSetupEnvironment = vi.fn(async () => {
      environment = { stage: 'checking-system' };
      await new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      environment = { stage: 'ready' };
      globalUiListener?.();
      return environment;
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        globalUiListener = listener;
        return () => undefined;
      },
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => environment,
      prepareInitialSetupEnvironment,
      getInitialSetupConnection: vi.fn(),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();

    const content = view.contentEl as unknown as ElementModel;
    expect(prepareInitialSetupEnvironment).toHaveBeenCalledTimes(1);
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('true');

    finishPreparation?.();
    await vi.waitFor(() => {
      expect(findSetupContinue(content)
        ?.attributes.disabled).toBe('false');
    });
    await Promise.resolve();
    expect(descendants(content, 'h2').filter((heading) => heading.text === '创建你的发布站点'))
      .toHaveLength(1);
    expect(findSetupContinues(content))
      .toHaveLength(1);
  });

  it('shows truthful environment stages and a safe details disclosure', async () => {
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: vi.fn(),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    expect(descendants(content, 'li').map((item) => item.text).filter(Boolean)).toEqual([
      '✓ 检查系统与 Vault',
      '✓ Obsidian Node.js 22.14.0',
      '✓ Pages 发布引擎 0.1.0',
      '○ 本地预览服务将在创建站点后按需验证',
    ]);
    await clickButton(content, '查看详情');
    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .toContain('不会修改系统 Node.js、npm、PATH 或全局包');
  });

  it('lets the user retry a failed local environment preparation in place', async () => {
    let environment: {
      stage: 'failed' | 'ready';
      impact?: string;
      nextAction?: 'repair';
      detailsAvailable?: boolean;
    } = {
      stage: 'failed',
      impact: '发布引擎校验失败。',
      nextAction: 'repair',
      detailsAvailable: true,
    };
    const repairInitialSetupEnvironment = vi.fn(async () => {
      environment = { stage: 'ready' };
      return environment;
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => environment,
      prepareInitialSetupEnvironment: vi.fn(),
      repairInitialSetupEnvironment,
      getInitialSetupConnection: vi.fn(),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();

    const content = view.contentEl as unknown as ElementModel;
    const retry = descendants(content, 'button')
      .find((button) => button.text === '重试环境准备');
    expect(retry?.click).toBeTypeOf('function');
    await retry?.click?.();
    expect(repairInitialSetupEnvironment).toHaveBeenCalledTimes(1);
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('false');
  });

  it('allows environment-ready users to edit the local draft before connecting Cloudflare', async () => {
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'system', version: '22.0.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();

    const content = view.contentEl as unknown as ElementModel;
    let continueButton = findSetupContinue(content);
    expect(continueButton?.attributes.disabled).toBe('false');
    await continueButton?.click?.();
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('站点信息');

    continueButton = findSetupContinue(content);
    expect(continueButton?.attributes.disabled).toBe('false');
    await continueButton?.click?.();
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('内容范围');
  });

  it('labels each setup continuation with its destination', async () => {
    const account = { id: 'account-1', name: 'OAuth account' };
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'connected', account }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects: async () => [],
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('继续：站点信息');

    await clickButton(content, '继续');
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('继续：内容范围');

    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('继续：Cloudflare');

    await clickButton(content, '继续');
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('继续：确认');
  });

  it('moves keyboard focus to the newly entered setup step heading', async () => {
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');

    expect(descendants(content, 'h3').find((heading) => heading.text === '站点信息')
      ?.attributes['data-focused']).toBe('true');
  });

  it('restores setup-heading focus when returning and editing every confirmation summary', async () => {
    const account = { id: 'account-1', name: 'OAuth account' };
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'connected', account }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects: async () => [],
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const expectFocusedHeading = (text: string): void => {
      expect(descendants(content, 'h3').find((heading) => heading.text === text)
        ?.attributes['data-focused']).toBe('true');
    };

    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '返回');
    expectFocusedHeading('站点信息');

    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '编辑站点信息');
    expectFocusedHeading('站点信息');

    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '编辑内容范围');
    expectFocusedHeading('内容范围');

    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '编辑 Cloudflare');
    expectFocusedHeading('Cloudflare');
  });

  it('keeps the required site name fail-closed before content scope', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    const siteName = textComponents.find((input) => input.inputEl.value === 'Test Vault');
    expect(siteName).toBeDefined();
    siteName?.trigger('   ');
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('true');
    await clickButton(content, '继续');

    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('站点信息');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .not.toContain('内容范围');
  });

  it('shows the live 160-character site description limit', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    expect(descendants(content, 'span').map((span) => span.text)).toContain('0 / 160');

    const description = textComponents.find((input) => input.inputEl.value === '');
    expect(description).toBeDefined();
    description?.trigger('三个字');
    expect(descendants(content, 'span').map((span) => span.text)).toContain('3 / 160');
  });

  it('keeps an over-limit site description fail-closed', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    const description = textComponents.find((input) => input.inputEl.value === '');
    description?.trigger('字'.repeat(161));
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('true');
    await clickButton(content, '继续');

    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('站点信息');
  });

  it('lets setup add a second content directory before Cloudflare', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '添加内容目录');

    expect(textComponents.slice(-4).map((input) => input.inputEl.value))
      .toEqual(['notes', '/notes', '', '/']);
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('移除内容目录 2');
  });

  it('shows the local scan result before enabling Cloudflare continuation', async () => {
    const reviewInitialSetup = vi.fn(async () => ({
      candidateCount: 3,
      eligibleCount: 2,
      examples: [{ sourcePath: 'guide/agents.md', url: '/guide/agents/' }],
      roots: [{ path: 'notes', candidateCount: 3 }],
    }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => true,
      reviewInitialSetup,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('true');

    await clickButton(content, '扫描内容范围');

    expect(reviewInitialSetup).toHaveBeenCalledOnce();
    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .toContain('找到 3 篇候选，其中 2 篇当前无 Blocker');
    expect(descendants(content, 'span').map((span) => span.text))
      .toContain('扫描结果：3 篇');
    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .toContain('guide/agents.md → /guide/agents/');
    expect(findSetupContinue(content)
      ?.attributes.disabled).toBe('false');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('内容范围');
  });

  it('invalidates a completed scope scan when the content roots change', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => false,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    const contentRoot = textComponents.slice().reverse()
      .find((input) => input.inputEl.value === 'notes');
    expect(contentRoot).toBeDefined();
    contentRoot?.trigger('guide');
    await clickButton(content, '继续');

    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('内容范围');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .not.toContain('Cloudflare');
  });

  it('requires an explicit exposure confirmation before using the Vault root', async () => {
    textComponents.length = 0;
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 3, eligibleCount: 3 }),
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    const contentRoot = textComponents.slice().reverse()
      .find((input) => input.inputEl.value === 'notes');
    contentRoot?.trigger('.');
    await clickButton(content, '扫描内容范围');

    const blockedContinue = findSetupContinue(content);
    expect(blockedContinue?.attributes.disabled).toBe('true');
    await clickButton(content, '确认将整个 Vault 纳入候选范围');
    const enabledContinue = findSetupContinue(content);
    expect(enabledContinue?.attributes.disabled).toBe('false');
  });

  it('reviews the local content draft before entering the Cloudflare step', async () => {
    settingDescriptions.length = 0;
    const reviewInitialSetup = vi.fn(async () => ({
      candidateCount: 2,
      eligibleCount: 2,
    }));
    const beginInitialSetupOAuth = vi.fn(async () => undefined);
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth,
      canConnectInitialSetupApiToken: () => true,
      reviewInitialSetup,
    } as never);

    await view.onOpen();

    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');

    expect(reviewInitialSetup).toHaveBeenCalledTimes(1);
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('Cloudflare');
    expect(descendants(content, 'p').map((element) => element.text).join('\n'))
      .toContain('请使用 Cloudflare 登录完成授权');
    expect(descendants(content, 'p').map((element) => element.text).join('\n'))
      .not.toContain('未配置 OAuth client');
    expect(settingDescriptions.join('\n')).not.toContain('未配置 OAuth client');
    expect(settingDescriptions.join('\n')).toContain('高级备用方式');
    await clickButton(content, '使用 Cloudflare 登录');
    expect(beginInitialSetupOAuth).toHaveBeenCalledTimes(1);
    const cloudflareContinue = findSetupContinue(content);
    expect(cloudflareContinue?.attributes.disabled).toBe('true');
    await cloudflareContinue?.click?.();
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('Cloudflare');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .not.toContain('确认创建站点');
  });

  it('refreshes the existing setup step after OAuth completes without replacing the wizard', async () => {
    textComponents.length = 0;
    let globalUiListener: (() => void) | undefined;
    let connection: { state: 'disconnected' } | {
      state: 'connected';
      account: { id: string; name: string };
    } = { state: 'disconnected' };
    const application = {
      isPublicationAvailable: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        globalUiListener = listener;
        return () => undefined;
      },
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => connection,
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
      completeInitialSetupOAuth: async () => {
        connection = {
          state: 'connected' as const,
          account: { id: 'account-1', name: 'OAuth account' },
        };
        globalUiListener?.();
        return connection;
      },
    };
    const view = new PagesPublishView({} as never, application as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    const siteName = textComponents.find((input) => input.inputEl.value === 'Test Vault');
    expect(siteName).toBeDefined();
    siteName?.trigger('OAuth draft preserved');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    expect(globalUiListener).toBeTypeOf('function');

    await application.completeInitialSetupOAuth();

    await vi.waitFor(() => {
      expect(descendants(content, 'h3').map((heading) => heading.text))
        .toContain('Cloudflare');
      expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
        .toContain('将使用已连接账号：OAuth account');
    });
    await clickButton(content, '返回');
    await clickButton(content, '返回');
    expect(textComponents.at(-2)?.inputEl.value).toBe('OAuth draft preserved');
  });

  it('rechecks Cloudflare at final confirmation and fails closed after authorization expires', async () => {
    const account = { id: 'account-1', name: 'OAuth account' };
    let connection: {
      state: 'connected' | 'expired';
      account: typeof account;
    } = { state: 'connected', account };
    const reviewInitialSetup = vi.fn(async () => ({ candidateCount: 1, eligibleCount: 1 }));
    const confirmInitialSetup = vi.fn(async (_draft: {
      cloudflare: { projectName: string };
    }) => ({
      domain: { url: 'https://test-vault.pages.dev' },
      scan: { candidateCount: 1 },
    }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => connection,
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup,
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects: async () => [],
      confirmInitialSetup,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    const reviewCountBeforeConfirmation = reviewInitialSetup.mock.calls.length;
    const create = descendants(content, 'button')
      .find((button) => button.text === '创建站点并开始扫描');
    expect(create?.click).toBeTypeOf('function');

    connection = { state: 'expired', account };
    await create?.click?.();

    expect(reviewInitialSetup).toHaveBeenCalledTimes(reviewCountBeforeConfirmation);
    expect(confirmInitialSetup).not.toHaveBeenCalled();
  });

  it('freezes the reviewed setup plan while final confirmation is in flight', async () => {
    textComponents.length = 0;
    const account = { id: 'account-1', name: 'OAuth account' };
    let finishFinalReview: (() => void) | undefined;
    const reviewInitialSetup = vi.fn()
      .mockResolvedValueOnce({ candidateCount: 1, eligibleCount: 1 })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishFinalReview = resolve;
        });
        return { candidateCount: 1, eligibleCount: 1 };
      });
    const confirmInitialSetup = vi.fn(async (_draft: {
      cloudflare: { projectName: string };
    }) => ({
      domain: { url: 'https://test-vault.pages.dev' },
      scan: { candidateCount: 1 },
    }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'connected', account }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup,
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects: async () => [],
      confirmInitialSetup,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    const projectName = textComponents.find((input) => input.inputEl.value === 'test-vault');
    expect(projectName).toBeDefined();
    await clickButton(content, '继续');
    const create = descendants(content, 'button')
      .find((button) => button.text === '创建站点并开始扫描');
    if (!create?.click) throw new Error('Expected final setup action.');
    const confirmation = create.click();
    await vi.waitFor(() => expect(reviewInitialSetup).toHaveBeenCalledTimes(2));

    expect(descendants(content, 'h2').map((heading) => heading.text))
      .toContain('正在创建站点');
    expect(descendants(content, 'button').map((button) => button.text))
      .not.toContain('返回');
    projectName?.trigger('changed-after-confirm');
    finishFinalReview?.();
    await confirmation;

    expect(confirmInitialSetup).toHaveBeenCalledOnce();
    expect(confirmInitialSetup.mock.calls[0]?.[0]?.cloudflare.projectName).toBe('test-vault');
  });

  it('lets the confirmation summary return directly to each editable setup section', async () => {
    const account = { id: 'account-1', name: 'OAuth account' };
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'connected', account }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects: async () => [],
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    await clickButton(content, '继续');

    expect(descendants(content, 'button').map((button) => button.text)).toEqual(
      expect.arrayContaining(['编辑站点信息', '编辑内容范围', '编辑 Cloudflare']),
    );
    await clickButton(content, '编辑站点信息');
    expect(descendants(content, 'h3').map((heading) => heading.text))
      .toContain('站点信息');
  });

  it('checks a planned Pages project name without creating it', async () => {
    const account = { id: 'account-1', name: 'OAuth account' };
    const listInitialSetupProjects = vi.fn(async () => []);
    const confirmInitialSetup = vi.fn();
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup',
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'connected', account }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
      listInitialSetupAccounts: async () => [account],
      listInitialSetupProjects,
      confirmInitialSetup,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');
    await clickButton(content, '检查可用性');

    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .toContain('test-vault 可用');
    expect(confirmInitialSetup).not.toHaveBeenCalled();
    expect(listInitialSetupProjects).toHaveBeenCalled();
  });

  it('keeps Cloudflare continuation blocked when a restored draft targets another account', async () => {
    const connectedAccount = { id: 'account-1', name: 'Current account' };
    const draftAccount = { id: 'account-2', name: 'Draft account' };
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupDraft: () => ({
        config: {
          version: 1,
          site: { name: 'Restored site', homeLayout: 'sections' },
          contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
          assets: { exclude: [] },
          features: { search: true, graph: true },
          cloudflare: { projectName: 'restored-site' },
        },
        cloudflare: {
          account: draftAccount,
          action: 'create' as const,
          projectName: 'restored-site',
          domain: { kind: 'pages-dev' as const },
        },
      }),
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({
        state: 'connected' as const,
        account: connectedAccount,
      }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => true,
      canConnectInitialSetupApiToken: () => false,
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    await clickButton(content, '扫描内容范围');
    await clickButton(content, '继续');

    const continueButton = findSetupContinue(content);
    expect(continueButton?.attributes.disabled).toBe('true');
    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .not.toContain('将使用已连接账号：Draft account');
  });

  it('keeps the local setup draft when the wizard view is closed and reopened', async () => {
    textComponents.length = 0;
    let savedDraft: unknown;
    const application = {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => false,
      canConnectInitialSetupApiToken: () => false,
      getInitialSetupDraft: () => savedDraft,
      preserveInitialSetupDraft: (draft: unknown) => {
        savedDraft = structuredClone(draft);
      },
    };
    const first = new PagesPublishView({} as never, application as never);
    await first.onOpen();
    const firstContent = first.contentEl as unknown as ElementModel;
    await clickButton(firstContent, '继续');
    const siteName = textComponents.find((input) => input.inputEl.value === 'Test Vault');
    siteName?.trigger('Saved wizard draft');
    await first.onClose();
    textComponents.length = 0;

    const second = new PagesPublishView({} as never, application as never);
    await second.onOpen();
    const secondContent = second.contentEl as unknown as ElementModel;
    await clickButton(secondContent, '继续');

    expect(textComponents.some((input) => input.inputEl.value === 'Saved wizard draft')).toBe(true);
  });

  it('lets the user exit setup while preserving the unfinished local draft', async () => {
    const detach = vi.fn();
    const preserveInitialSetupDraft = vi.fn((_draft: unknown) => undefined);
    const view = new PagesPublishView({ detach } as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
      preserveInitialSetupDraft,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '退出设置');

    expect(preserveInitialSetupDraft.mock.calls[0]?.[0]).toMatchObject({
      config: { site: { name: 'Test Vault' } },
    });
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('lets the user exit a later setup step while preserving the unfinished local draft', async () => {
    const detach = vi.fn();
    const preserveInitialSetupDraft = vi.fn((_draft: unknown) => undefined);
    const view = new PagesPublishView({ detach } as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
      preserveInitialSetupDraft,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, '继续');
    await clickButton(content, '继续');
    expect(descendants(content, 'h3').map((heading) => heading.text)).toContain('内容范围');

    await clickButton(content, '退出设置');

    expect(preserveInitialSetupDraft.mock.calls[0]?.[0]).toMatchObject({
      config: { site: { name: 'Test Vault' } },
    });
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('preserves a Cloudflare-step draft when the user exits and reopens setup', async () => {
    textComponents.length = 0;
    let savedDraft: unknown;
    const application = {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'setup' as const,
      getInitialSetupEnvironment: () => ({
        stage: 'ready' as const,
        runtime: { source: 'obsidian' as const, version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupOAuth: () => false,
      canConnectInitialSetupApiToken: () => false,
      getInitialSetupDraft: () => savedDraft,
      preserveInitialSetupDraft: (draft: unknown) => {
        savedDraft = structuredClone(draft);
      },
      reviewInitialSetup: async () => ({ candidateCount: 1, eligibleCount: 1 }),
    };
    const first = new PagesPublishView({ detach: vi.fn() } as never, application as never);

    await first.onOpen();
    const firstContent = first.contentEl as unknown as ElementModel;
    await clickButton(firstContent, '继续');
    const siteName = textComponents.find((input) => input.inputEl.value === 'Test Vault');
    siteName?.trigger('Cloudflare draft preserved');
    await clickButton(firstContent, '继续');
    await clickButton(firstContent, '扫描内容范围');
    await clickButton(firstContent, '继续');
    expect(descendants(firstContent, 'h3').map((heading) => heading.text)).toContain('Cloudflare');
    await clickButton(firstContent, '退出设置');

    textComponents.length = 0;
    const second = new PagesPublishView({} as never, application as never);
    await second.onOpen();
    const secondContent = second.contentEl as unknown as ElementModel;
    await clickButton(secondContent, '继续');

    expect(textComponents.some((input) => input.inputEl.value === 'Cloudflare draft preserved'))
      .toBe(true);
  });

  it('coalesces overlapping global refreshes into one wizard render', async () => {
    let globalUiListener: (() => void) | undefined;
    let holdRefreshes = false;
    let releaseRefreshes: (() => void) | undefined;
    let waitingRefreshes = 0;
    const refreshBarrier = new Promise<void>((resolve) => {
      releaseRefreshes = resolve;
    });
    const getLaunchTarget = vi.fn(async () => {
      if (holdRefreshes) {
        waitingRefreshes += 1;
        await refreshBarrier;
      }
      return 'setup' as const;
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        globalUiListener = listener;
        return () => undefined;
      },
      getLaunchTarget,
      getInitialSetupEnvironment: () => ({
        stage: 'ready',
        runtime: { source: 'obsidian', version: '22.14.0' },
        engine: { version: '0.1.0' },
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      isInitialSetupAvailable: () => true,
      canConnectInitialSetupApiToken: () => false,
    } as never);

    await view.onOpen();
    holdRefreshes = true;
    globalUiListener?.();
    globalUiListener?.();
    await vi.waitFor(() => expect(waitingRefreshes).toBe(1));
    releaseRefreshes?.();

    const content = view.contentEl as unknown as ElementModel;
    await vi.waitFor(() => {
      expect(waitingRefreshes).toBe(2);
      expect(descendants(content, 'h2').filter((heading) => heading.text === '创建你的发布站点'))
        .toHaveLength(1);
      expect(findSetupContinues(content))
        .toHaveLength(1);
    });
  });

  it('does not restart a configured publish-center scan from its own global state update', async () => {
    let globalUiListener: (() => void) | undefined;
    const getPublishCenter = vi.fn(async () => {
      if (getPublishCenter.mock.calls.length === 1) globalUiListener?.();
      return {
        siteName: 'Loop-safe Wiki',
        baseline: 'first-publish' as const,
        canPublish: true,
        scanDigest: 'scan',
        output: { status: 'known' as const, fileCount: 0, assetCount: 0, assetBytes: 0 },
        summary: {
          changes: 0,
          added: 0,
          updated: 0,
          urlChanged: 0,
          visibilityChanged: 0,
          takedowns: 0,
          unknown: 0,
          blockers: 0,
          warnings: 0,
        },
        issues: [],
        articles: [],
      };
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        globalUiListener = listener;
        return () => undefined;
      },
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter,
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      canConnectInitialSetupOAuth: () => false,
    } as never);

    await view.onOpen();

    expect(getPublishCenter).toHaveBeenCalledTimes(1);
    const content = view.contentEl as unknown as ElementModel;
    expect(descendants(content, 'h2').map((heading) => heading.text))
      .toContain('Loop-safe Wiki');
    expect(descendants(content, 'h2').map((heading) => heading.text))
      .not.toContain('无法读取发布配置');
  });

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
      'col', 'col', 'col', 'col', 'col', 'col',
    ]);
    expect(descendants(table!, 'td').map((cell) => cell.attributes['data-label'])).toEqual([
      '下一版包含', '文章 / 路径', '公开方式', '状态变化', '检查', '操作',
    ]);
  });

  it('shows a publish-center loading state while the first on-demand snapshot is prepared', async () => {
    let releaseCenter!: (value: Record<string, unknown>) => void;
    const getPublishCenter = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseCenter = resolve;
    }));
    const getInitialSetupConnection = vi.fn(async () => ({ state: 'disconnected' as const }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter,
      getInitialSetupConnection,
    } as never);

    const opening = view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await vi.waitFor(() => {
      expect(descendants(content, 'h2').map((heading) => heading.text))
        .toContain('正在加载发布中心');
    });

    releaseCenter({
      siteName: 'Loading Wiki',
      baseline: 'first-publish',
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 1, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 1, added: 1, updated: 0, urlChanged: 0, visibilityChanged: 0,
        takedowns: 0, unknown: 0, blockers: 0, warnings: 0,
      },
      issues: [],
      articles: [],
    });
    await opening;
    expect(descendants(content, 'h2').map((heading) => heading.text))
      .not.toContain('正在加载发布中心');

    await clickButton(content, '检查 Cloudflare');
    expect(getInitialSetupConnection).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it('shows one in-flight site preview and prevents duplicate opens', async () => {
    let releasePreview!: () => void;
    const previewBarrier = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const openPreview = vi.fn(async () => {
      await previewBarrier;
      return { url: 'http://127.0.0.1:4173/' };
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter: async () => ({
        siteName: 'Preview Wiki',
        baseline: 'first-publish',
        canPublish: true,
        scanDigest: 'scan',
        output: { status: 'known', fileCount: 1, assetCount: 0, assetBytes: 0 },
        summary: {
          changes: 1, added: 1, updated: 0, urlChanged: 0, visibilityChanged: 0,
          takedowns: 0, unknown: 0, blockers: 0, warnings: 0,
        },
        issues: [],
        articles: [],
      }),
      getInitialSetupConnection: async () => ({ state: 'unavailable' }),
      openPreview,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const previewButton = descendants(content, 'button')
      .find((button) => button.text === '预览站点');
    expect(previewButton).toBeDefined();
    const firstOpen = previewButton?.click?.();
    const busyButton = descendants(content, 'button')
      .find((button) => button.text === '正在准备预览…');

    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('正在准备预览…');
    expect(busyButton?.attributes.disabled).toBe('true');
    const duplicateOpen = busyButton?.click?.();
    expect(openPreview).toHaveBeenCalledOnce();

    releasePreview();
    await Promise.all([firstOpen, duplicateOpen]);
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('预览站点');
  });

  it('does not start a second refresh when scan-state updates arrive during a manual rescan', async () => {
    let globalUiListener: (() => void) | undefined;
    let releaseRefresh!: () => void;
    const refreshBarrier = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const center = {
      siteName: 'Refresh Wiki',
      baseline: 'first-publish' as const,
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known' as const, fileCount: 1, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 1, added: 1, updated: 0, urlChanged: 0, visibilityChanged: 0,
        takedowns: 0, unknown: 0, blockers: 0, warnings: 0,
      },
      issues: [],
      articles: [],
    };
    let calls = 0;
    const getPublishCenter = vi.fn(async () => {
      calls += 1;
      if (calls > 1) await refreshBarrier;
      return center;
    });
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        globalUiListener = listener;
        return () => undefined;
      },
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter,
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const refresh = clickButton(content, '重新扫描');
    await vi.waitFor(() => expect(getPublishCenter).toHaveBeenCalledTimes(2));
    globalUiListener?.();
    await Promise.resolve();
    expect(getPublishCenter).toHaveBeenCalledTimes(2);

    releaseRefresh();
    await refresh;
  });

  it('opens article review as a sibling drawer and returns to the content list', async () => {
    const getPublishCenter = vi.fn(async () => ({
      siteName: 'Drawer Wiki',
      baseline: 'first-publish' as const,
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known' as const, fileCount: 1, assetCount: 0, assetBytes: 0 },
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
        sourcePath: 'notes/drawer.md',
        title: 'Drawer article',
        visibility: 'public' as const,
        nextIncluded: true,
        availability: 'ready' as const,
        change: 'added' as const,
        issues: [],
      }],
    }));
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter,
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      canConnectInitialSetupOAuth: () => false,
      getCurrentArticlePanel: async () => ({ status: 'non-markdown' }),
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await clickButton(content, 'Drawer article');

    const workspace = descendants(content, 'div')
      .find((element) => element.attributes.class?.includes('pages-publish-view__workspace'));
    const list = descendants(content, 'div')
      .find((element) => element.attributes.class === 'pages-publish-view__list');
    const drawer = descendants(content, 'aside')[0];
    expect(workspace?.attributes.class).toContain('has-review');
    expect(workspace?.children).toEqual(expect.arrayContaining([list, drawer]));
    expect(drawer?.attributes).toMatchObject({
      class: 'pages-publish-view__review',
      'aria-label': '审阅 Drawer article',
    });
    expect(descendants(drawer!, 'button').map((button) => button.text))
      .toContain('返回内容列表');
    expect(descendants(drawer!, 'button').find((button) => button.text === '返回内容列表')
      ?.attributes['data-focused']).toBe('true');

    await clickButton(content, '返回内容列表');
    expect(descendants(content, 'aside')).toHaveLength(0);
    expect(findElement(content, 'table')).toBeDefined();
    expect(descendants(content, 'button').find((button) => button.text === 'Drawer article')
      ?.attributes['data-focused']).toBe('true');
  });

  it('closes a review excluded by a tab change and focuses the chosen tab', async () => {
    const articles = reviewScopeArticles();
    const view = createReviewScopeView(articles);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    await clickButton(content, 'Clean article');
    expect(descendants(content, 'aside')).toHaveLength(1);
    await clickButton(content, '问题 1');

    expect(descendants(content, 'aside')).toHaveLength(0);
    expect(descendants(content, 'button').find((button) => button.attributes['aria-label'] === '问题 1')
      ?.attributes['data-focused']).toBe('true');
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('Blocked article');
    expect(descendants(content, 'button').map((button) => button.text))
      .not.toContain('Clean article');
  });

  it.each(['1 阻塞', '查看问题'])(
    'routes %s through the issues tab and restores focus to that tab',
    async (trigger) => {
      const view = createReviewScopeView(reviewScopeArticles());
      await view.onOpen();
      const content = view.contentEl as unknown as ElementModel;

      await clickButton(content, 'Clean article');
      await clickButton(content, trigger);

      expect(descendants(content, 'aside')).toHaveLength(0);
      expect(descendants(content, 'button').find((button) => button.attributes['aria-label'] === '问题 1')
        ?.attributes['data-focused']).toBe('true');
    },
  );

  it('closes a review excluded by search and restores focus to search', async () => {
    const view = createReviewScopeView(reviewScopeArticles());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    await clickButton(content, 'Clean article');
    const search = descendants(content, 'input')
      .find((element) => element.attributes['aria-label'] === '搜索文章或路径');
    search!.value = 'blocked';
    await search!.trigger('input');

    expect(descendants(content, 'aside')).toHaveLength(0);
    const renderedSearch = descendants(content, 'input')
      .find((element) => element.attributes['aria-label'] === '搜索文章或路径');
    expect(renderedSearch?.value).toBe('blocked');
    expect(renderedSearch?.attributes['data-focused']).toBe('true');
    expect(descendants(content, 'button').map((button) => button.text))
      .not.toContain('返回内容列表');
  });

  it('closes a review when its filter changes and focuses the filter', async () => {
    const view = createReviewScopeView(reviewScopeArticles());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    await clickButton(content, 'Clean article');
    const filter = descendants(content, 'select')
      .find((element) => element.attributes['aria-label'] === '筛选文章');
    filter!.value = 'private';
    await filter!.trigger('change');

    expect(descendants(content, 'aside')).toHaveLength(0);
    const renderedFilter = descendants(content, 'select')
      .find((element) => element.attributes['aria-label'] === '筛选文章');
    expect(renderedFilter?.value).toBe('private');
    expect(renderedFilter?.attributes['data-focused']).toBe('true');
  });

  it('filters articles by publication state and persists the filter in view state', async () => {
    const articles = [
      {
        sourcePath: 'notes/public.md',
        title: 'Public article',
        visibility: 'public' as const,
        nextIncluded: true,
        availability: 'ready' as const,
        change: 'added' as const,
        issues: [],
      },
      {
        sourcePath: 'notes/unlisted.md',
        title: 'Unlisted article',
        visibility: 'unlisted' as const,
        nextIncluded: true,
        availability: 'ready' as const,
        change: 'added' as const,
        issues: [],
      },
      {
        sourcePath: 'notes/blocked.md',
        title: 'Blocked article',
        visibility: 'private' as const,
        nextIncluded: false,
        availability: 'ready' as const,
        change: 'visibility-changed' as const,
        issues: [{ severity: 'blocker' as const, path: 'notes/blocked.md', message: 'Missing image' }],
      },
    ];
    const view = new PagesPublishView({} as never, {
      isPublicationAvailable: () => false,
      getLaunchTarget: async () => 'publish-center',
      getPublicationStatus: () => ({ state: 'idle' }),
      getPublishCenter: async () => ({
        siteName: 'Filter Wiki',
        baseline: 'first-publish',
        canPublish: false,
        scanDigest: 'scan',
        output: { status: 'known', fileCount: 2, assetCount: 0, assetBytes: 0 },
        summary: {
          changes: 3,
          added: 2,
          updated: 0,
          urlChanged: 0,
          visibilityChanged: 1,
          takedowns: 0,
          unknown: 0,
          blockers: 1,
          warnings: 0,
        },
        issues: articles[2]!.issues,
        articles,
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' }),
      canConnectInitialSetupOAuth: () => false,
    } as never);

    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const filter = descendants(content, 'select')
      .find((element) => element.attributes['aria-label'] === '筛选文章');
    expect(descendants(filter!, 'option').map((option) => option.text)).toEqual([
      '筛选：全部', '公开', '不列出', '私密', '有阻塞', '有警告',
    ]);

    filter!.value = 'unlisted';
    await filter!.trigger('change');
    const visibleTitles = descendants(content, 'button').map((button) => button.text);
    expect(visibleTitles).toContain('Unlisted article');
    expect(visibleTitles).not.toContain('Public article');
    expect(visibleTitles).not.toContain('Blocked article');
    expect(view.getState()).toMatchObject({ filter: 'unlisted' });
  });

  it('keeps secondary header actions inside one more-actions menu', async () => {
    menus.length = 0;
    const view = new PagesPublishView({} as never, {
      getPublicationStatus: () => ({ state: 'idle' }),
    } as never);
    const content = view.contentEl as unknown as ElementModel;
    const render = view as unknown as {
      renderPublishCenter(container: ElementModel, center: unknown): void;
    };

    render.renderPublishCenter(content, {
      siteName: 'Menu Wiki',
      baseline: 'first-publish',
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 0, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 0,
        added: 0,
        updated: 0,
        urlChanged: 0,
        visibilityChanged: 0,
        takedowns: 0,
        unknown: 0,
        blockers: 0,
        warnings: 0,
      },
      issues: [],
      articles: [],
    });

    const directButtons = descendants(content, 'button');
    expect(directButtons.map((button) => button.text)).not.toEqual(
      expect.arrayContaining(['打开配置文件', '打开设置']),
    );
    const more = directButtons.find((button) => button.attributes['aria-label'] === '更多操作');
    expect(more?.click).toBeTypeOf('function');
    const activationEvent = { type: 'click', clientX: 0, clientY: 0 };
    await more?.click?.(activationEvent);
    expect(menus).toHaveLength(1);
    expect(menus[0]?.shown).toBe(true);
    expect(menus[0]?.showEvent).toBe(activationEvent);
    expect(menus[0]?.items.map((item) => item.title)).toEqual(['打开配置文件', '打开设置']);
  });

  it('restores the issues tab from workspace view state', async () => {
    const view = new PagesPublishView({} as never, {
      getPublicationStatus: () => ({ state: 'idle' }),
    } as never);
    await view.setState({ tab: 'issues' }, {} as never);
    const content = view.contentEl as unknown as ElementModel;
    const render = view as unknown as {
      renderPublishCenter(container: ElementModel, center: unknown): void;
    };

    render.renderPublishCenter(content, {
      siteName: 'Issues Wiki',
      baseline: 'deployed',
      canPublish: false,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 1, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 0,
        added: 0,
        updated: 0,
        urlChanged: 0,
        visibilityChanged: 0,
        takedowns: 0,
        unknown: 0,
        blockers: 1,
        warnings: 0,
      },
      issues: [{ severity: 'blocker', path: 'notes/blocked.md', message: 'Missing image' }],
      articles: [{
        sourcePath: 'notes/blocked.md',
        title: 'Blocked article',
        visibility: 'public',
        nextIncluded: true,
        availability: 'ready',
        change: 'unchanged',
        issues: [{ severity: 'blocker', path: 'notes/blocked.md', message: 'Missing image' }],
      }],
    });

    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('Blocked article');
    expect(descendants(content, 'li').map((item) => item.text).join('\n'))
      .toContain('notes/blocked.md');
  });

  it('disables publishing before submission when the Cloudflare authorization is expired', () => {
    const beginInitialSetupOAuth = vi.fn(async () => undefined);
    const view = new PagesPublishView({} as never, {
      getPublicationStatus: () => ({ state: 'idle' }),
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth,
    } as never);
    const content = view.contentEl as unknown as ElementModel;
    const render = view as unknown as {
      renderPublishCenter(
        container: ElementModel,
        center: unknown,
        connection: unknown,
      ): void;
    };

    render.renderPublishCenter(content, {
      siteName: 'Connected Wiki',
      baseline: 'deployed',
      canPublish: true,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 1, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 1,
        added: 0,
        updated: 1,
        urlChanged: 0,
        visibilityChanged: 0,
        takedowns: 0,
        unknown: 0,
        blockers: 0,
        warnings: 0,
      },
      issues: [],
      articles: [],
    }, { state: 'expired', account: { id: 'account-1', name: 'Expired account' } });

    const publish = descendants(content, 'button')
      .find((button) => button.text === '发布站点');
    expect(publish?.attributes.disabled).toBe('true');
    expect(descendants(content, 'p').map((paragraph) => paragraph.text).join('\n'))
      .toContain('Cloudflare 授权已失效');
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('重新授权');
  });

  it('never describes an upload-uncertain recovery as a successful online publication', () => {
    const text = publicationStatusText({
      state: 'reconciliation-required',
      reconciliation: 'upload-uncertain',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'account-original',
        projectName: 'project-original',
      },
      message: 'A Cloudflare upload outcome could not be confirmed.',
    });

    expect(text).toContain('上传结果未确认');
    expect(text).toContain('project-original');
    expect(text).not.toContain('线上发布成功');
  });

  it('states that a failed publication leaves the online site unchanged', () => {
    expect(publicationStatusText({
      state: 'failed',
      stage: 'upload',
      message: 'Cloudflare request timed out.',
    })).toContain('现有线上站点保持不变');
  });
});

function reviewScopeArticles() {
  return [
    {
      sourcePath: 'notes/clean.md',
      title: 'Clean article',
      visibility: 'public' as const,
      nextIncluded: true,
      availability: 'ready' as const,
      change: 'added' as const,
      issues: [],
    },
    {
      sourcePath: 'notes/blocked.md',
      title: 'Blocked article',
      visibility: 'private' as const,
      nextIncluded: false,
      availability: 'ready' as const,
      change: 'added' as const,
      issues: [{
        severity: 'blocker' as const,
        path: 'notes/blocked.md',
        message: 'Missing image',
      }],
    },
  ];
}

function createReviewScopeView(articles: ReturnType<typeof reviewScopeArticles>): PagesPublishView {
  return new PagesPublishView({} as never, {
    isPublicationAvailable: () => false,
    getLaunchTarget: async () => 'publish-center',
    getPublicationStatus: () => ({ state: 'idle' }),
    getPublishCenter: async () => ({
      siteName: 'Review scope Wiki',
      baseline: 'first-publish',
      canPublish: false,
      scanDigest: 'scan',
      output: { status: 'known', fileCount: 2, assetCount: 0, assetBytes: 0 },
      summary: {
        changes: 2,
        added: 2,
        updated: 0,
        urlChanged: 0,
        visibilityChanged: 0,
        takedowns: 0,
        unknown: 0,
        blockers: 1,
        warnings: 0,
      },
      issues: articles[1]!.issues,
      articles,
    }),
    getInitialSetupConnection: async () => ({ state: 'disconnected' }),
    canConnectInitialSetupOAuth: () => false,
    getCurrentArticlePanel: async () => ({ status: 'non-markdown' }),
  } as never);
}

function findElement(root: ElementModel, tag: string): ElementModel | undefined {
  return descendants(root, tag)[0];
}

function descendants(root: ElementModel, tag: string): ElementModel[] {
  return root.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}

function findSetupContinue(root: ElementModel): ElementModel | undefined {
  return descendants(root, 'button')
    .find((button) => button.text.startsWith('继续：'));
}

function findSetupContinues(root: ElementModel): ElementModel[] {
  return descendants(root, 'button')
    .filter((button) => button.text.startsWith('继续：'));
}

async function clickButton(root: ElementModel, text: string): Promise<void> {
  const button = descendants(root, 'button').find((candidate) => {
    const label = candidate.attributes['aria-label'] ?? '';
    return candidate.text === text
      || label === text
      || (text === '继续' && candidate.text.startsWith('继续：'));
  });
  expect(button?.click).toBeTypeOf('function');
  await button?.click?.();
}
