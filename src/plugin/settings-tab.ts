import {
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type DataAdapter,
  type SettingDefinitionItem,
} from 'obsidian';
import type {
  ConfiguredCustomDomainStatus,
  PagesPublishApplication,
} from '../application';
import { LatestAsyncValue } from './latest-async-value';
import {
  SiteConfigEditorSession,
  SiteSettingsService,
  type SiteConfigEditorState,
  type SiteTakedownImpact,
  type SiteUrlChange,
} from '../config/site-settings';
import {
  loadSiteConfigFromDirectory,
  validateSiteConfigForDirectory,
} from '../config/site-config';
import { siteCanonicalOrigin } from '../site/discovery';
import { openSiteConfigForRepair } from './site-config-repair-view';
import type {
  ThemeCandidate,
  ThemeManagementService,
  ThemePanelState,
} from '../theme/theme-management';
import type { ThemeOptionSchema } from '../theme/theme-options-schema';
import type { JsonValue, SiteThemeReference } from '../theme/theme-contract';

const PAGES_PUBLISH_VIEW_TYPE = 'pages-publish-center';

export async function trashHiddenSiteConfig(adapter: Pick<DataAdapter, 'trashSystem' | 'trashLocal'>): Promise<void> {
  if (!(await adapter.trashSystem('.publish/site.yml'))) await adapter.trashLocal('.publish/site.yml');
}

export class PagesPublishSettingTab extends PluginSettingTab {
  private session?: SiteConfigEditorSession;
  private editorState?: SiteConfigEditorState;
  private pendingUrlChanges?: SiteUrlChange[];
  private pendingRootRemoval?: {
    index: number;
    path: string;
    takedowns: SiteTakedownImpact[];
  };
  private diagnosticReview = false;
  private siteConfigRemovalReview = false;
  private customDomainStatus: ConfiguredCustomDomainStatus | undefined;
  private readonly customDomainStatusRequest = new LatestAsyncValue<ConfiguredCustomDomainStatus>();
  private remoteActionButtons: ButtonComponent[] = [];
  private headerStatusText: HTMLElement | undefined;
  private localSaveDescription: HTMLElement | undefined;
  private remoteActionStatus: HTMLElement | undefined;
  private sectionObserver: IntersectionObserver | undefined;
  private rendering = 0;
  private pendingOAuthButton: ButtonComponent | undefined;
  private unsubscribeGlobalUiState: (() => void) | undefined;
  private themePanelState: ThemePanelState | undefined;
  private themePanelKey: string | undefined;
  private themePanelLoadingKey: string | undefined;
  private pendingThemeCandidate: ThemeCandidate | undefined;
  private themeOperation: { label: string; controller: AbortController } | undefined;

  constructor(
    plugin: Plugin,
    private readonly vaultRoot: string,
    private readonly application: PagesPublishApplication,
    private readonly themeManagement?: ThemeManagementService,
  ) {
    super(plugin.app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: '站点发布设置',
        desc: '站点、内容范围、Cloudflare、站点功能和本地配置',
        aliases: ['Pages Publish', 'site.yml'],
        render: (setting) => {
          const rendering = ++this.rendering;
          const container = setting.settingEl;
          container.empty();
          container.addClass('pages-publish-settings');
          void this.render(container, rendering);
          return () => {
            if (rendering === this.rendering) this.rendering += 1;
          };
        },
      },
    ];
  }

  hide(): void {
    this.sectionObserver?.disconnect();
    this.sectionObserver = undefined;
    this.unsubscribeGlobalUiState?.();
    this.unsubscribeGlobalUiState = undefined;
    this.session = undefined;
    this.editorState = undefined;
    this.pendingUrlChanges = undefined;
    this.pendingRootRemoval = undefined;
    this.diagnosticReview = false;
    this.siteConfigRemovalReview = false;
    this.remoteActionButtons = [];
    this.headerStatusText = undefined;
    this.localSaveDescription = undefined;
    this.remoteActionStatus = undefined;
    this.pendingOAuthButton = undefined;
    this.themeOperation?.controller.abort();
    this.themeOperation = undefined;
    this.themePanelState = undefined;
    this.themePanelKey = undefined;
    this.themePanelLoadingKey = undefined;
    this.pendingThemeCandidate = undefined;
    this.resetCustomDomainStatus();
    this.rendering += 1;
  }

  async notifyConfigFileChanged(): Promise<void> {
    if (!this.session) return;
    this.resetCustomDomainStatus();
    this.themePanelKey = undefined;
    this.themePanelState = undefined;
    try {
      this.editorState = await this.session.detectExternalChange();
      this.update();
    } catch {
      this.editorState = this.session.getState();
      this.update();
    }
  }

  private async render(container: HTMLElement, rendering: number): Promise<void> {
    if (this.session) {
      const state = this.editorState ?? this.session.getState();
      this.editorState = state;
      this.renderEditor(container, state);
      return;
    }

    let loaded;
    try {
      loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
    } catch (error) {
      if (rendering !== this.rendering) return;
      container.createEl('p', {
        cls: 'pages-publish-view__error',
        text: isMissingFile(error)
          ? '尚未创建站点配置。请从 Ribbon 打开首次设置。'
          : `无法读取站点配置：${errorMessage(error)}`,
      });
      if (!isMissingFile(error)) {
        new ButtonComponent(container)
          .setButtonText('打开并定位配置')
          .onClick(() => openSiteConfigForRepair({ workspace: this.app.workspace }));
      }
      return;
    }
    if (rendering !== this.rendering) return;

    if (loaded.status === 'future-version') {
      container.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: `配置版本 ${loaded.version} 高于当前支持范围。当前仅可查看，不能保存或发布。`,
      });
      container.createEl('pre', { text: loaded.source });
      return;
    }

    if (!this.session) {
      this.session = await SiteConfigEditorSession.open(this.vaultRoot);
      this.editorState = this.session.getState();
    }
    if (rendering !== this.rendering || !this.session) return;
    const state = this.editorState ?? this.session.getState();
    this.editorState = state;
    this.renderEditor(container, state);
  }

  private renderEditor(container: HTMLElement, state: SiteConfigEditorState): void {
    this.sectionObserver?.disconnect();
    this.sectionObserver = undefined;
    this.remoteActionButtons = [];
    this.headerStatusText = undefined;
    this.localSaveDescription = undefined;
    this.remoteActionStatus = undefined;
    const draft = state.draft;
    const document = container.createDiv({ cls: 'pages-publish-settings__document' });
    const hero = document.createEl('header', { cls: 'pages-publish-settings__hero' });
    hero.createDiv({ cls: 'pages-publish-settings__title', text: 'Pages Publish' });
    const identity = hero.createDiv({ cls: 'pages-publish-settings__site-identity' });
    identity.createEl('strong', { text: draft.site.name });
    identity.createSpan({ text: siteCanonicalOrigin(draft) });
    const headerStatus = hero.createDiv({ cls: 'pages-publish-settings__header-status' });
    this.headerStatusText = headerStatus.createSpan({
      text: settingsHeaderStatusText(state.status),
    });
    new ButtonComponent(headerStatus).setIcon('file-code-2').setButtonText('打开配置文件').onClick(() =>
      openSiteConfigForRepair({ workspace: this.app.workspace }),
    );
    new ButtonComponent(headerStatus).setIcon('cloud-upload').setButtonText('打开发布中心').onClick(() =>
      this.openPublishCenter(),
    );
    const sections = new Map<string, HTMLElement>();
    const sectionAnchors = new Map<string, HTMLButtonElement>();
    const setActiveAnchor = (activeId: string): void => {
      for (const [id, anchorButton] of sectionAnchors) {
        anchorButton.toggleClass('is-active', id === activeId);
      }
    };
    const anchors = document.createEl('nav', {
      cls: 'pages-publish-settings__anchors',
      attr: { 'aria-label': '设置分区' },
    });
    for (const [id, label, icon] of [
      ['site', '站点', 'home'],
      ['content', '内容范围', 'folder'],
      ['cloudflare', 'Cloudflare', 'cloud'],
      ['features', '站点功能', 'layout-grid'],
      ['theme', '站点主题', 'palette'],
      ['environment', '本地环境', 'monitor'],
    ] as const) {
      const button = new ButtonComponent(anchors).setIcon(icon).setTooltip(label);
      button.buttonEl.createSpan({ text: label });
      button.buttonEl.setAttr('aria-label', label);
      button.buttonEl.toggleClass('is-active', id === 'site');
      sectionAnchors.set(id, button.buttonEl);
      button.onClick(() => {
        setActiveAnchor(id);
        sections.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    container = document.createEl('main', { cls: 'pages-publish-settings__body' });

    if (state.status === 'conflict' && state.comparison) {
      const warning = container.createDiv({ cls: 'pages-publish-view__warning' });
      warning.createEl('p', {
        text: '.publish/site.yml 已在外部修改。当前草稿不会被静默覆盖。',
      });
      const actions = warning.createDiv({ cls: 'pages-publish-settings__conflict-actions' });
      new Setting(actions)
        .addButton((button) =>
          button.setButtonText('重新载入').onClick(async () => {
            if (!this.session) return;
            try {
              this.editorState = await this.session.reloadExternal();
              this.update();
            } catch (error) {
              new Notice(`无法重新载入配置：${errorMessage(error)}`);
            }
          }),
        );
      const comparison = warning.createEl('details');
      comparison.createEl('summary', { text: '查看差异' });
      comparison.createEl('strong', { text: '外部版本' });
      comparison.createEl('pre', { text: state.comparison.currentSource });
      comparison.createEl('strong', { text: '本页草稿' });
      comparison.createEl('pre', {
        text: JSON.stringify(state.comparison.draft, undefined, 2),
      });
    }

    const siteSection = new Setting(container).setName('站点').setHeading();
    sections.set('site', siteSection.settingEl);
    let descriptionCount: HTMLElement | undefined;
    new Setting(container)
      .setName('站点名称')
      .setDesc('支持中文与其他文字；不会自动决定域名。')
      .addText((text) =>
        text.setValue(draft.site.name).onChange((value) => {
          this.updateDraft((current) => {
            current.site.name = value;
          });
        }),
      );
    new Setting(container)
      .setName('站点简介')
      .setDesc('最多 160 个用户可见字符。')
      .addTextArea((text) =>
        text.setValue(draft.site.description ?? '').onChange((value) => {
          descriptionCount?.setText(`${visibleCharacterCount(value)} / 160`);
          this.updateDraft((current) => {
            current.site.description = value || undefined;
          });
        }),
      );
    descriptionCount = container.createSpan({
      cls: 'pages-publish-view__character-count',
      text: `${visibleCharacterCount(draft.site.description ?? '')} / 160`,
    });
    new Setting(container)
      .setName('时区')
      .setDesc('用于固化站点日期语义的时区标识。')
      .addText((text) =>
        text.setValue(draft.site.timezone ?? '').onChange((value) => {
          this.updateDraft((current) => {
            current.site.timezone = value || undefined;
          });
        }),
      );

    const contentSection = new Setting(container).setName('内容范围').setHeading();
    sections.set('content', contentSection.settingEl);
    for (let index = 0; index < draft.contentRoots.length; index += 1) {
      const root = draft.contentRoots[index];
      if (!root) continue;
      new Setting(container)
        .setName(`内容目录 ${index + 1}`)
        .setDesc('Vault 相对目录 → 站点公开路径')
        .addText((text) =>
          text.setPlaceholder('Notes').setValue(root.path).onChange((value) => {
            this.updateDraft((current) => {
              const target = current.contentRoots[index];
              if (target) target.path = value;
            });
          }),
        )
        .addText((text) =>
          text
            .setPlaceholder('/notes')
            .setValue(root.publicRoot)
            .onChange((value) => {
              this.updateDraft((current) => {
                const target = current.contentRoots[index];
                if (target) target.publicRoot = value;
              });
            }),
        )
        .addButton((button) =>
          button
            .setIcon('x')
            .setTooltip('移除内容目录')
            .setDestructive()
            .setDisabled(draft.contentRoots.length === 1)
            .onClick(async () => {
              const proposed = structuredClone(draft);
              proposed.contentRoots.splice(index, 1);
              try {
                const service = new SiteSettingsService(this.vaultRoot);
                this.pendingRootRemoval = {
                  index,
                  path: root.path,
                  takedowns: await service.previewTakedowns(proposed),
                };
                this.update();
              } catch (error) {
                new Notice(`无法评估移除内容目录的影响：${errorMessage(error)}`);
              }
            }),
        );
    }
    if (this.pendingRootRemoval) {
      const pending = this.pendingRootRemoval;
      const review = container.createDiv({ cls: 'pages-publish-view__warning' });
      review.createEl('p', {
        text: `移除 ${pending.path}？${pending.takedowns.length} 篇已上线内容将在下一次发布时下线；本地文件不会删除。`,
      });
      const actions = new Setting(review);
      actions.addButton((button) => button.setButtonText('取消').onClick(() => {
        this.pendingRootRemoval = undefined;
        this.update();
      }));
      actions.addButton((button) => button
        .setButtonText('移除并标记待下线')
        .setDestructive()
        .onClick(() => {
          const currentPending = this.pendingRootRemoval;
          if (!currentPending) return;
          this.pendingRootRemoval = undefined;
          this.updateDraft((current) => {
            const target = current.contentRoots[currentPending.index];
            if (target?.path === currentPending.path) {
              current.contentRoots.splice(currentPending.index, 1);
            }
          });
          this.update();
        }));
    }
    new Setting(container).addButton((button) =>
      button.setButtonText('添加内容目录').onClick(() => {
        this.updateDraft((current) => {
          current.contentRoots.push({ path: '', publicRoot: '/' });
        });
        this.update();
      }),
    );
    new Setting(container)
      .setName('资源排除')
      .setDesc('每行一个明确禁止公开的仓库相对资源匹配模式。')
      .addTextArea((text) =>
        text.setValue(draft.assets.exclude.join('\n')).onChange((value) => {
          this.updateDraft((current) => {
            current.assets.exclude = value
              .split('\n')
              .map((entry) => entry.trim())
              .filter(Boolean);
          });
        }),
      );

    const cloudflareSection = new Setting(container).setName('Cloudflare').setHeading();
    sections.set('cloudflare', cloudflareSection.settingEl);
    const remoteActionAvailability = settingsRemoteActionAvailability(state.status);
    this.remoteActionStatus = container.createEl('p', {
      cls: 'pages-publish-settings__remote-status',
      text: settingsRemoteActionStatusText(state.status),
    });
    this.renderCloudflareConnection(container, remoteActionAvailability);
    let projectBindingPlan = draft.cloudflare.projectName;
    new Setting(container)
      .setName('绑定 Pages 项目')
      .setDesc(`当前项目：${draft.cloudflare.projectName}。此远端动作会先验证当前账号归属与兼容性；普通“保存设置”不会重绑。${remoteActionAvailability.enabled ? '' : ` ${remoteActionAvailability.reason}。`}`)
      .addText((text) => text
        .setValue(projectBindingPlan)
        .onChange((value) => {
          projectBindingPlan = value;
        }))
      .addButton((button) => {
        this.remoteActionButtons.push(button);
        button.setButtonText('验证并绑定')
          .setDisabled(!remoteActionAvailability.enabled).onClick(async () => {
            if (!this.ensureRemoteActionAvailable()) return;
            button.setDisabled(true).setButtonText('验证中…');
            try {
              const project = await this.application.bindConfiguredProject(
                projectBindingPlan.trim(),
              );
              if (!(await this.reconcileRemoteConfigChangeAfterSuccess(
                `Pages 项目已绑定：${project.name}`,
              ))) return;
              this.resetCustomDomainStatus();
              new Notice(`已绑定 Pages 项目：${project.name}。没有执行发布。`);
              this.update();
            } catch (error) {
              new Notice(`无法绑定 Pages 项目；现有绑定保持不变：${errorMessage(error)}`);
              this.restoreRemoteActionButton(button, '验证并绑定');
            }
          });
      });
    let customDomainPlan = draft.cloudflare.customDomain ?? '';
    new Setting(container)
      .setName('连接自定义域名')
      .setDesc(`当前域名：${draft.cloudflare.customDomain ?? '未配置'}。此远端动作可能进入 DNS 待验证状态；普通“保存设置”不会连接域名。${remoteActionAvailability.enabled ? '' : ` ${remoteActionAvailability.reason}。`}`)
      .addText((text) => text
        .setPlaceholder('docs.example.com')
        .setValue(customDomainPlan)
        .onChange((value) => {
          customDomainPlan = value;
        }))
      .addButton((button) => {
        this.remoteActionButtons.push(button);
        button.setButtonText('连接域名')
          .setDisabled(!remoteActionAvailability.enabled).onClick(async () => {
            if (!this.ensureRemoteActionAvailable()) return;
            button.setDisabled(true).setButtonText('连接中…');
            try {
              const status = await this.application.connectConfiguredCustomDomain(
                customDomainPlan.trim(),
              );
              if (!(await this.reconcileRemoteConfigChangeAfterSuccess(
                '自定义域名连接请求已提交',
              ))) return;
              this.customDomainStatus = status;
              new Notice(customDomainStatusNotice(status));
              this.update();
            } catch (error) {
              new Notice(`无法连接自定义域名；现有本地绑定保持不变：${errorMessage(error)}`);
              this.restoreRemoteActionButton(button, '连接域名');
            }
          });
      });

    const featuresSection = new Setting(container).setName('站点功能').setHeading();
    sections.set('features', featuresSection.settingEl);
    new Setting(container)
      .setName('首页布局')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('sections', '按目录展示分区')
          .addOption('latest', '按最新文章展示')
          .setValue(draft.site.homeLayout)
          .onChange((value) => {
            this.updateDraft((current) => {
              current.site.homeLayout = value as 'sections' | 'latest';
            });
          }),
      );
    new Setting(container).setName('全文搜索').addToggle((toggle) =>
      toggle.setValue(draft.features.search).onChange((value) => {
        this.updateDraft((current) => {
          current.features.search = value;
        });
      }),
    );
    new Setting(container).setName('知识图谱').addToggle((toggle) =>
      toggle.setValue(draft.features.graph).onChange((value) => {
        this.updateDraft((current) => {
          current.features.graph = value;
        });
      }),
    );

    this.renderThemeSettings(container, sections, state);

    this.renderMaintenance(container, sections);

    const scrollRoot = document.closest('.vertical-tab-content');
    if (typeof IntersectionObserver !== 'undefined') {
      this.sectionObserver = new IntersectionObserver((entries) => {
        const active = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (!active) return;
        for (const [id, section] of sections) {
          if (section === active.target) setActiveAnchor(id);
        }
      }, {
        root: scrollRoot,
        rootMargin: '-14% 0px -70%',
        threshold: [0.01, 0.2, 0.6],
      });
      for (const section of sections.values()) this.sectionObserver.observe(section);
    }

    if (this.pendingUrlChanges && this.pendingUrlChanges.length > 0) {
      const impact = container.createDiv({ cls: 'pages-publish-view__warning' });
      impact.createEl('p', {
        text: `公开路径变化将影响 ${this.pendingUrlChanges.length} 篇已上线文章。确认后再次点击“保存设置”。`,
      });
      const list = impact.createEl('ul');
      for (const change of this.pendingUrlChanges) {
        list.createEl('li', {
          text: `${change.sourcePath}：${change.onlineUrl} → ${change.pendingUrl}`,
        });
      }
      impact.createEl('p', {
        text: '保存前会把每个已知旧 URL 写入文章 redirects；不会自动发布。',
      });
    }

    const footer = new Setting(container).setDesc(
      settingsLocalSaveDescription(state.status),
    );
    footer.settingEl.addClass('pages-publish-settings__footer');
    this.localSaveDescription = footer.descEl;
    footer
      .addButton((button) =>
        button.setButtonText('放弃更改').onClick(async () => {
          if (!this.session) return;
          const reloaded = await reloadSettingsDraft(this.session);
          this.editorState = reloaded.state;
          if (reloaded.error) {
            new Notice(`无法重新载入配置；已保留当前草稿：${reloaded.error}`);
          }
          this.update();
        }),
      )
      .addButton((button) =>
        button.setButtonText('验证').onClick(async () => {
          try {
            const currentDraft = this.session?.getState().draft ?? state.draft;
            await validateSiteConfigForDirectory(this.vaultRoot, currentDraft);
            new Notice('配置验证通过。');
          } catch (error) {
            new Notice(`配置验证失败：${errorMessage(error)}`);
          }
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('保存设置')
          .setCta()
          .setDisabled(!state.canSave)
          .onClick(async () => {
            try {
              if (!this.session) return;
              const saveInput = this.session.getSaveInput();
              const service = new SiteSettingsService(this.vaultRoot, {
                scan: () => this.application.requestScan('config-save'),
              });
              const urlChanges = await service.previewUrlChanges(saveInput.draft);
              if (
                urlChanges.length > 0 &&
                JSON.stringify(urlChanges) !==
                  JSON.stringify(this.pendingUrlChanges ?? [])
              ) {
                this.pendingUrlChanges = urlChanges;
                new Notice('请先审阅 URL 影响，然后再次点击“保存设置”确认。');
                this.update();
                return;
              }
              const result = await service.save(saveInput.draft, saveInput.expectedRevision);
              this.session = await SiteConfigEditorSession.open(this.vaultRoot);
              this.editorState = this.session.getState();
              this.pendingUrlChanges = undefined;
              const blockers = scanBlockerCount(result.scan);
              new Notice(blockers > 0
                ? `配置已保存并完成扫描；发现 ${blockers} 个阻塞，正在打开问题视图。没有执行发布。`
                : '配置已保存并完成扫描。没有执行发布。');
              this.update();
              if (blockers > 0) await this.openPublishCenter('issues');
            } catch (error) {
              await this.notifyConfigFileChanged();
              new Notice(`无法保存配置：${errorMessage(error)}`);
            }
          }),
      );
  }

  private renderThemeSettings(
    container: HTMLElement,
    sections: Map<string, HTMLElement>,
    state: SiteConfigEditorState,
  ): void {
    const section = new Setting(container).setName('站点主题').setHeading();
    sections.set('theme', section.settingEl);
    const reference = state.draft.site.theme;
    if (!this.themeManagement) {
      new Setting(container)
        .setName('Quartz 默认主题')
        .setDesc('当前宿主未接入外部主题管理；站点继续使用受控 Quartz 默认主题。');
      return;
    }

    const key = themeReferenceKey(reference);
    if (this.themePanelKey !== key && this.themePanelLoadingKey !== key) {
      this.themePanelLoadingKey = key;
      const manager = this.themeManagement;
      void manager.panelState(reference).then((panel) => {
        if (this.themePanelLoadingKey !== key) return;
        this.themePanelLoadingKey = undefined;
        this.themePanelKey = key;
        this.themePanelState = panel;
        this.update();
      }).catch((error) => {
        if (this.themePanelLoadingKey !== key) return;
        this.themePanelLoadingKey = undefined;
        this.themePanelKey = key;
        this.themePanelState = {
          installed: [],
          configuredError: {
            code: 'theme-status-unavailable',
            message: errorMessage(error),
          },
        };
        this.update();
      });
    }

    const panel = this.themePanelKey === key ? this.themePanelState : undefined;
    if (reference === undefined) {
      new Setting(container)
        .setName('当前主题')
        .setDesc('Quartz 默认主题 · 无外部包 · 永远可作为恢复路径');
    } else if (panel?.configured) {
      const current = panel.configured;
      new Setting(container)
        .setName(current.displayName)
        .setDesc([
          `${current.reference.source === 'npm' ? 'npm' : '本地工件'} · ${current.packageName}@${current.version}`,
          `integrity ${shortIntegrity(current.integrity)}`,
          current.trusted ? '已确认执行信任' : '尚未确认执行信任',
        ].join('；'));
    } else if (panel?.configuredError) {
      new Setting(container)
        .setName('主题需要修复')
        .setDesc(`${panel.configuredError.code}：${panel.configuredError.message}`);
    } else {
      new Setting(container)
        .setName('正在检查主题')
        .setDesc('正在校验固定版本、完整性、文件 inventory 和执行信任。');
    }

    new Setting(container)
      .setName('恢复默认主题')
      .setDesc('只形成未保存草稿；保存后下次预览和发布使用 Quartz 默认主题。')
      .addButton((button) => button
        .setButtonText('使用 Quartz 默认主题')
        .setDisabled(reference === undefined)
        .onClick(() => {
          this.pendingThemeCandidate = undefined;
          this.updateDraft((draft) => {
            delete draft.site.theme;
          });
          this.themePanelKey = undefined;
          this.update();
        }));

    let npmPackage = '';
    let npmVersion = '';
    new Setting(container)
      .setName('从 npm 安装精确版本')
      .setDesc('只访问官方 npm registry；不会运行 npm install、生命周期脚本或解析依赖树。')
      .addText((text) => text
        .setPlaceholder('@scope/theme')
        .onChange((value) => { npmPackage = value.trim(); }))
      .addText((text) => text
        .setPlaceholder('1.0.0')
        .onChange((value) => { npmVersion = value.trim(); }))
      .addButton((button) => button
        .setButtonText('安装')
        .setDisabled(this.themeOperation !== undefined)
        .onClick(async () => {
          if (!npmPackage || !npmVersion) {
            new Notice('请输入 npm package 和精确版本。');
            return;
          }
          const candidate = await this.runThemeOperation(
            '正在安装 npm 主题',
            (signal) => this.themeManagement!.installNpm(npmPackage, npmVersion, signal),
          );
          if (!candidate) return;
          this.pendingThemeCandidate = candidate;
          this.themePanelKey = undefined;
          new Notice('主题已验证并缓存；确认执行信任后才会加入设置草稿。');
          this.update();
        }));

    const localSetting = new Setting(container)
      .setName('导入本地主题包')
      .setDesc('选择 .tgz；插件会复制到 Vault 的 .publish/themes/，固定摘要后执行隔离 smoke。');
    const fileInput = localSetting.controlEl.createEl('input');
    fileInput.type = 'file';
    fileInput.accept = '.tgz,application/gzip';
    fileInput.disabled = this.themeOperation !== undefined;
    fileInput.setAttribute('aria-label', '选择本地 Quartz 主题 tgz 包');
    localSetting.controlEl.appendChild(fileInput);
    fileInput.addEventListener('change', () => {
      const selected = fileInput.files?.[0];
      const selectedPath = localDesktopFilePath(selected);
      if (!selectedPath) {
        new Notice('无法取得所选文件路径；请使用 Obsidian 桌面端本地文件选择器。');
        return;
      }
      void this.runThemeOperation(
        '正在导入本地主题',
        (signal) => this.themeManagement!.importLocal(selectedPath, signal),
      ).then((candidate) => {
        if (!candidate) return;
        this.pendingThemeCandidate = candidate;
        this.themePanelKey = undefined;
        new Notice('本地主题已验证并缓存；确认执行信任后才会加入设置草稿。');
        this.update();
      });
    });

    if (this.themeOperation) {
      new Setting(container)
        .setName(this.themeOperation.label)
        .setDesc('一次只执行一个安装、修复或导入操作。取消会清理未完成的临时目录。')
        .addButton((button) => button.setButtonText('取消').onClick(() => {
          this.themeOperation?.controller.abort();
        }));
    }

    if (this.pendingThemeCandidate) {
      const candidate = this.pendingThemeCandidate;
      const hasClientScripts = candidate.capabilities.includes('clientScripts');
      const warning = container.createDiv({ cls: 'pages-publish-view__warning' });
      warning.createEl('strong', { text: `确认执行信任：${candidate.displayName}` });
      warning.createEl('p', {
        text: `${candidate.packageName}@${candidate.version} · 来源：${candidate.reference.source === 'npm' ? '官方 npm registry 精确工件' : 'Vault 本地工件'} · integrity：${shortIntegrity(candidate.integrity)}。该主题包含会在隔离 Quartz 构建中执行的代码。`,
      });
      if (candidate.publisher !== undefined) {
        warning.createEl('p', {
          text: `Registry 发布者：${formatThemePublisher(candidate.publisher)}。此信息仅供识别，不是信任根；精确 integrity 才标识当前工件。`,
        });
      }
      if (hasClientScripts) {
        warning.createEl('p', {
          text: '该主题还声明 clientScripts：脚本会在读者浏览器中执行，但仍受本地资源扫描和站点 CSP 约束。',
        });
      }
      new Setting(warning)
        .setDesc(`能力：${candidate.capabilities.join('、') || '无'}`)
        .addButton((button) => button.setButtonText('取消').onClick(() => {
          this.pendingThemeCandidate = undefined;
          this.update();
        }))
        .addButton((button) => button.setButtonText('我信任并加入草稿').setCta().onClick(async () => {
          try {
            await this.themeManagement!.confirmTrust(candidate);
            this.updateDraft((draft) => {
              draft.site.theme = structuredClone(candidate.reference);
            });
            this.pendingThemeCandidate = undefined;
            this.themePanelKey = undefined;
            new Notice('已记录此精确主题工件的信任；仍需保存设置才会生效。');
            this.update();
          } catch (error) {
            new Notice(`无法记录主题信任：${errorMessage(error)}`);
          }
        }));
    }

    const configured = panel?.configured;
    if (reference && configured?.optionsSchema) {
      new Setting(container).setName('主题选项').setHeading();
      for (const [name, optionSchema] of Object.entries(
        configured.optionsSchema.properties ?? {},
      )) {
        this.renderThemeOption(container, reference, name, optionSchema);
      }
    }

    if ((panel?.installed.length ?? 0) > 0) {
      new Setting(container).setName('已验证版本').setHeading();
      for (const installed of panel?.installed ?? []) {
        const isActive = reference?.integrity === installed.integrity;
        new Setting(container)
          .setName(`${installed.displayName} ${installed.version}`)
          .setDesc(`${installed.reference.source} · ${shortIntegrity(installed.integrity)} · ${installed.trusted ? '已信任' : '未信任'}`)
          .addButton((button) => button
            .setButtonText(isActive ? '当前草稿' : '选择')
            .setDisabled(isActive)
            .onClick(() => {
              if (!installed.trusted) {
                this.pendingThemeCandidate = installed;
              } else {
                this.updateDraft((draft) => {
                  draft.site.theme = structuredClone(installed.reference);
                });
                this.themePanelKey = undefined;
              }
              this.update();
            }))
          .addButton((button) => button
            .setButtonText('卸载')
            .setDestructive()
            .setDisabled(isActive || this.themeOperation !== undefined)
            .onClick(async () => {
              try {
                await this.themeManagement!.uninstall(installed, reference);
                this.themePanelKey = undefined;
                new Notice('未使用的主题缓存版本已卸载；Vault 内本地 .tgz 未删除。');
                this.update();
              } catch (error) {
                new Notice(`无法卸载主题：${errorMessage(error)}`);
              }
            }));
      }
    }

    if (reference) {
      new Setting(container)
        .setName('主题维护与预览')
        .setDesc('修复会重新取得同一精确工件并校验完整性；预览使用已保存配置，不会部署。')
        .addButton((button) => button
          .setButtonText('修复')
          .setDisabled(this.themeOperation !== undefined)
          .onClick(async () => {
            const repaired = await this.runThemeOperation(
              '正在修复主题',
              async (signal) => {
                await this.themeManagement!.repair(reference, signal);
                return true;
              },
            );
            if (!repaired) return;
            this.themePanelKey = undefined;
            new Notice('主题已按配置中的精确 integrity 修复。');
            this.update();
          }))
        .addButton((button) => button
          .setButtonText('预览已保存主题')
          .setDisabled(state.status !== 'clean' || configured?.trusted !== true)
          .onClick(async () => {
            try {
              await this.application.openPreview();
              new Notice('主题本地预览已打开；没有自动发布。');
            } catch (error) {
              new Notice(`无法预览主题：${errorMessage(error)}`);
            }
          }));
    }
  }

  private renderThemeOption(
    container: HTMLElement,
    reference: SiteThemeReference,
    name: string,
    schema: ThemeOptionSchema,
  ): void {
    const value = reference.options[name];
    const setting = new Setting(container)
      .setName(schema.title ?? name)
      .setDesc(schema.description ?? `主题选项：${name}`);
    if (schema.enum) {
      setting.addDropdown((dropdown) => {
        for (const item of schema.enum ?? []) {
          dropdown.addOption(JSON.stringify(item), themeOptionLabel(item));
        }
        dropdown.setValue(JSON.stringify(value)).onChange((selected) => {
          this.updateThemeOption(name, JSON.parse(selected) as JsonValue);
        });
      });
      return;
    }
    if (schema.type === 'boolean') {
      setting.addToggle((toggle) => toggle
        .setValue(value === true)
        .onChange((selected) => this.updateThemeOption(name, selected)));
      return;
    }
    setting.addText((text) => {
      text.inputEl.type = schema.type === 'number' || schema.type === 'integer'
        ? 'number'
        : 'text';
      text.setValue(typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : JSON.stringify(value ?? schema.default ?? ''))
        .onChange((selected) => {
          if (schema.type === 'number' || schema.type === 'integer') {
            const number = Number(selected);
            if (Number.isFinite(number)) this.updateThemeOption(name, number);
            return;
          }
          if (schema.type === 'array' || schema.type === 'object') {
            try {
              this.updateThemeOption(name, JSON.parse(selected) as JsonValue);
            } catch {
              // Keep the current valid draft until the JSON field becomes valid.
            }
            return;
          }
          this.updateThemeOption(name, selected);
        });
    });
  }

  private updateThemeOption(name: string, value: JsonValue): void {
    this.updateDraft((draft) => {
      const theme = draft.site.theme;
      if (!theme) return;
      theme.options = { ...theme.options, [name]: value };
    });
  }

  private async runThemeOperation<T>(
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.themeOperation) {
      new Notice('已有主题操作正在进行。');
      return undefined;
    }
    const controller = new AbortController();
    this.themeOperation = { label, controller };
    this.update();
    try {
      return await operation(controller.signal);
    } catch (error) {
      new Notice(controller.signal.aborted
        ? '主题操作已取消；未完成的临时文件已清理。'
        : `主题操作失败：${errorMessage(error)}`);
      return undefined;
    } finally {
      if (this.themeOperation?.controller === controller) {
        this.themeOperation = undefined;
      }
      this.update();
    }
  }

  private renderMaintenance(
    container: HTMLElement,
    sections?: Map<string, HTMLElement>,
  ): void {
    const environmentSection = new Setting(container).setName('本地环境').setHeading();
    sections?.set('environment', environmentSection.settingEl);
    const environment = this.application.getInitialSetupEnvironment();
    const runtime = 'runtime' in environment ? environment.runtime : undefined;
    const engine = 'engine' in environment ? environment.engine : undefined;
    new Setting(container)
      .setName('Node.js 运行时')
      .setDesc(runtime
        ? `${runtime.source === 'obsidian' ? 'Obsidian 内嵌运行时' : '插件管理运行时'} ${runtime.version} · ${environment.stage}`
        : `尚未取得兼容运行时 · ${environment.stage}`);
    new Setting(container)
      .setName('Pages 发布引擎')
      .setDesc(engine ? `${engine.version} · ${environment.stage}` : `尚未取得引擎版本 · ${environment.stage}`);
    const preview = this.application.getPreviewStatus();
    new Setting(container)
      .setName('本地预览')
      .setDesc(`${preview.state === 'running' ? `运行中 · ${preview.url}` : '未运行'}；使用当前本地配置与内容构建，不会发布或修改远端。`)
      .addButton((button) => button.setButtonText('启动预览').onClick(async () => {
        try {
          await this.application.openPreview();
          new Notice('本地预览已打开。');
        } catch (error) {
          new Notice(`无法启动本地预览：${errorMessage(error)}`);
        }
      }));
    const status = this.application.getMaintenanceStatus();
    if ('state' in status) {
      container.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: '本地环境、日志与诊断边界尚未由宿主接入；不会尝试修改远端或本地缓存。',
      });
      this.renderSiteConfigRemoval(container);
      return;
    }
    new Setting(container)
      .setName('运行时与缓存')
      .setDesc(`环境：${status.environment.stage}；缓存：${status.cache.state}；连接：${status.connection.state}`)
      .addButton((button) => button.setButtonText('修复本地环境').setDisabled(!status.capabilities.repairEnvironment).onClick(async () => {
        await this.runMaintenanceAction('本地环境已修复。', () => this.application.repairEnvironment());
      }))
      .addButton((button) => button.setButtonText('清理可重建缓存').onClick(async () => {
        await this.runMaintenanceAction('可重建缓存已清理；不会影响 Vault、线上站点或凭据。', () => this.application.clearRebuildableCache());
      }))
      .addButton((button) => button.setButtonText('刷新连接状态').setDisabled(!status.capabilities.refreshConnection).onClick(async () => {
        await this.runMaintenanceAction('连接状态已刷新。', () => this.application.refreshMaintenanceConnection());
      }));
    new Setting(container)
      .setName('日志与诊断')
      .setDesc('诊断导出不包含凭据、授权头、文章正文、私密路径或构建产物。')
      .addButton((button) => button.setButtonText('打开日志').setDisabled(!status.capabilities.openLogs).onClick(async () => {
        await this.runMaintenanceAction('已打开本地日志。', () => this.application.openMaintenanceLogs());
      }))
      .addButton((button) => button.setButtonText('导出诊断包').onClick(() => {
        this.diagnosticReview = true;
        this.update();
      }));
    if (this.diagnosticReview) {
      const summary = this.application.describeDiagnosticExport();
      const review = container.createDiv({ cls: 'pages-publish-view__warning' });
      review.createEl('p', { text: `将包含：${summary.included.join('、')}。` });
      review.createEl('p', { text: `将排除：${summary.excluded.join('、')}。` });
      new Setting(review).addButton((button) =>
        button.setButtonText('确认并导出诊断包').setCta().onClick(async () => {
          try {
            const result = await this.application.exportDiagnostics({ confirmed: true });
            this.diagnosticReview = false;
            new Notice(`诊断包已导出：${result.path}`);
            this.update();
          } catch (error) {
            new Notice(`无法导出诊断包：${errorMessage(error)}`);
          }
        }),
      );
    }
    this.renderSiteConfigRemoval(container);
  }

  private renderCloudflareConnection(
    container: HTMLElement,
    remoteActionAvailability = settingsRemoteActionAvailability(
      this.session?.getState().status ?? 'clean',
    ),
  ): void {
    this.ensureOAuthResultSubscription();
    new Setting(container).setName('Cloudflare 连接').setHeading();
    const canUseOAuth = this.application.canConnectInitialSetupOAuth();
    const canUseApiToken = this.application.canConnectInitialSetupApiToken();
    if (!canUseOAuth && !canUseApiToken) {
      container.createEl('p', {
        cls: 'pages-publish-view__warning',
        text: '当前宿主未提供 Cloudflare 连接能力；不会尝试保存凭据。',
      });
      return;
    }
    const status = container.createEl('p', { text: '正在读取 Cloudflare 连接状态…' });
    void this.application.getInitialSetupConnection().then((connection) => {
      if ('account' in connection && connection.state === 'connected' && connection.account) {
        status.setText(`已连接：${connection.account.name}`);
        return;
      }
      status.setText(connection.state === 'expired'
        ? '连接已失效；请重新授权或更新 API token。'
        : canUseOAuth
          ? '尚未连接 Cloudflare。'
          : '尚未连接 Cloudflare；此发行版本未配置 OAuth client。');
    }).catch(() => {
      status.setText('无法读取 Cloudflare 连接状态。');
    });

    if (canUseOAuth) {
      new Setting(container)
        .setName('Cloudflare OAuth')
        .setDesc(`推荐方式；将在浏览器打开授权页面，凭据保存在 Obsidian 安全存储（当前 Vault 的本地存储）。${remoteActionAvailability.enabled ? '' : ` ${remoteActionAvailability.reason}。`}`)
        .addButton((button) => {
          this.remoteActionButtons.push(button);
          button.setButtonText('使用 Cloudflare 登录')
            .setCta()
            .setDisabled(!remoteActionAvailability.enabled)
            .onClick(async () => {
              if (!this.ensureRemoteActionAvailable()) return;
              this.pendingOAuthButton = button;
              button.setDisabled(true);
              try {
                await this.application.beginInitialSetupOAuth();
                new Notice('已在浏览器打开 Cloudflare 授权；完成后将返回 Obsidian。');
              } catch (error) {
                if (this.pendingOAuthButton === button) this.pendingOAuthButton = undefined;
                new Notice(`无法开始 Cloudflare 授权：${errorMessage(error)}`);
                this.restoreRemoteActionButton(button, '使用 Cloudflare 登录');
              }
            });
        });
    }

    if (canUseApiToken) {
      let token = '';
      let tokenInput: HTMLInputElement | undefined;
      const connectionSetting = new Setting(container)
        .setName('Cloudflare API token')
        .setDesc(canUseOAuth
          ? '高级备用方式；仅在点击连接后验证并写入 Obsidian 安全存储。普通保存设置不会发送或保存此值。'
          : '此发行版本未配置 OAuth client；仅在点击连接后验证并写入 Obsidian 安全存储。普通保存设置不会发送或保存此值。')
        .addText((text) => {
          tokenInput = text.inputEl;
          text.inputEl.type = 'password';
          text.setPlaceholder('粘贴 API token').onChange((value) => {
            token = value;
          });
        });
      connectionSetting.addButton((button) => {
        this.remoteActionButtons.push(button);
        button.setButtonText('连接 Cloudflare')
          .setCta()
          .setDisabled(!remoteActionAvailability.enabled)
          .onClick(async () => {
          if (!this.ensureRemoteActionAvailable()) return;
          if (token.trim().length === 0) {
            new Notice('请输入 Cloudflare API token。');
            return;
          }
          button.setDisabled(true).setButtonText('连接中…');
          try {
            const connected = await this.application.connectInitialSetupApiToken(token.trim());
            const account = 'account' in connected ? connected.account : undefined;
            if (connected.state !== 'connected' || !account) {
              throw new Error('Cloudflare 未返回可用于 Pages 发布的账号。');
            }
            new Notice(`Cloudflare 已连接：${account.name}`);
            this.resetCustomDomainStatus();
            this.update();
          } catch (error) {
            new Notice(`无法连接 Cloudflare：${errorMessage(error)}`);
            this.restoreRemoteActionButton(button, '连接 Cloudflare');
          } finally {
            token = '';
            if (tokenInput) tokenInput.value = '';
          }
        });
      });
    }

    const domainStatus = this.customDomainStatus;
    new Setting(container)
      .setName('自定义域名状态')
      .setDesc(customDomainStatusDescription(domainStatus))
      .addButton((button) => button.setButtonText('检查状态').onClick(async () => {
        button.setDisabled(true).setButtonText('检查中…');
        try {
          const inspected = await this.customDomainStatusRequest.resolve(
            () => this.application.inspectConfiguredCustomDomain(),
          );
          if (!inspected) {
            // A config or account change invalidated this request without
            // necessarily re-rendering the currently mounted settings form.
            button.setDisabled(false).setButtonText('检查状态');
            return;
          }
          this.customDomainStatus = inspected;
          new Notice(customDomainStatusNotice(inspected));
          this.update();
        } catch (error) {
          new Notice(`无法检查自定义域名状态：${errorMessage(error)}`);
          button.setDisabled(false).setButtonText('检查状态');
        }
      }));

    if (!this.application.canSelectInitialSetupAccount()) return;
    const accounts = container.createDiv({ cls: 'pages-publish-view__setup-options' });
    const selectAccount = new ButtonComponent(accounts)
      .setButtonText('选择发布账号')
      .setDisabled(!remoteActionAvailability.enabled)
      .onClick(async () => {
      if (!this.ensureRemoteActionAvailable()) return;
      try {
        const available = await this.application.listInitialSetupAccounts();
        accounts.empty();
        for (const account of available) {
          const currentAvailability = settingsRemoteActionAvailability(
            this.session?.getState().status ?? 'clean',
          );
          const accountButton = new ButtonComponent(accounts)
            .setButtonText(account.name)
            .setDisabled(!currentAvailability.enabled)
            .onClick(async () => {
            if (!this.ensureRemoteActionAvailable()) return;
            try {
              const selected = await this.application.selectConfiguredAccount(account.id);
              if (!(await this.reconcileRemoteConfigChangeAfterSuccess(
                `Cloudflare 发布账号已切换为：${account.name}`,
              ))) return;
              const current = 'account' in selected ? selected.account : undefined;
              new Notice(current
                ? `发布账号已切换为：${current.name}`
                : 'Cloudflare 账号未能切换。');
              this.resetCustomDomainStatus();
              this.update();
            } catch (error) {
              new Notice(`无法切换 Cloudflare 账号：${errorMessage(error)}`);
            }
          });
          this.remoteActionButtons.push(accountButton);
        }
      } catch (error) {
        new Notice(`无法读取 Cloudflare 账号：${errorMessage(error)}`);
      }
    });
    this.remoteActionButtons.push(selectAccount);
  }

  private renderSiteConfigRemoval(container: HTMLElement): void {
    new Setting(container)
      .setName('移除本地站点配置')
      .setDesc('将 .publish/site.yml 移入系统废纸篓；不会删除 Cloudflare 项目或线上内容。')
      .addButton((button) => button.setButtonText('移入废纸篓').setDestructive().onClick(() => {
        this.siteConfigRemovalReview = true;
        this.update();
      }));
    if (this.siteConfigRemovalReview) {
      const review = container.createDiv({ cls: 'pages-publish-view__warning' });
      review.createEl('p', { text: '此操作只会将 .publish/site.yml 移入废纸篓；Cloudflare 项目、线上内容、安全存储凭据与 Vault 文章均不会删除。' });
      new Setting(review).addButton((button) =>
        button.setButtonText('确认移入废纸篓').setDestructive().onClick(async () => {
          try {
            await trashHiddenSiteConfig(this.app.vault.adapter);
            this.hide();
            new Notice('本地站点配置已移入废纸篓。');
          } catch (error) {
            new Notice(`无法移除本地站点配置：${errorMessage(error)}`);
          }
        }),
      );
    }
  }

  private async runMaintenanceAction(
    success: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
      new Notice(success);
      this.update();
    } catch (error) {
      new Notice(`维护操作失败：${errorMessage(error)}`);
    }
  }

  private updateDraft(change: Parameters<SiteConfigEditorSession['update']>[0]): void {
    if (!this.session) return;
    this.pendingUrlChanges = undefined;
    this.pendingRootRemoval = undefined;
    this.resetCustomDomainStatus();
    this.editorState = this.session.update(change);
    this.headerStatusText?.setText(
      settingsHeaderStatusText(this.editorState.status),
    );
    this.localSaveDescription?.setText(
      settingsLocalSaveDescription(this.editorState.status),
    );
    this.remoteActionStatus?.setText(
      settingsRemoteActionStatusText(this.editorState.status),
    );
    const remoteActionAvailability = settingsRemoteActionAvailability(this.editorState.status);
    if (!remoteActionAvailability.enabled) {
      for (const button of this.remoteActionButtons) {
        button.setDisabled(true);
      }
    }
  }

  private ensureRemoteActionAvailable(): boolean {
    const availability = settingsRemoteActionAvailability(
      this.session?.getState().status ?? 'clean',
    );
    if (availability.enabled) return true;
    new Notice(`${availability.reason}。`);
    return false;
  }

  private restoreRemoteActionButton(
    button: ButtonComponent,
    label: string,
  ): void {
    const availability = settingsRemoteActionAvailability(
      this.session?.getState().status ?? 'clean',
    );
    button.setButtonText(label).setDisabled(!availability.enabled);
  }

  private ensureOAuthResultSubscription(): void {
    if (this.unsubscribeGlobalUiState) return;
    this.unsubscribeGlobalUiState = this.application.subscribeGlobalUiState?.(() => {
      const button = this.pendingOAuthButton;
      if (!button) return;
      this.pendingOAuthButton = undefined;
      this.restoreRemoteActionButton(button, '使用 Cloudflare 登录');
      this.update();
    });
  }

  private async reconcileRemoteConfigChange(): Promise<void> {
    if (!this.session) {
      this.session = await SiteConfigEditorSession.open(this.vaultRoot);
      this.editorState = this.session.getState();
      return;
    }
    this.editorState = await this.session.detectExternalChange();
  }

  private async reconcileRemoteConfigChangeAfterSuccess(
    success: string,
  ): Promise<boolean> {
    try {
      await this.reconcileRemoteConfigChange();
      return true;
    } catch (error) {
      new Notice(
        `${success}，但无法刷新本地设置状态：${errorMessage(error)}。请重新打开设置后核对当前配置。`,
      );
      return false;
    }
  }

  private resetCustomDomainStatus(): void {
    this.customDomainStatusRequest.invalidate();
    this.customDomainStatus = undefined;
  }

  private async openPublishCenter(tab: 'changes' | 'issues' = 'changes'): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PAGES_PUBLISH_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
      state: { tab },
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}

export function settingsRemoteActionAvailability(
  status: SiteConfigEditorState['status'],
): { enabled: true } | { enabled: false; reason: string } {
  if (status === 'clean') return { enabled: true };
  return {
    enabled: false,
    reason: status === 'conflict'
      ? '请先解决配置文件外部修改冲突'
      : '请先保存或放弃本地设置更改',
  };
}

export function settingsLocalSaveDescription(
  status: SiteConfigEditorState['status'],
): string {
  if (status === 'dirty') {
    return '有未保存的设置。保存后将重新扫描，但不会自动发布。';
  }
  if (status === 'conflict') {
    return '站点配置已在外部修改。请先重新载入或查看差异，不能直接覆盖。';
  }
  return '配置有效。保存设置不会自动预览或发布。';
}

export function settingsHeaderStatusText(
  status: SiteConfigEditorState['status'],
): string {
  if (status === 'dirty') {
    return '有未保存的本地设置 · .publish/site.yml 仍是当前生效来源';
  }
  if (status === 'conflict') {
    return '.publish/site.yml 已在外部修改 · 本页草稿不会被直接覆盖';
  }
  return '配置有效 · .publish/site.yml 是唯一站点配置来源';
}

export function settingsRemoteActionStatusText(
  status: SiteConfigEditorState['status'],
): string {
  const availability = settingsRemoteActionAvailability(status);
  if (!availability.enabled) {
    return `${availability.reason}；Cloudflare 账号、项目和域名动作已禁用。`;
  }
  return 'Cloudflare 账号、项目和域名动作独立执行；普通保存设置不会触发这些动作。';
}

export async function reloadSettingsDraft<T>(session: {
  getState(): T;
  reloadExternal(): Promise<T>;
}): Promise<{ state: T; error?: string }> {
  try {
    return { state: await session.reloadExternal() };
  } catch (error) {
    return { state: session.getState(), error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function themeReferenceKey(reference?: SiteThemeReference): string {
  return reference === undefined ? 'quartz-default' : JSON.stringify(reference);
}

function shortIntegrity(integrity: string): string {
  return `${integrity.slice(0, 18)}…${integrity.slice(-8)}`;
}

function formatThemePublisher(publisher: { name?: string; email?: string }): string {
  if (publisher.name && publisher.email) return `${publisher.name} <${publisher.email}>`;
  return publisher.name ?? publisher.email ?? 'registry 未提供名称';
}

function themeOptionLabel(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  return JSON.stringify(value);
}

function localDesktopFilePath(file: File | undefined): string | undefined {
  if (file === undefined) return undefined;
  const path = (file as unknown as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function customDomainStatusDescription(status: ConfiguredCustomDomainStatus | undefined): string {
  if (!status) return '按“检查状态”读取配置的自定义域名；此操作只读取 cloudflare，不会创建或修改绑定。';
  if (status.state === 'unavailable') return '当前宿主未提供自定义域名状态读取能力。';
  if (status.state === 'not-configured') return '当前站点未配置自定义域名。';
  const prefix = `${status.hostname}：`;
  if (status.state === 'active') return `${prefix}已生效。`;
  if (status.state === 'pending') return `${prefix}等待 DNS 或 cloudflare 验证。`;
  return `${prefix}${status.message ?? '绑定未生效；请检查 Pages 项目、域名和 DNS 配置。'}`;
}

function customDomainStatusNotice(status: ConfiguredCustomDomainStatus): string {
  if (status.state === 'unavailable') return '当前宿主无法读取自定义域名状态。';
  if (status.state === 'not-configured') return '当前站点未配置自定义域名。';
  if (status.state === 'active') return `自定义域名已生效：${status.hostname}`;
  if (status.state === 'pending') return `自定义域名等待验证：${status.hostname}`;
  return `自定义域名未生效：${status.hostname}`;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function scanBlockerCount(scan: unknown): number {
  const coordinated = recordValue(scan);
  const value = recordValue(coordinated?.value);
  const issues = value?.issues;
  if (!Array.isArray(issues)) return 0;
  return issues.filter((issue) => recordValue(issue)?.severity === 'blocker').length;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function visibleCharacterCount(value: string): number {
  return Array.from(value).length;
}
