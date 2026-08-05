import { ItemView, Notice, type Workspace, type WorkspaceLeaf } from 'obsidian';
import {
  SiteConfigValidationError,
  readSiteConfigSourceFromDirectory,
  saveSiteConfigToDirectory,
  validateSiteConfigSourceForDirectory,
} from '../config/site-config';
import { openConfirmationModal } from '../ui/obsidian/open-confirmation-modal';
import { mountPreactView, type MountedPreactView } from '../ui/runtime/mount-preact-view';
import {
  ConfigRepairScreen,
  type ConfigRepairScreenState,
  type ConfigValidationState,
} from '../ui/config-repair/config-repair-screen';

export const PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE = 'pages-publish-config-repair';

export async function openSiteConfigForRepair(input: {
  workspace: Pick<Workspace, 'getLeaf' | 'revealLeaf'>;
}): Promise<void> {
  const leaf = input.workspace.getLeaf('tab');
  await leaf.setViewState({ type: PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE, active: true });
  await input.workspace.revealLeaf(leaf);
}

/** Repairs hidden configuration through the existing no-symlink atomic transaction. */
export class PagesPublishSiteConfigRepairView extends ItemView {
  private mounted: MountedPreactView<{ state: ConfigRepairScreenState }> | undefined;
  private source = '';
  private draftSource = '';
  private revision = '';
  private diskSource: string | undefined;
  private busy = false;
  private validation: ConfigValidationState = neutralValidation();

  constructor(leaf: WorkspaceLeaf, private readonly vaultRoot: string) { super(leaf); }
  getViewType(): string { return PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE; }
  getDisplayText(): string { return 'Pages Publish 配置修复'; }
  getIcon(): string { return 'file-warning'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('pages-publish-view');
    this.mounted = mountPreactView(
      this.contentEl,
      ({ state }) => <ConfigRepairScreen state={state} />,
      { state: { status: 'loading' } },
    );
    await this.loadCurrent();
  }

  async onClose(): Promise<void> {
    this.mounted?.unmount();
    this.mounted = undefined;
    this.contentEl.removeClass('pages-publish-view');
  }

  private async loadCurrent(): Promise<void> {
    this.update({ status: 'loading' });
    try {
      const current = await readSiteConfigSourceFromDirectory(this.vaultRoot);
      this.source = current.source;
      this.draftSource = current.source;
      this.revision = current.revision;
      this.diskSource = undefined;
      this.validation = neutralValidation();
      this.refreshReady();
    } catch (error) {
      this.update({
        status: 'error',
        message: errorMessage(error),
        onRetry: () => this.loadCurrent(),
      });
    }
  }

  private refreshReady(): void {
    this.update({
      status: 'ready',
      draftSource: this.draftSource,
      diskSource: this.diskSource,
      dirty: this.draftSource !== this.source,
      busy: this.busy,
      validation: this.validation,
      onDraftChange: (source) => {
        this.draftSource = source;
        this.validation = {
          title: '草稿已修改，尚未校验',
          detail: '保存前会执行完整配置校验。',
          issues: [],
          tone: 'warning',
        };
        this.refreshReady();
      },
      onReadDisk: () => this.readDiskVersion(),
      onDiscard: () => this.discardDraft(),
      onSave: () => this.saveDraft(),
    });
  }

  private update(state: ConfigRepairScreenState): void {
    this.mounted?.update({ state });
  }

  private async readDiskVersion(): Promise<void> {
    try {
      this.diskSource = (await readSiteConfigSourceFromDirectory(this.vaultRoot)).source;
      this.refreshReady();
    } catch (error) {
      new Notice(`无法重新读取配置：${errorMessage(error)}`);
    }
  }

  private async discardDraft(): Promise<void> {
    const confirmed = await openConfirmationModal(this.app, {
      eyebrow: '未保存草稿',
      title: '放弃当前修复草稿？',
      description: '将重新读取磁盘配置。原文件、备份与线上站点都不会被修改。',
      facts: [
        { label: '不会改变', value: '磁盘配置、备份与线上站点', tone: 'success' },
        { label: '会放弃', value: '当前未保存的修复草稿', tone: 'danger' },
      ],
      cancelLabel: '继续编辑',
      confirmLabel: '放弃并重新读取',
      confirmTone: 'destructive',
    });
    if (!confirmed) return;
    await this.loadCurrent();
    new Notice('已放弃修复草稿并重新载入磁盘配置。');
  }

  private async saveDraft(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.validation = {
      title: '正在验证',
      detail: '验证通过后将以原子事务保存；不会发布。',
      issues: [],
      tone: 'neutral',
    };
    this.refreshReady();
    try {
      const config = await validateSiteConfigSourceForDirectory(this.vaultRoot, this.draftSource);
      const saved = await saveSiteConfigToDirectory(this.vaultRoot, config, {
        expectedRevision: this.revision,
        sourceOverride: this.draftSource,
      });
      this.source = saved.source;
      this.draftSource = saved.source;
      this.revision = saved.revision;
      this.validation = {
        title: '校验通过 · 修复已保存',
        detail: '配置已安全写入；没有触发预览、上传或发布。',
        issues: [],
        tone: 'success',
      };
      new Notice('站点配置已修复并保存；没有发布。请回到设置页重新载入。');
    } catch (error) {
      const issues = validationIssues(error);
      this.validation = {
        title: `${issues.length} 个校验或保存问题`,
        detail: errorMessage(error),
        issues,
        tone: 'danger',
      };
      new Notice(`无法保存修复：${errorMessage(error)}`);
    } finally {
      this.busy = false;
      this.refreshReady();
    }
  }
}

function neutralValidation(): ConfigValidationState {
  return {
    title: '尚未校验当前草稿',
    detail: '保存前会执行完整配置校验。',
    issues: [],
    tone: 'neutral',
  };
}

function validationIssues(error: unknown): string[] {
  if (error instanceof SiteConfigValidationError) {
    const issues = splitValidationMessages(
      error.issues.map((issue) => `${issue.path}: ${issue.message}`),
    );
    if (issues.length > 0) return issues;
    return splitValidationMessages([error.message]);
  }
  if (error instanceof Error) return splitValidationMessages([error.message]);
  return ['未知错误'];
}

function splitValidationMessages(messages: readonly string[]): string[] {
  return messages.flatMap((message) => message
    .split(/;\s*/)
    .map((issue) => issue.trim())
    .filter(Boolean));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
