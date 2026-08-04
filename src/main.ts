import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  requestUrl,
  type MenuItem,
} from 'obsidian';
import { join } from 'node:path';
import { PagesPublishApplication } from './application';
import { CloudflareConnectionService } from './cloudflare/connection';
import {
  CloudflarePagesDeploymentInspector,
  CloudflarePagesProjectApi,
  CloudflareV4Api,
  CloudflareV4HttpClient,
  ObsidianRequestUrlTransport,
  createVaultCloudflarePagesDomainStatusInspector,
  createVaultCloudflarePagesDeploymentAdapter,
} from './cloudflare/obsidian-host';
import { watchSiteConfigChanges } from './config/site-config-watcher';
import {
  DeploymentFactsCoordinator,
  FileSystemDeploymentStateStore,
} from './publication/deployment-facts';
import { activatePagesPublish, type PagesPublishActivation } from './plugin/lifecycle';
import { PluginConnectionBindingStore } from './plugin/cloudflare-binding-store';
import { ObsidianSecretStorageKeychain } from './plugin/obsidian-secret-keychain';
import {
  PAGES_PUBLISH_LOG_VIEW_TYPE,
  openLatestMaintenanceLog,
} from './plugin/maintenance-log-host';
import { PagesPublishMaintenanceLogView } from './plugin/maintenance-log-view';
import { PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE, PagesPublishSiteConfigRepairView } from './plugin/site-config-repair-view';
import {
  localPluginStateDirectory,
  publicationEnvironmentDirectory,
} from './plugin/local-state-directory';
import { ObsidianPagesPublishHost } from './plugin/obsidian-host';
import { isSupportedPlatform, supportedPlatformIdentity } from './plugin/platform';
import { articleMenuAvailability, pagesPublishAction } from './plugin/safe-actions';
import { openPluginSettingsInHost } from './plugin/settings-navigation';
import { PagesPublishSettingTab } from './plugin/settings-tab';
import { openInSystemBrowser } from './plugin/system-browser';
import { createLocalMaintenanceService } from './maintenance/local-maintenance';
import { BoundedDiagnosticLog } from './maintenance/maintenance-service';
import {
  CURRENT_ARTICLE_VIEW_TYPE,
  CurrentArticleView,
} from './plugin/current-article-view';
import { PAGES_PUBLISH_VIEW_TYPE, PagesPublishView } from './plugin/view';
import { SiteSetupService } from './setup/site-setup';
import { QuartzPublicationEnvironment } from './plugin/quartz-publication-environment';
import {
  ManagedNodeRuntimeStore,
  builtinManagedNodeManifest,
} from './runtime/managed-node-runtime';
import { builtinQuartzEngineManifest } from './runtime/builtin-quartz-manifest';
import { QuartzEngineStore } from './runtime/quartz-engine-store';
import { createQuartzEngineSmoke } from './runtime/quartz-engine-smoke';
import {
  asManagedPublicationRuntime,
  inspectEmbeddedPublicationRuntime,
} from './runtime/runtime-selector';
import { QuartzBuildRunner } from './site-builder/quartz-build-runner';
import { QuartzSiteBuilder } from './site-builder/quartz-site-builder';
import { CloudflareDesktopOAuth } from './cloudflare/oauth-host';
import { cloudflareOAuthBuildConfig } from './cloudflare/oauth-build-config';
import { CloudflareOAuthLoopbackServer } from './cloudflare/oauth-loopback';
import { completeCloudflareOAuthCallback } from './cloudflare/oauth-callback-handler';
import { ThemeStore } from './theme/theme-store';
import { ThemeTrustStore } from './theme/theme-trust-store';
import { InstalledThemeResolver } from './theme/theme-resolver';
import { createQuartzThemeSmoke } from './theme/theme-quartz-smoke';
import { ThemeRegistryClient } from './theme/theme-registry-client';
import { ThemeInstaller } from './theme/theme-installer';
import { ThemeManagementService } from './theme/theme-management';

export default class PagesPublishPlugin extends Plugin {
  private activation: PagesPublishActivation | undefined;

  async onload(): Promise<void> {
    const isFileSystemVault = this.app.vault.adapter instanceof FileSystemAdapter;
    if (!isSupportedPlatform(process.platform, isFileSystemVault)) {
      new Notice('当前插件仅支持 macOS 上使用本地文件系统的 Obsidian 桌面端。');
      return;
    }

    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const vaultRoot = adapter.getBasePath();
    const platform = supportedPlatformIdentity(
      process.platform,
      process.arch,
      isFileSystemVault,
    );
    if (!platform) return;
    const maintenanceDirectory = `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/maintenance`;
    const diagnosticLog = new BoundedDiagnosticLog();
    const cloudflareHttp = new CloudflareV4HttpClient(
      new ObsidianRequestUrlTransport({ requestUrl }),
    );
    const oauthConfig = cloudflareOAuthBuildConfig();
    const cloudflareOAuth = oauthConfig === undefined
      ? {
        available: false,
        begin: async () => {
          throw new Error('Cloudflare OAuth client metadata is not configured in this build.');
        },
        exchange: async () => {
          throw new Error('Cloudflare OAuth client metadata is not configured in this build.');
        },
      }
      : new CloudflareDesktopOAuth({
        ...oauthConfig,
        request: async (input) => {
          const response = await requestUrl({
            url: input.url,
            method: input.method,
            headers: input.headers,
            body: input.body,
            throw: false,
          });
          return { status: response.status, json: response.json as unknown };
        },
      });
    const cloudflareConnection = new CloudflareConnectionService({
      oauth: cloudflareOAuth,
      api: new CloudflareV4Api(cloudflareHttp),
      keychain: new ObsidianSecretStorageKeychain(this.app.secretStorage),
      bindings: new PluginConnectionBindingStore({
        load: async (): Promise<unknown> => {
          const data: unknown = await this.loadData();
          return data;
        },
        save: async (data) => this.saveData(data),
      }),
    });
    const environmentDirectory = publicationEnvironmentDirectory();
    const download = async (url: string, signal?: AbortSignal): Promise<Uint8Array> => {
      signal?.throwIfAborted();
      const response = await abortable(
        requestUrl({ url, method: 'GET', throw: false }),
        signal,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error('The publication environment download failed.');
      }
      const content = new Uint8Array(response.arrayBuffer);
      if (content.byteLength === 0 || content.byteLength > 64 * 1024 * 1024) {
        throw new Error('The publication environment download exceeded its size limit.');
      }
      signal?.throwIfAborted();
      return content;
    };
    const runtimeStore = new ManagedNodeRuntimeStore({
      rootDirectory: environmentDirectory,
      download,
    });
    const engineStore = new QuartzEngineStore({
      rootDirectory: environmentDirectory,
      download,
      smoke: createQuartzEngineSmoke(join(environmentDirectory, 'smoke')),
    });
    const embeddedRuntime = () => inspectEmbeddedPublicationRuntime({
      nodeExecutable: process.execPath,
      nodeVersion: process.versions.node,
    });
    const publicationEnvironment = new QuartzPublicationEnvironment({
      platform,
      ensureRuntime: async (signal, reportProgress) => await embeddedRuntime()
        ?? asManagedPublicationRuntime(
          await runtimeStore.ensureReady(
            builtinManagedNodeManifest(platform),
            signal,
            reportProgress,
          ),
        ),
      repairRuntime: async (signal, reportProgress) => await embeddedRuntime()
        ?? asManagedPublicationRuntime(
          await runtimeStore.repair(
            builtinManagedNodeManifest(platform),
            signal,
            reportProgress,
          ),
        ),
      ensureEngine: (runtime, signal, reportProgress) => engineStore.ensureReady(
        builtinQuartzEngineManifest(platform),
        runtime,
        signal,
        reportProgress,
      ),
      repairEngine: (runtime, signal, reportProgress) => engineStore.repair(
        builtinQuartzEngineManifest(platform),
        runtime,
        signal,
        reportProgress,
      ),
    });
    const themeStore = new ThemeStore({
      rootDirectory: environmentDirectory,
      smoke: createQuartzThemeSmoke(
        join(environmentDirectory, 'theme-smoke'),
        (signal) => publicationEnvironment.ensureReady(signal),
      ),
    });
    const themeTrustStore = new ThemeTrustStore(environmentDirectory);
    const registryFetch: typeof fetch = async (input, init) => {
      if (typeof input !== 'string') {
        throw new Error('Theme registry requests must use an explicit URL string.');
      }
      init?.signal?.throwIfAborted();
      const response = await abortable(requestUrl({
        url: input,
        method: init?.method ?? 'GET',
        headers: headersRecord(init?.headers),
        throw: false,
      }), init?.signal ?? undefined);
      init?.signal?.throwIfAborted();
      return new Response(response.arrayBuffer, {
        status: response.status,
        headers: response.headers,
      });
    };
    const themeInstaller = new ThemeInstaller(
      themeStore,
      new ThemeRegistryClient(registryFetch),
    );
    const themeManagement = new ThemeManagementService(
      vaultRoot,
      themeStore,
      themeInstaller,
      themeTrustStore,
      (signal) => publicationEnvironment.ensureReady(signal),
    );
    const themeResolver = new InstalledThemeResolver(
      environmentDirectory,
      themeStore,
      themeTrustStore,
    );
    const siteBuilder = new QuartzSiteBuilder({
      environment: publicationEnvironment,
      runner: new QuartzBuildRunner({
        rootDirectory: join(localPluginStateDirectory(vaultRoot), 'quartz'),
        deniedReadRoots: [vaultRoot],
        themeResolver,
      }),
    });
    const cloudflareProjects = new CloudflarePagesProjectApi(
      cloudflareHttp,
      async () => (await cloudflareConnection.getPublishingConnection()).credential,
    );
    const deploymentFacts = new DeploymentFactsCoordinator({
      vaultRoot,
      store: new FileSystemDeploymentStateStore(
        join(localPluginStateDirectory(vaultRoot), 'receipts'),
      ),
    });
    let application!: PagesPublishApplication;
    const oauthCallback = oauthConfig === undefined
      ? undefined
      : new CloudflareOAuthLoopbackServer({
        redirectUri: oauthConfig.redirectUri,
        callback: async (callback) => {
          await completeCloudflareOAuthCallback({
            callback,
            application,
            notify: (message) => new Notice(message),
            openPublishCenter: () => this.openPublishCenter(),
          });
        },
        onCancellation: async ({ state, reason }) => {
          const cancelled = await application.cancelInitialSetupOAuth(state);
          if (cancelled) {
            new Notice(reason === 'invalid_scope'
              ? 'Cloudflare OAuth client 缺少所需权限（memberships.read、page.read、page.write）。请更新 client scopes 后重试。'
              : reason === 'session_unavailable'
                ? 'Cloudflare 浏览器授权会话已丢失。请关闭旧授权页，并从 Obsidian 重新开始授权。'
                : 'Cloudflare 授权已取消，请重新开始授权。');
          }
          return cancelled;
        },
        onTimeout: async () => {
          await application.abandonInitialSetupOAuth();
          new Notice('Cloudflare 授权已超时，请重新开始授权。');
        },
      });
    application = new PagesPublishApplication(
      vaultRoot,
      (url) => {
        void openInSystemBrowser(url).catch(() => {
          new Notice('无法打开系统浏览器。请检查 macOS 默认浏览器设置后重试。');
        });
      },
      {
        scanTimers: {
          set: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clear: (handle) => window.clearTimeout(handle as number),
        },
        setup: new SiteSetupService(vaultRoot, { projects: cloudflareProjects }),
        setupConnection: cloudflareConnection,
        oauthCallback,
        setupEnvironment: publicationEnvironment,
        siteBuilder,
        deploymentAdapter: createVaultCloudflarePagesDeploymentAdapter({
          vaultRoot,
          connection: cloudflareConnection,
          http: cloudflareHttp,
        }),
        deploymentFacts,
        customDomainStatus: createVaultCloudflarePagesDomainStatusInspector({
          vaultRoot,
          connection: cloudflareConnection,
          projectsForCredential: (credential) => new CloudflarePagesProjectApi(
            cloudflareHttp,
            async () => credential,
          ),
        }),
        maintenance: createLocalMaintenanceService({
          directory: maintenanceDirectory,
          pluginVersion: this.manifest.version,
          platform: process.platform,
          adapter: this.app.vault.adapter,
          environment: publicationEnvironment,
          connection: cloudflareConnection,
          diagnosticLog,
          logs: {
            open: async () => openLatestMaintenanceLog({
              workspace: this.app.workspace,
            }),
          },
        }),
        diagnosticLog,
      },
    );
    this.register(() => {
      void oauthCallback?.stop().catch(() => undefined);
    });
    const recoveryInspector = new CloudflarePagesDeploymentInspector({
      vaultRoot,
      connection: cloudflareConnection,
      http: cloudflareHttp,
    });
    // A missing receipt makes this a local read only. If a remote recovery
    // cannot complete, refresh records the guarded reconciliation state.
    void application.recoverPublicationFacts(recoveryInspector).catch(() => {
      void application.hydratePublicationFacts().catch(() => undefined);
    });
    const settingTab = new PagesPublishSettingTab(
      this,
      adapter.getBasePath(),
      application,
      themeManagement,
    );
    this.addSettingTab(settingTab);
    const notifyConfigChange = (file: { path: string }): void => {
      if (file.path === '.publish/site.yml') {
        void settingTab.notifyConfigFileChanged();
      }
    };
    this.registerEvent(this.app.vault.on('create', notifyConfigChange));
    this.registerEvent(this.app.vault.on('modify', notifyConfigChange));
    this.registerEvent(this.app.vault.on('delete', notifyConfigChange));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.path === '.publish/site.yml' || oldPath === '.publish/site.yml') {
          void settingTab.notifyConfigFileChanged();
        }
      }),
    );
    this.register(
      watchSiteConfigChanges(adapter.getBasePath(), () => {
        void settingTab.notifyConfigFileChanged();
        application.notifyFileChange();
      }),
    );

    this.registerView(
      PAGES_PUBLISH_VIEW_TYPE,
      (leaf) => new PagesPublishView(leaf, application),
    );
    this.registerView(
      PAGES_PUBLISH_LOG_VIEW_TYPE,
      (leaf) => new PagesPublishMaintenanceLogView(
        leaf,
        () => diagnosticLog.entries(),
        () => application.exportDiagnostics({ confirmed: true }),
      ),
    );
    this.registerView(
      PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE,
      (leaf) => new PagesPublishSiteConfigRepairView(leaf, vaultRoot),
    );
    this.registerView(
      CURRENT_ARTICLE_VIEW_TYPE,
      (leaf) =>
        new CurrentArticleView(leaf, application, () =>
          this.openPublishCenter(),
        ),
    );
    const openArticlePanel = pagesPublishAction('open-current-article-panel');
    this.addCommand({
      id: openArticlePanel.id,
      name: openArticlePanel.name,
      callback: () => {
        void this.openCurrentArticlePanel();
      },
    });
    const previewCurrentArticle = pagesPublishAction('preview-current-article');
    this.addCommand({
      id: previewCurrentArticle.id,
      name: previewCurrentArticle.name,
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.previewArticle(application, file.path);
        return true;
      },
    });
    const previewSite = pagesPublishAction('preview-site');
    this.addCommand({
      id: previewSite.id,
      name: previewSite.name,
      callback: () => {
        void this.previewSite(application);
      },
    });
    const changeVisibility = pagesPublishAction('change-current-article-visibility');
    this.addCommand({
      id: changeVisibility.id,
      name: changeVisibility.name,
      checkCallback: (checking) => {
        if (!this.activeMarkdownFile()) return false;
        if (!checking) void this.openCurrentArticlePanel();
        return true;
      },
    });
    const openOnlinePage = pagesPublishAction('open-current-article-online-page');
    this.addCommand({
      id: openOnlinePage.id,
      name: openOnlinePage.name,
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openArticleOnlinePage(application, file.path);
        return true;
      },
    });
    const openSettings = pagesPublishAction('open-plugin-settings');
    this.addCommand({
      id: openSettings.id,
      name: openSettings.name,
      callback: () => this.openPluginSettings(),
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
          return;
        }
        // Obsidian's public MenuItem API has no submenu primitive. A labelled
        // section preserves the Pages Publish grouping without relying on DOM
        // internals that would make the menu brittle across desktop releases.
        menu.addItem((item) => item.setTitle('Pages Publish').setIsLabel(true));
        menu.addItem((item) =>
          item
            .setTitle(pagesPublishAction('open-article-panel').name)
            .setIcon('file-up')
            .onClick(() => {
              void this.openArticlePanelFor(file.path);
            }),
        );
        let visibilityItem: MenuItem | undefined;
        let previewItem: MenuItem | undefined;
        let onlineItem: MenuItem | undefined;
        menu.addItem((item) =>
          (visibilityItem = item)
            .setTitle('更改可见性…（正在检查）')
            .setIcon('eye')
            .setDisabled(true)
            .onClick(() => {
              void this.openArticlePanelFor(file.path);
            }),
        );
        menu.addItem((item) =>
          (previewItem = item)
            .setTitle('预览文章（正在检查）')
            .setIcon('monitor-play')
            .setDisabled(true)
            .onClick(() => {
              void this.previewArticle(application, file.path);
            }),
        );
        menu.addItem((item) =>
          (onlineItem = item)
            .setTitle('打开线上页面（正在检查）')
            .setIcon('external-link')
            .setDisabled(true)
            .onClick(() => {
              void this.openArticleOnlinePage(application, file.path);
            }),
        );
        void application.getCurrentArticlePanel({ pinnedPath: file.path }).then((state) => {
          const article = state.status === 'article' ? state : undefined;
          const onlineUrl = article?.route.onlineUrl
            ?? (state.status === 'out-of-scope-online' ? state.onlineUrl : undefined);
          const availability = articleMenuAvailability({
            article: article !== undefined,
            environmentReady: application.getInitialSetupEnvironment().stage === 'ready',
            onlineUrl,
          });
          setMenuAvailability(
            visibilityItem,
            pagesPublishAction('change-visibility').name,
            availability.visibility,
          );
          setMenuAvailability(
            previewItem,
            pagesPublishAction('preview-article').name,
            availability.preview,
          );
          setMenuAvailability(
            onlineItem,
            pagesPublishAction('open-online-page').name,
            availability.online,
          );
        }).catch(() => {
          const unavailable = { enabled: false as const, reason: '无法读取当前文章状态' };
          setMenuAvailability(
            visibilityItem,
            pagesPublishAction('change-visibility').name,
            unavailable,
          );
          setMenuAvailability(
            previewItem,
            pagesPublishAction('preview-article').name,
            unavailable,
          );
          setMenuAvailability(
            onlineItem,
            pagesPublishAction('open-online-page').name,
            unavailable,
          );
        });
      }),
    );
    this.activation = activatePagesPublish(
      application,
      new ObsidianPagesPublishHost(this),
    );
  }

  onunload(): void {
    void this.activation?.dispose();
  }

  private async openCurrentArticlePanel(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice('无法创建右侧边栏，请检查当前工作区布局。');
      return;
    }
    await leaf.setViewState({
      type: CURRENT_ARTICLE_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async openArticlePanelFor(sourcePath: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(sourcePath, '', false);
      await this.openCurrentArticlePanel();
    } catch (error) {
      new Notice(`无法打开当前文章面板：${errorMessage(error)}`);
    }
  }

  private async openPublishCenter(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PAGES_PUBLISH_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) {
      await leaf.setViewState({
        type: PAGES_PUBLISH_VIEW_TYPE,
        active: true,
      });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveFile();
    return file?.extension.toLowerCase() === 'md' ? file : undefined;
  }

  private async previewArticle(
    application: PagesPublishApplication,
    sourcePath: string,
  ): Promise<void> {
    try {
      await application.openArticlePreview(sourcePath);
      new Notice('本地预览已打开；没有发布线上内容。');
    } catch (error) {
      new Notice(`无法打开当前文章预览：${errorMessage(error)}`);
    }
  }

  private async previewSite(application: PagesPublishApplication): Promise<void> {
    try {
      await application.openPreview();
      new Notice('本地预览已打开；没有发布线上内容。');
    } catch (error) {
      new Notice(`无法打开本地预览：${errorMessage(error)}`);
    }
  }

  private async openArticleOnlinePage(
    application: PagesPublishApplication,
    sourcePath: string,
  ): Promise<void> {
    try {
      await application.openArticleOnlinePage(sourcePath);
    } catch (error) {
      new Notice(`无法读取当前文章的线上页面：${errorMessage(error)}`);
    }
  }

  private openPluginSettings(): void {
    if (!openPluginSettingsInHost(this.app, this.manifest.id)) {
      new Notice('请在 Obsidian 设置中打开此插件的设置。');
    }
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortError(): DOMException {
  return new DOMException('The publication environment download was aborted.', 'AbortError');
}

function headersRecord(input?: HeadersInit): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const record: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误。';
}

function setMenuAvailability(
  item: MenuItem | undefined,
  label: string,
  state: { enabled: true } | { enabled: false; reason: string },
): void {
  item
    ?.setDisabled(!state.enabled)
    .setTitle(state.enabled ? label : `${label}（${state.reason}）`);
}
