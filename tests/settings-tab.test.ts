import { describe, expect, it, vi } from 'vitest';

const mockedObsidian = vi.hoisted(() => {
  type ClickHandler = () => void | Promise<void>;
  class ElementModel {
    readonly children: ElementModel[] = [];
    text = '';

    createEl(_: string, input: { text?: string } = {}): ElementModel {
      const element = new ElementModel();
      element.text = input.text ?? '';
      this.children.push(element);
      return element;
    }

    createDiv(): ElementModel {
      const element = new ElementModel();
      this.children.push(element);
      return element;
    }

    empty(): void {}
    addClass(): void {}
    setText(text: string): void { this.text = text; }
  }
  const buttons: ButtonComponent[] = [];
  const descriptions: string[] = [];
  const notices: string[] = [];
  class ButtonComponent {
    text = '';
    disabled = false;
    tooltip = '';
    private click: ClickHandler | undefined;

    constructor(_: ElementModel) {
      buttons.push(this);
    }

    setButtonText(text: string): this {
      this.text = text;
      return this;
    }

    setCta(): this { return this; }
    setDestructive(): this { return this; }
    setTooltip(text: string): this { this.tooltip = text; return this; }
    setDisabled(disabled: boolean): this {
      this.disabled = disabled;
      return this;
    }
    onClick(click: ClickHandler): this {
      this.click = click;
      return this;
    }
    async trigger(): Promise<void> {
      await this.click?.();
    }
  }
  class Setting {
    constructor(private readonly container: ElementModel) {}
    setName(): this { return this; }
    setHeading(): this { return this; }
    setDesc(value: string): this { descriptions.push(value); return this; }
    addText(callback: (input: {
      inputEl: { type: string; value: string };
      setPlaceholder(): { onChange(): void };
    }) => void): this {
      callback({
        inputEl: { type: '', value: '' },
        setPlaceholder: () => ({ onChange: () => undefined }),
      });
      return this;
    }
    addButton(callback: (button: ButtonComponent) => void): this {
      callback(new ButtonComponent(this.container));
      return this;
    }
  }
  return { ElementModel, ButtonComponent, Setting, buttons, descriptions, notices };
});

vi.mock('obsidian', () => ({
  ButtonComponent: mockedObsidian.ButtonComponent,
  ItemView: class {},
  Notice: class {
    constructor(message: string) { mockedObsidian.notices.push(message); }
  },
  Plugin: class {},
  PluginSettingTab: class {
    constructor(readonly app: unknown, _: unknown) {}
    update(): void {}
  },
  Setting: mockedObsidian.Setting,
  TFile: class {},
}));

import {
  PagesPublishSettingTab,
  readLocalThemeSelection,
  trashHiddenSiteConfig,
  reloadSettingsDraft,
  settingsHeaderStatusText,
  settingsRemoteActionStatusText,
  settingsRemoteActionAvailability,
} from '../src/plugin/settings-tab';
import { openSiteConfigForRepair } from '../src/plugin/site-config-repair-view';

describe('settings custom-domain status check', () => {
  it('reads a pathless Obsidian file selection as bounded theme archive bytes', async () => {
    const archive = Uint8Array.of(31, 139, 8, 0);

    await expect(readLocalThemeSelection({
      name: 'brutalist.tgz',
      size: archive.byteLength,
      arrayBuffer: async () => Uint8Array.from(archive).buffer,
    })).resolves.toEqual({
      fileName: 'brutalist.tgz',
      archive,
    });
  });

  it('opens the site configuration from a settings read-failure recovery action', async () => {
    const leaf = { setViewState: vi.fn(async () => undefined) };
    const revealLeaf = vi.fn(async () => undefined);

    await openSiteConfigForRepair({ workspace: { getLeaf: () => leaf as never, revealLeaf } });

    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: 'pages-publish-config-repair', active: true,
    });
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it('moves hidden configuration to the system trash and falls back to the local trash', async () => {
    const trashSystem = vi.fn(async () => false);
    const trashLocal = vi.fn(async () => undefined);
    await trashHiddenSiteConfig({ trashSystem, trashLocal });
    expect(trashSystem).toHaveBeenCalledWith('.publish/site.yml');
    expect(trashLocal).toHaveBeenCalledWith('.publish/site.yml');
  });

  it('keeps the visible draft and reports a recoverable error when discarding changes cannot reload the config', async () => {
    const draft = { status: 'dirty' as const, draft: { site: { name: '保留草稿' } } };
    const result = await reloadSettingsDraft({
      getState: () => draft,
      reloadExternal: async () => { throw new Error('site.yml is unreadable'); },
    });

    expect(result).toEqual({ state: draft, error: 'site.yml is unreadable' });
  });

  it('projects honest header and remote-action status copy', () => {
    expect(settingsHeaderStatusText('clean')).toBe(
      '配置有效 · .publish/site.yml 是唯一站点配置来源',
    );
    expect(settingsHeaderStatusText('dirty')).toBe(
      '有未保存的本地设置 · .publish/site.yml 仍是当前生效来源',
    );
    expect(settingsHeaderStatusText('conflict')).toBe(
      '.publish/site.yml 已在外部修改 · 本页草稿不会被直接覆盖',
    );
    expect(settingsRemoteActionStatusText('dirty')).toBe(
      '请先保存或放弃本地设置更改；Cloudflare 账号、项目和域名动作已禁用。',
    );
    expect(settingsRemoteActionStatusText('conflict')).toBe(
      '请先解决配置文件外部修改冲突；Cloudflare 账号、项目和域名动作已禁用。',
    );
  });

  it('blocks independent remote actions while local settings are unsaved', () => {
    expect(settingsRemoteActionAvailability('clean')).toEqual({ enabled: true });
    expect(settingsRemoteActionAvailability('dirty')).toEqual({
      enabled: false,
      reason: '请先保存或放弃本地设置更改',
    });
    expect(settingsRemoteActionAvailability('conflict')).toEqual({
      enabled: false,
      reason: '请先解决配置文件外部修改冲突',
    });
  });

  it('disables already-mounted remote action buttons as soon as the draft becomes dirty', () => {
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      {} as never,
    );
    const projectButton = new mockedObsidian.ButtonComponent(
      new mockedObsidian.ElementModel(),
    );
    const domainButton = new mockedObsidian.ButtonComponent(
      new mockedObsidian.ElementModel(),
    );
    const controls = tab as unknown as {
      session: { update(change: () => void): { status: 'dirty' } };
      headerStatusText: InstanceType<typeof mockedObsidian.ElementModel>;
      localSaveDescription: InstanceType<typeof mockedObsidian.ElementModel>;
      remoteActionStatus: InstanceType<typeof mockedObsidian.ElementModel>;
      remoteActionButtons: InstanceType<typeof mockedObsidian.ButtonComponent>[];
      updateDraft(change: () => void): void;
    };
    controls.session = { update: () => ({ status: 'dirty' }) };
    controls.headerStatusText = new mockedObsidian.ElementModel();
    controls.localSaveDescription = new mockedObsidian.ElementModel();
    controls.remoteActionStatus = new mockedObsidian.ElementModel();
    controls.remoteActionButtons = [projectButton, domainButton];

    controls.updateDraft(() => undefined);

    expect(projectButton.disabled).toBe(true);
    expect(domainButton.disabled).toBe(true);
    expect(projectButton.tooltip).toBe('');
    expect(domainButton.tooltip).toBe('');
    expect(controls.localSaveDescription.text).toBe(
      '有未保存的设置。保存后将重新扫描，但不会自动发布。',
    );
    expect(controls.remoteActionStatus.text).toBe(
      '请先保存或放弃本地设置更改；Cloudflare 账号、项目和域名动作已禁用。',
    );
    expect(controls.headerStatusText.text).toBe(
      '有未保存的本地设置 · .publish/site.yml 仍是当前生效来源',
    );
  });
  it('keeps Cloudflare OAuth as the primary connection action when configured', async () => {
    mockedObsidian.buttons.length = 0;
    mockedObsidian.descriptions.length = 0;
    const beginInitialSetupOAuth = vi.fn(async () => undefined);
    const application = {
      canConnectInitialSetupApiToken: () => true,
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth,
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: async () => ({ state: 'not-configured' as const }),
      canSelectInitialSetupAccount: () => false,
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
    };

    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const login = mockedObsidian.buttons.find(
      (button) => button.text === '使用 Cloudflare 登录',
    );
    expect(login).toBeDefined();
    expect(mockedObsidian.descriptions).toContain(
      '推荐方式；将在浏览器打开授权页面，凭据保存在 Obsidian 安全存储（当前 Vault 的本地存储）。',
    );
    expect(mockedObsidian.descriptions.join('\n')).not.toContain('macOS Keychain');
    await login?.trigger();
    expect(beginInitialSetupOAuth).toHaveBeenCalledOnce();
  });

  it('restores the OAuth action after a callback result while the local draft is clean', async () => {
    mockedObsidian.buttons.length = 0;
    let notifyGlobalUiState: (() => void) | undefined;
    const application = {
      canConnectInitialSetupApiToken: () => false,
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth: vi.fn(async () => undefined),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: async () => ({ state: 'not-configured' as const }),
      canSelectInitialSetupAccount: () => false,
      subscribeGlobalUiState: (listener: () => void) => {
        notifyGlobalUiState = listener;
        return () => undefined;
      },
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      session: { getState(): { status: 'clean' } };
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
    };
    controls.session = { getState: () => ({ status: 'clean' }) };
    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const login = mockedObsidian.buttons.find(
      (button) => button.text === '使用 Cloudflare 登录',
    );

    await login?.trigger();
    expect(login?.disabled).toBe(true);
    notifyGlobalUiState?.();

    expect(login?.disabled).toBe(false);
  });

  it('fails closed for OAuth after local settings become dirty', async () => {
    mockedObsidian.buttons.length = 0;
    const beginInitialSetupOAuth = vi.fn(async () => undefined);
    const application = {
      canConnectInitialSetupApiToken: () => true,
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth,
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: async () => ({ state: 'not-configured' as const }),
      canSelectInitialSetupAccount: () => false,
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      session: { getState(): { status: 'dirty' } };
      remoteActionButtons: InstanceType<typeof mockedObsidian.ButtonComponent>[];
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
    };
    controls.session = { getState: () => ({ status: 'dirty' }) };

    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const login = mockedObsidian.buttons.find(
      (button) => button.text === '使用 Cloudflare 登录',
    );
    expect(login?.disabled).toBe(true);
    expect(controls.remoteActionButtons).toContain(login);

    await login?.trigger();
    expect(beginInitialSetupOAuth).not.toHaveBeenCalled();
  });

  it('keeps OAuth disabled when a clean-started request fails after the draft becomes dirty', async () => {
    mockedObsidian.buttons.length = 0;
    let rejectOAuth!: (error: Error) => void;
    let status: 'clean' | 'dirty' = 'clean';
    const application = {
      canConnectInitialSetupApiToken: () => false,
      canConnectInitialSetupOAuth: () => true,
      beginInitialSetupOAuth: () => new Promise<void>((_resolve, reject) => {
        rejectOAuth = reject;
      }),
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: async () => ({ state: 'not-configured' as const }),
      canSelectInitialSetupAccount: () => false,
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      session: { getState(): { status: 'clean' | 'dirty' } };
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
    };
    controls.session = { getState: () => ({ status }) };
    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const login = mockedObsidian.buttons.find(
      (button) => button.text === '使用 Cloudflare 登录',
    );
    const running = login?.trigger();

    status = 'dirty';
    rejectOAuth(new Error('authorization window closed'));
    await running;

    expect(login?.disabled).toBe(true);
  });

  it('preserves the current editor session when a remote config write completes', async () => {
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      {} as never,
    );
    const conflicted = {
      status: 'conflict' as const,
      canSave: false,
      draft: { site: { name: 'Retained draft' } },
      revision: 'before-remote-write',
      comparison: {
        currentSource: 'remote-written config',
        draft: { site: { name: 'Retained draft' } },
      },
    };
    const session = {
      detectExternalChange: vi.fn(async () => conflicted),
    };
    const controls = tab as unknown as {
      session: typeof session;
      editorState: typeof conflicted | undefined;
      reconcileRemoteConfigChange(): Promise<void>;
    };
    controls.session = session;

    await controls.reconcileRemoteConfigChange();

    expect(controls.session).toBe(session);
    expect(session.detectExternalChange).toHaveBeenCalledOnce();
    expect(controls.editorState).toBe(conflicted);
  });

  it('reports remote success honestly when the local settings refresh fails', async () => {
    mockedObsidian.notices.length = 0;
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      {} as never,
    );
    const controls = tab as unknown as {
      session: { detectExternalChange(): Promise<never> };
      reconcileRemoteConfigChangeAfterSuccess(message: string): Promise<boolean>;
    };
    controls.session = {
      detectExternalChange: async () => {
        throw new Error('disk temporarily unavailable');
      },
    };

    await expect(controls.reconcileRemoteConfigChangeAfterSuccess(
      'Pages 项目已绑定：docs',
    )).resolves.toBe(false);

    expect(mockedObsidian.notices).toContain(
      'Pages 项目已绑定：docs，但无法刷新本地设置状态：disk temporarily unavailable。请重新打开设置后核对当前配置。',
    );
  });

  it('disables account choices created after the local draft becomes dirty', async () => {
    mockedObsidian.buttons.length = 0;
    let resolveAccounts!: (accounts: Array<{ id: string; name: string }>) => void;
    let status: 'clean' | 'dirty' = 'clean';
    const application = {
      canConnectInitialSetupApiToken: () => false,
      canConnectInitialSetupOAuth: () => true,
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: async () => ({ state: 'not-configured' as const }),
      canSelectInitialSetupAccount: () => true,
      listInitialSetupAccounts: () => new Promise<Array<{ id: string; name: string }>>(
        (resolve) => { resolveAccounts = resolve; },
      ),
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      session: { getState(): { status: 'clean' | 'dirty' } };
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
    };
    controls.session = { getState: () => ({ status }) };
    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const choose = mockedObsidian.buttons.find(
      (button) => button.text === '选择发布账号',
    );
    const loading = choose?.trigger();

    status = 'dirty';
    resolveAccounts([{ id: 'account-1', name: 'Ivan Personal' }]);
    await loading;

    const account = mockedObsidian.buttons.find(
      (button) => button.text === 'Ivan Personal',
    );
    expect(account?.disabled).toBe(true);
    expect(account?.tooltip).toBe('');
  });

  it('re-enables the mounted check button when a configuration edit invalidates an in-flight result', async () => {
    mockedObsidian.buttons.length = 0;
    let resolveInspection!: (value: {
      state: 'pending';
      hostname: string;
    }) => void;
    const application = {
      canConnectInitialSetupApiToken: () => true,
      canConnectInitialSetupOAuth: () => false,
      getInitialSetupConnection: async () => ({ state: 'disconnected' as const }),
      inspectConfiguredCustomDomain: () => new Promise((resolve) => {
        resolveInspection = resolve;
      }),
      canSelectInitialSetupAccount: () => false,
    };
    const tab = new PagesPublishSettingTab(
      { app: {} } as never,
      '/vault',
      application as never,
    );
    const controls = tab as unknown as {
      session: {
        getState(): { status: 'clean' };
        update(change: () => void): unknown;
      };
      renderCloudflareConnection(container: InstanceType<typeof mockedObsidian.ElementModel>): void;
      updateDraft(change: () => void): void;
    };
    controls.session = {
      getState: () => ({ status: 'clean' }),
      update: () => ({}),
    };
    controls.renderCloudflareConnection(new mockedObsidian.ElementModel());
    const check = mockedObsidian.buttons.find((button) => button.text === '检查状态');
    if (!check) throw new Error('Expected custom-domain status button.');

    const running = check.trigger();
    expect(check.disabled).toBe(true);
    controls.updateDraft(() => undefined);
    resolveInspection({ state: 'pending', hostname: 'docs.example.com' });
    await running;

    expect(check).toMatchObject({ text: '检查状态', disabled: false });
  });
});
