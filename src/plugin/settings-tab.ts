import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type SettingDefinitionItem,
} from 'obsidian';
import type { PagesPublishApplication } from '../application';
import {
  SiteConfigEditorSession,
  SiteSettingsService,
  type SiteConfigEditorState,
  type SiteUrlChange,
} from '../config/site-settings';
import {
  loadSiteConfigFromDirectory,
  validateSiteConfigForDirectory,
} from '../config/site-config';

export class PagesPublishSettingTab extends PluginSettingTab {
  private session?: SiteConfigEditorSession;
  private editorState?: SiteConfigEditorState;
  private pendingUrlChanges?: SiteUrlChange[];
  private diagnosticReview = false;
  private siteConfigRemovalReview = false;
  private rendering = 0;

  constructor(
    plugin: Plugin,
    private readonly vaultRoot: string,
    private readonly application: PagesPublishApplication,
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
    this.session = undefined;
    this.editorState = undefined;
    this.pendingUrlChanges = undefined;
    this.diagnosticReview = false;
    this.siteConfigRemovalReview = false;
    this.rendering += 1;
  }

  async notifyConfigFileChanged(): Promise<void> {
    if (!this.session) return;
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
    const draft = state.draft;
    container.createEl('p', {
      text: `${draft.site.name} · .publish/site.yml 是唯一站点配置来源`,
    });

    if (state.status === 'conflict' && state.comparison) {
      const warning = container.createDiv({ cls: 'pages-publish-view__warning' });
      warning.createEl('p', {
        text: '.publish/site.yml 已在外部修改。当前草稿不会被静默覆盖。',
      });
      const actions = warning.createDiv({ cls: 'pages-publish-view__actions' });
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

    new Setting(container).setName('站点').setHeading();
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
          this.updateDraft((current) => {
            current.site.description = value || undefined;
          });
        }),
      );
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

    new Setting(container).setName('内容范围').setHeading();
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
            .onClick(() => {
              this.updateDraft((current) => {
                current.contentRoots.splice(index, 1);
              });
              this.update();
            }),
        );
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

    new Setting(container).setName('Cloudflare').setHeading();
    new Setting(container)
      .setName('项目标识')
      .setDesc('非密钥；普通保存不会创建、删除或绑定远端项目。')
      .addText((text) =>
        text.setValue(draft.cloudflare.projectName).onChange((value) => {
          this.updateDraft((current) => {
            current.cloudflare.projectName = value;
          });
        }),
      );
    new Setting(container)
      .setName('自定义域名')
      .setDesc('仅表达期望域名，不保存凭据。')
      .addText((text) =>
        text.setValue(draft.cloudflare.customDomain ?? '').onChange((value) => {
          this.updateDraft((current) => {
            current.cloudflare.customDomain = value || undefined;
          });
        }),
      );

    new Setting(container).setName('站点功能').setHeading();
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

    this.renderMaintenance(container);

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
      state.status === 'dirty'
        ? '有未保存的设置。保存后将重新扫描，但不会自动发布。'
        : '配置有效。保存设置不会自动预览或发布。',
    );
    footer
      .addButton((button) =>
        button.setButtonText('放弃更改').onClick(async () => {
          if (!this.session) return;
          this.editorState = await this.session.reloadExternal();
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
              await service.save(saveInput.draft, saveInput.expectedRevision);
              this.session = await SiteConfigEditorSession.open(this.vaultRoot);
              this.editorState = this.session.getState();
              this.pendingUrlChanges = undefined;
              new Notice('配置已保存并完成扫描。没有执行发布。');
              this.update();
            } catch (error) {
              await this.notifyConfigFileChanged();
              new Notice(`无法保存配置：${errorMessage(error)}`);
            }
          }),
      );
  }

  private renderMaintenance(container: HTMLElement): void {
    new Setting(container).setName('本地环境').setHeading();
    new Setting(container)
      .setName('本地预览')
      .setDesc('使用当前本地配置与内容构建预览；不会发布或修改远端。')
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
      review.createEl('p', { text: '此操作只会将 .publish/site.yml 移入废纸篓；Cloudflare 项目、线上内容、Keychain 凭据与 Vault 文章均不会删除。' });
      new Setting(review).addButton((button) =>
        button.setButtonText('确认移入废纸篓').setDestructive().onClick(async () => {
          const file = this.app.vault.getAbstractFileByPath('.publish/site.yml');
          if (!(file instanceof TFile)) {
            new Notice('未找到可移除的本地站点配置。');
            return;
          }
          try {
            await this.app.fileManager.trashFile(file);
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
    this.editorState = this.session.update(change);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
