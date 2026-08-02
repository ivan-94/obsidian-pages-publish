import { describe, expect, it, vi } from 'vitest';

const obsidianMock = vi.hoisted(() => {
  type Options = { cls?: string; text?: string; attr?: Record<string, string> };
  class Element {
    readonly children: Element[] = [];
    readonly attributes: Record<string, string> = {};
    readonly listeners: Record<string, (event?: unknown) => void | Promise<void>> = {};
    text = '';
    value = '';
    checked = false;
    disabled = false;
    open = false;
    click?: () => void | Promise<void>;

    constructor(readonly tag: string, options: Options = {}) {
      this.text = options.text ?? '';
      if (options.cls) this.attributes.class = options.cls;
      Object.assign(this.attributes, options.attr);
    }

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
    addClass(value: string): void { this.attributes.class = value; }
    empty(): void { this.children.length = 0; }
    setText(value: string): void { this.text = value; }
    setAttr(name: string, value: string): void { this.attributes[name] = value; }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    focus(): void { this.attributes['data-focused'] = 'true'; }
    addEventListener(
      type: string,
      listener: (event?: unknown) => void | Promise<void>,
    ): void { this.listeners[type] = listener; }
  }

  class ButtonComponent {
    readonly buttonEl = new Element('button');
    constructor(container: Element) { container.children.push(this.buttonEl); }
    setButtonText(text: string): this { this.buttonEl.text = text; return this; }
    setIcon(icon: string): this { this.buttonEl.attributes.icon = icon; return this; }
    setTooltip(text: string): this { this.buttonEl.attributes['aria-label'] = text; return this; }
    setDisabled(disabled = true): this { this.buttonEl.disabled = disabled; return this; }
    setCta(): this { this.buttonEl.attributes.cta = 'true'; return this; }
    setDestructive(): this { return this; }
    onClick(click: () => void | Promise<void>): this { this.buttonEl.click = click; return this; }
  }

  class DropdownComponent {
    readonly selectEl = new Element('select');
    constructor(container: Element) { container.children.push(this.selectEl); }
    addOption(value: string, label: string): this {
      this.selectEl.createEl('option', { text: label, attr: { value } });
      return this;
    }
    setValue(value: string): this { this.selectEl.value = value; return this; }
    setDisabled(disabled = true): this { this.selectEl.disabled = disabled; return this; }
    onChange(callback: (value: string) => void): this {
      this.selectEl.listeners.change = () => callback(this.selectEl.value);
      return this;
    }
  }

  class TextInput {
    readonly inputEl: Element;
    constructor(container: Element, tag = 'input') {
      this.inputEl = new Element(tag);
      container.children.push(this.inputEl);
    }
    setPlaceholder(value: string): this { this.inputEl.attributes.placeholder = value; return this; }
    setValue(value: string): this { this.inputEl.value = value; return this; }
    onChange(callback: (value: string) => void): this {
      this.inputEl.listeners.input = () => callback(this.inputEl.value);
      return this;
    }
  }

  class Setting {
    readonly settingEl: Element;
    readonly controlEl: Element;
    constructor(container: Element) {
      this.settingEl = container.createDiv({ cls: 'setting-item' });
      this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }
    setName(value: string): this { this.settingEl.attributes.name = value; return this; }
    setDesc(value: string): this { this.settingEl.attributes.description = value; return this; }
    addText(callback: (input: TextInput) => void): this { callback(new TextInput(this.controlEl)); return this; }
    addTextArea(callback: (input: TextInput) => void): this {
      callback(new TextInput(this.controlEl, 'textarea'));
      return this;
    }
    addButton(callback: (button: ButtonComponent) => void): this {
      callback(new ButtonComponent(this.controlEl));
      return this;
    }
    addDropdown(callback: (dropdown: DropdownComponent) => void): this {
      callback(new DropdownComponent(this.controlEl));
      return this;
    }
  }

  class ItemView {
    readonly contentEl = new Element('div');
    readonly app = {
      workspace: {
        getActiveFile: () => ({ path: 'notes/article.md' }),
        on: () => ({}),
        openLinkText: async () => undefined,
        getActiveViewOfType: () => undefined,
      },
    };
    registerEvent(): void {}
    register(): void {}
  }

  class Modal {
    readonly titleEl = new Element('div');
    readonly contentEl = new Element('div');
    constructor(_: unknown) {}
    open(): void {}
    close(): void {}
  }

  return { ButtonComponent, DropdownComponent, Element, ItemView, Modal, Setting };
});

vi.mock('obsidian', () => ({
  ButtonComponent: obsidianMock.ButtonComponent,
  DropdownComponent: obsidianMock.DropdownComponent,
  ItemView: obsidianMock.ItemView,
  MarkdownView: class {},
  Modal: obsidianMock.Modal,
  Notice: class {},
  Setting: obsidianMock.Setting,
}));

import { CurrentArticleView } from '../src/plugin/current-article-view';

type ElementModel = InstanceType<typeof obsidianMock.Element>;

describe('current article view UI specification', () => {
  it('shows effective publication properties without mounting every editor', async () => {
    const view = createView(articleState());

    await view.onOpen();

    const content = view.contentEl as unknown as ElementModel;
    expect(descendants(content, 'input')).toHaveLength(0);
    expect(descendants(content, 'textarea')).toHaveLength(0);
    expect(textsWithClass(content, 'pages-publish-article-panel__value').slice(0, 5)).toEqual([
      '标题Article title来自首个 H1',
      '摘要Article summary来自正文摘要',
      '日期2026-08-01来自文件属性',
      '标签obsidian, publish来自文件标签',
      '封面未设置默认值',
    ]);
    const advanced = descendants(content, 'details')
      .find((element) => descendants(element, 'summary')[0]?.text === '高级：类型、排序、重定向');
    expect(advanced).toBeDefined();
    expect(advanced?.open).toBe(false);
    expect(textContent(advanced!)).toContain('类型article默认值');
    expect(textContent(advanced!)).toContain('排序未设置');
    expect(textContent(advanced!)).toContain('重定向未设置');
  });

  it('opens only the requested property editor and focuses its control', async () => {
    const view = createView(articleState());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    expect(propertyAction(content, '标题')?.text).toBe('覆盖');
    expect(propertyAction(content, '摘要')?.text).toBe('覆盖');
    expect(propertyAction(content, '日期')?.text).toBe('编辑');
    expect(propertyAction(content, '标签')?.text).toBe('编辑');
    expect(propertyAction(content, '封面')?.text).toBe('选择');
    await propertyAction(content, '标题')?.click?.();

    const inputs = descendants(content, 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.attributes['aria-label']).toBe('标题显式覆盖');
    expect(inputs[0]?.attributes['data-focused']).toBe('true');
    expect(descendants(content, 'textarea')).toHaveLength(0);
    expect(descendants(content, 'button').map((button) => button.text))
      .toContain('取消编辑');
  });

  it('renders a passed checks section and preserves focus after rechecking', async () => {
    const state = articleState();
    const getCurrentArticlePanel = vi.fn(async () => state);
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: () => () => undefined,
      getCurrentArticlePanel,
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
    } as never, async () => undefined);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    const checks = allElements(content).find((element) =>
      element.attributes.class === 'pages-publish-article-panel__checks');
    expect(checks).toBeDefined();
    expect(textContent(checks!)).toContain('检查重新检查通过 · 未发现阻塞或警告');
    await descendants(checks!, 'button')
      .find((button) => button.text === '重新检查')?.click?.();

    expect(getCurrentArticlePanel).toHaveBeenCalledTimes(2);
    const renderedRecheck = descendants(content, 'button')
      .find((button) => button.text === '重新检查');
    expect(renderedRecheck?.attributes['data-focused']).toBe('true');
  });

  it('sorts blockers before warnings and gives every check an impact and location action', async () => {
    const state = articleState() as unknown as {
      contentIssues: Array<Record<string, unknown>>;
      route: {
        issues: Array<Record<string, unknown>>;
      };
    };
    state.route.issues = [{
      severity: 'warning',
      code: 'redirect-review',
      sourcePath: 'notes/article.md',
      route: '/notes/article/',
      message: '旧地址需要确认。',
    }];
    state.contentIssues = [
      {
        severity: 'warning',
        dormant: false,
        sourcePath: 'notes/article.md',
        line: 42,
        column: 3,
        message: '私密文章引用会降级。',
        impact: '发布后只保留显示文字。',
      },
      {
        severity: 'blocker',
        dormant: false,
        sourcePath: 'notes/article.md',
        line: 28,
        column: 1,
        message: '私密图片不可发布。',
        impact: '发布被阻塞。',
      },
    ];
    const view = createView(state as never);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    const checks = allElements(content).filter((element) =>
      element.attributes.class?.includes('pages-publish-article-panel__check-item'));
    expect(checks).toHaveLength(3);
    expect(textContent(checks[0]!)).toContain('阻塞 · 第 28 行');
    expect(textContent(checks[0]!)).toContain('发布被阻塞。');
    expect(textContent(checks[1]!)).toContain('警告 · 文件级路由检查');
    expect(textContent(checks[1]!)).toContain('notes/article.md');
    expect(textContent(checks[1]!)).toContain('发布会继续，但请确认 URL 与重定向结果。');
    expect(checks.every((check) => descendants(check, 'button')
      .some((button) => button.text === '定位'))).toBe(true);
  });

  it.each([
    {
      state: { status: 'no-active' },
      title: '当前没有活动文章',
      description: '打开一个 Markdown 文件以查看发布设置。',
      action: undefined,
    },
    {
      state: { status: 'non-markdown', selection: 'active', sourcePath: 'notes/file.pdf' },
      title: '此文件不是可发布的 Markdown',
      description: 'Pages Publish 只把 Markdown 作为内容候选。',
      action: undefined,
    },
    {
      state: { status: 'out-of-scope', selection: 'active', sourcePath: 'drafts/article.md' },
      title: '此文章不在内容范围内',
      description: 'drafts/article.md 尚未映射到公开路径。',
      action: '打开内容范围设置',
    },
    {
      state: {
        status: 'out-of-scope-online',
        selection: 'active',
        sourcePath: 'drafts/online.md',
        onlineUrl: '/notes/online/',
      },
      title: '此文章当前仍在线，但已移出内容范围',
      description: '下一次发布前需要确认是恢复范围还是下线。当前线上 URL：/notes/online/',
      action: '查看发布中心',
    },
    {
      state: { status: 'no-site', sourcePath: 'notes/article.md' },
      title: '尚未创建发布站点',
      description: '先完成本地站点设置，再管理当前文章的发布意图。',
      action: '开始设置',
    },
    {
      state: { status: 'config-error', sourcePath: 'notes/article.md', message: '第 18 行缩进无效。' },
      title: '站点配置无效，发布功能已暂停',
      description: '第 18 行缩进无效。',
      action: '打开并定位',
    },
    {
      state: { status: 'missing-pinned', sourcePath: 'notes/moved.md' },
      title: '固定的文章已移动或删除',
      description: '取消固定后，面板会继续跟随当前活动文件。',
      action: '取消固定',
    },
  ] as const)(
    'matches the UI-SPEC empty state: $title',
    async ({ state, title, description, action }) => {
      const view = new CurrentArticleView({} as never, {
        subscribeCurrentArticleChanges: () => () => undefined,
        getCurrentArticlePanel: async () => state,
      } as never, async () => undefined);
      await view.onOpen();
      const content = view.contentEl as unknown as ElementModel;

      expect(descendants(content, 'h3')[0]?.text).toBe(title);
      expect(descendants(content, 'p')[0]?.text).toBe(description);
      const actions = descendants(content, 'button').map((button) => button.text);
      if (action) expect(actions).toContain(action);
    },
  );

  it('keeps pending URL editing and online opening on their corresponding rows', async () => {
    const view = createView(articleState());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;

    expect(factAction(content, '待发布 URL')?.text).toBe('编辑');
    expect(factAction(content, '当前线上 URL')?.text).toBe('打开');
    await factAction(content, '待发布 URL')?.click?.();

    const inputs = descendants(content, 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.attributes['aria-label']).toBe('Slug显式覆盖');
    expect(inputs[0]?.attributes['data-focused']).toBe('true');
  });

  it('keeps the advanced section open while focusing an advanced editor', async () => {
    const view = createView(articleState());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const advanced = descendants(content, 'details')
      .find((element) => descendants(element, 'summary')[0]?.text === '高级：类型、排序、重定向');
    advanced!.open = true;

    await propertyAction(advanced!, '类型')?.click?.();

    const renderedAdvanced = descendants(content, 'details')
      .find((element) => descendants(element, 'summary')[0]?.text === '高级：类型、排序、重定向');
    expect(renderedAdvanced?.open).toBe(true);
    expect(descendants(renderedAdvanced!, 'select')[0]?.attributes['data-focused']).toBe('true');
  });

  it('preserves an unsaved property draft across external refresh and marks it for review', async () => {
    let refresh: (() => void) | undefined;
    const state = articleState();
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: (listener: () => void) => {
        refresh = listener;
        return () => undefined;
      },
      getCurrentArticlePanel: async () => state,
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
    } as never, async () => undefined);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await propertyAction(content, '标题')?.click?.();
    const input = descendants(content, 'input')[0]!;
    input.value = '未保存的新标题';
    await input.listeners.input?.();

    refresh?.();
    await vi.waitFor(() => {
      expect(descendants(content, 'input')[0]?.value).toBe('未保存的新标题');
    });

    expect(textContent(content)).toContain(
      '文件或站点配置已变化；未保存草稿已保留，请复核后保存或取消。',
    );
    expect(descendants(content, 'input')[0]?.attributes['data-focused']).toBe('true');
  });

  it('returns focus to the property action after cancelling an editor', async () => {
    const view = createView(articleState());
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await propertyAction(content, '标题')?.click?.();

    await descendants(content, 'button')
      .find((button) => button.text === '取消编辑')?.click?.();

    expect(descendants(content, 'input')).toHaveLength(0);
    expect(propertyAction(content, '标题')?.attributes['data-focused']).toBe('true');
  });

  it('returns focus to the property action after saving an override', async () => {
    const prepareArticleIntentEdit = vi.fn(async () => ({
      sourcePath: 'notes/article.md',
      patch: { title: 'Saved title' },
    }));
    const commitArticleIntentEdit = vi.fn(async () => ({}));
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: () => () => undefined,
      getCurrentArticlePanel: async () => articleState(),
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
      prepareArticleIntentEdit,
      commitArticleIntentEdit,
    } as never, async () => undefined);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await propertyAction(content, '标题')?.click?.();
    const input = descendants(content, 'input')[0]!;
    input.value = 'Saved title';
    await input.listeners.input?.();

    await descendants(content, 'button')
      .find((button) => button.text === '保存')?.click?.();

    expect(prepareArticleIntentEdit).toHaveBeenCalledWith(
      'notes/article.md',
      { title: 'Saved title' },
    );
    expect(commitArticleIntentEdit).toHaveBeenCalledOnce();
    expect(descendants(content, 'input')).toHaveLength(0);
    expect(propertyAction(content, '标题')?.attributes['data-focused']).toBe('true');
  });

  it('does not reopen or refocus an editor after switching articles', async () => {
    let refresh: (() => void) | undefined;
    let activePath = 'notes/article.md';
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: (listener: () => void) => {
        refresh = listener;
        return () => undefined;
      },
      getCurrentArticlePanel: async ({ activePath: requestedPath }: { activePath?: string }) => ({
        ...articleState(),
        sourcePath: requestedPath ?? 'notes/article.md',
      }),
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
    } as never, async () => undefined);
    const workspace = (view as unknown as {
      app: { workspace: { getActiveFile: () => { path: string } } };
    }).app.workspace;
    workspace.getActiveFile = () => ({ path: activePath });
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await propertyAction(content, '标题')?.click?.();
    const input = descendants(content, 'input')[0]!;
    input.value = 'Retained draft';
    await input.listeners.input?.();

    activePath = 'notes/other.md';
    refresh?.();
    await vi.waitFor(() => {
      expect(textContent(content)).toContain('notes/other.md');
    });
    activePath = 'notes/article.md';
    await (view as unknown as { render(): Promise<void> }).render();

    expect(descendants(content, 'input')).toHaveLength(0);
    expect(propertyAction(content, '标题')?.attributes['data-focused']).toBeUndefined();

    await propertyAction(content, '标题')?.click?.();
    expect(descendants(content, 'input')[0]?.value).toBe('Retained draft');
  });

  it('keeps a failed save draft mounted and focused for correction', async () => {
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: () => () => undefined,
      getCurrentArticlePanel: async () => articleState(),
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
      prepareArticleIntentEdit: async () => {
        throw new Error('revision conflict');
      },
    } as never, async () => undefined);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    await propertyAction(content, '标题')?.click?.();
    const input = descendants(content, 'input')[0]!;
    input.value = '冲突中的标题';
    await input.listeners.input?.();

    await descendants(content, 'button')
      .find((button) => button.text === '保存')?.click?.();

    const renderedInput = descendants(content, 'input')[0];
    expect(renderedInput?.value).toBe('冲突中的标题');
    expect(renderedInput?.attributes['data-focused']).toBe('true');
  });

  it('returns focus to visibility after committing a visibility intent', async () => {
    const view = new CurrentArticleView({} as never, {
      subscribeCurrentArticleChanges: () => () => undefined,
      getCurrentArticlePanel: async () => articleState(),
      getInitialSetupEnvironment: () => ({ stage: 'ready' }),
      prepareArticleRouteIntentEdit: async () => ({
        sourcePath: 'notes/article.md',
        patch: { visibility: 'unlisted' },
      }),
      commitArticleIntentEdit: async () => ({}),
    } as never, async () => undefined);
    await view.onOpen();
    const content = view.contentEl as unknown as ElementModel;
    const visibility = descendants(content, 'select')[0]!;
    visibility.value = 'unlisted';

    await visibility.listeners.change?.();

    expect(descendants(content, 'select')[0]?.attributes['data-focused']).toBe('true');
  });
});

function createView(state: ReturnType<typeof articleState>): CurrentArticleView {
  return new CurrentArticleView({} as never, {
    subscribeCurrentArticleChanges: () => () => undefined,
    getCurrentArticlePanel: async () => state,
    getInitialSetupEnvironment: () => ({ stage: 'ready' }),
  } as never, async () => undefined);
}

function articleState() {
  return {
    status: 'article' as const,
    selection: 'active' as const,
    sourcePath: 'notes/article.md',
    contentRootPath: 'notes',
    publicationState: 'updated' as const,
    currentSourceDigest: 'current',
    sitePublicationFailed: false,
    dependencies: { images: 0, notes: 0, externalLinks: 0 },
    contentIssues: [],
    route: { pendingUrl: '/notes/article/', onlineUrl: '/notes/article/', redirects: [], issues: [] },
    metadata: {
      visibility: { value: 'public' as const, source: 'publication.visibility' },
      slug: { value: 'article', source: 'default' },
      redirects: { value: [], source: 'default' },
      title: { value: 'Article title', source: 'first-h1' },
      summary: { value: 'Article summary', source: 'body-summary' },
      date: { value: '2026-08-01', source: 'frontmatter.date' },
      updated: { value: '2026-08-01', source: 'default' },
      tags: { value: ['obsidian', 'publish'], source: 'frontmatter.tags' },
      cover: { value: '未设置', source: 'default' },
      kind: { value: 'article' as const, source: 'default' },
      order: undefined,
      deployment: {
        url: '/notes/article/',
        firstPublishedAt: '2026-07-31T10:00:00.000Z',
        lastPublishedAt: '2026-08-01T10:00:00.000Z',
        sourceDigest: 'deployed',
        deploymentId: 'deployment-1',
      },
    },
  };
}

function descendants(root: ElementModel, tag: string): ElementModel[] {
  return root.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}

function textContent(root: ElementModel): string {
  return `${root.text}${root.children.map(textContent).join('')}`;
}

function textsWithClass(root: ElementModel, className: string): string[] {
  return allElements(root)
    .filter((element) => element.attributes.class === className)
    .map(textContentWithoutButtons);
}

function textContentWithoutButtons(root: ElementModel): string {
  if (root.tag === 'button') return '';
  return `${root.text}${root.children.map(textContentWithoutButtons).join('')}`;
}

function propertyAction(root: ElementModel, label: string): ElementModel | undefined {
  const row = allElements(root).find((element) =>
    element.attributes.class === 'pages-publish-article-panel__value'
      && element.children.some((child) => child.tag === 'span' && child.text === label),
  );
  return row && descendants(row, 'button')[0];
}

function factAction(root: ElementModel, label: string): ElementModel | undefined {
  const row = allElements(root).find((element) =>
    element.attributes.class === 'pages-publish-article-panel__fact'
      && element.children.some((child) => child.tag === 'span' && child.text === label),
  );
  return row && descendants(row, 'button')[0];
}

function allElements(root: ElementModel): ElementModel[] {
  return root.children.flatMap((child) => [child, ...allElements(child)]);
}
