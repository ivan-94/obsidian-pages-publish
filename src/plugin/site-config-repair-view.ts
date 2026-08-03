import { ButtonComponent, ItemView, Notice, type Workspace, type WorkspaceLeaf } from 'obsidian';
import {
  SiteConfigValidationError,
  readSiteConfigSourceFromDirectory,
  saveSiteConfigToDirectory,
  validateSiteConfigSourceForDirectory,
} from '../config/site-config';

export const PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE = 'pages-publish-config-repair';

export async function openSiteConfigForRepair(input: {
  workspace: Pick<Workspace, 'getLeaf' | 'revealLeaf'>;
}): Promise<void> {
  const leaf = input.workspace.getLeaf('tab');
  await leaf.setViewState({ type: PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE, active: true });
  await input.workspace.revealLeaf(leaf);
}

/** Repairs hidden configuration through the existing no-symlink atomic config transaction. */
export class PagesPublishSiteConfigRepairView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly vaultRoot: string) { super(leaf); }
  getViewType(): string { return PAGES_PUBLISH_CONFIG_REPAIR_VIEW_TYPE; }
  getDisplayText(): string { return 'Pages Publish 配置修复'; }
  getIcon(): string { return 'file-warning'; }
  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('pages-publish-view');
    const header = container.createEl('header', { cls: 'pages-publish-utility__header' });
    const heading = header.createDiv({ cls: 'pages-publish-utility__heading' });
    heading.createDiv({ cls: 'pages-publish-view__eyebrow', text: '配置维护' });
    heading.createEl('h2', { text: '站点配置修复' });
    heading.createEl('p', {
      cls: 'pages-publish-view__summary',
      text: '.publish/site.yml 位于隐藏目录；请在此修复、验证并保存，保存不会发布。',
    });
    const validationBadge = header.createDiv({
      cls: 'pages-publish-config-repair__validation-badge',
      text: '尚未校验当前草稿',
    });
    validationBadge.setAttr('role', 'status');

    try {
      let { source, revision } = await readSiteConfigSourceFromDirectory(this.vaultRoot);
      const workbench = container.createEl('main', {
        cls: 'pages-publish-config-repair__workbench',
        attr: { 'aria-label': '站点配置修复工作区' },
      });
      const editorSection = workbench.createEl('section', {
        cls: 'pages-publish-config-repair__editor-section',
        attr: { 'aria-labelledby': 'pages-publish-config-repair-editor-title' },
      });
      const editorShell = editorSection.createDiv({
        cls: 'pages-publish-config-repair__editor-shell',
      });
      const editorLabel = editorShell.createDiv({
        cls: 'pages-publish-config-repair__editor-label',
        text: '配置原文（YAML）· 保存前验证',
      });
      editorLabel.setAttr('id', 'pages-publish-config-repair-editor-title');
      const editorFrame = editorShell.createDiv({
        cls: 'pages-publish-config-repair__editor-frame',
      });
      const lineNumbers = editorFrame.createEl('ol', {
        cls: 'pages-publish-config-repair__line-numbers',
      });
      lineNumbers.setAttr('aria-hidden', 'true');
      const editor = editorFrame.createEl('textarea', {
        cls: 'pages-publish-config-repair__editor',
      });
      editor.setAttr('aria-label', '站点配置 YAML 修复编辑器');
      editor.value = source;
      const renderLineNumbers = (value: string): void => {
        lineNumbers.empty();
        const lineCount = Math.max(1, value.split(/\r\n|\r|\n/).length);
        for (let line = 1; line <= lineCount; line += 1) {
          lineNumbers.createEl('li', { text: String(line) });
        }
      };
      renderLineNumbers(source);
      editor.addEventListener('scroll', () => {
        lineNumbers.style.transform = `translateY(-${editor.scrollTop}px)`;
      });

      let draftSource = source;
      const validation = workbench.createEl('section', {
        cls: 'pages-publish-config-repair__validation',
        attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
      });
      const showValidation = (
        state: 'neutral' | 'success' | 'warning' | 'danger',
        title: string,
        detail?: string,
        issues: readonly string[] = [],
      ): void => {
        validation.setAttr('data-state', state);
        validation.setAttr('role', state === 'danger' ? 'alert' : 'status');
        validation.empty();
        const validationHeading = validation.createDiv({
          cls: 'pages-publish-config-repair__validation-heading',
        });
        validationHeading.createEl('strong', { text: title });
        if (detail) validation.createEl('p', { text: detail });
        const issueList = validation.createEl('ul', {
          cls: 'pages-publish-config-repair__issue-list',
          attr: { 'aria-label': '配置校验问题' },
        });
        if (issues.length === 0) {
          issueList.createEl('li', {
            cls: 'pages-publish-config-repair__issue-list-empty',
            text: state === 'success' ? '未发现配置问题。' : '尚无可显示的校验问题。',
          });
        } else {
          for (const issue of issues) {
            issueList.createEl('li', { text: issue });
          }
        }
        validationBadge.setAttr('data-state', state);
        validationBadge.setText(title);
      };
      showValidation('neutral', '尚未校验当前草稿', '保存前会执行完整配置校验。');
      let discardArmed = false;
      let discardButton: ButtonComponent;
      editor.addEventListener('input', () => {
        draftSource = editor.value;
        renderLineNumbers(draftSource);
        discardArmed = false;
        discardButton?.setButtonText('载入当前配置并放弃修复草稿');
        showValidation('neutral', '草稿已修改，尚未校验', '保存前会执行完整配置校验。');
      });
      const diskSource = workbench.createDiv({
        cls: 'pages-publish-config-repair__disk-source',
      });
      const actions = workbench.createDiv({ cls: 'pages-publish-utility__actions' });
      new ButtonComponent(actions).setIcon('refresh-cw').setButtonText('重新读取当前配置').onClick(async () => {
        try {
          const current = await readSiteConfigSourceFromDirectory(this.vaultRoot);
          diskSource.empty();
          const latest = diskSource.createEl('details', {
            cls: 'pages-publish-config-repair__disk-source-details',
          });
          latest.createEl('summary', { text: '当前磁盘配置（草稿仍保留在编辑器中）' });
          latest.createEl('pre', { text: current.source });
        } catch (error) {
          new Notice(`无法重新读取配置：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });
      discardButton = new ButtonComponent(actions)
        .setButtonText('载入当前配置并放弃修复草稿')
        .setDestructive()
        .onClick(async () => {
          if (!discardArmed) {
            discardArmed = true;
            discardButton.setButtonText('再次点击以放弃修复草稿');
            showValidation('warning', '未保存草稿尚未放弃', '再次点击危险操作按钮才会载入磁盘配置。');
            return;
          }
          try {
            const current = await readSiteConfigSourceFromDirectory(this.vaultRoot);
            source = current.source;
            revision = current.revision;
            draftSource = source;
            editor.value = source;
            renderLineNumbers(source);
            discardArmed = false;
            discardButton.setButtonText('载入当前配置并放弃修复草稿');
            showValidation('success', '已载入磁盘配置', '此前未保存的修复草稿已放弃。');
            new Notice('已载入当前配置；此前修复草稿已放弃。');
          } catch (error) {
            new Notice(`无法载入当前配置：${error instanceof Error ? error.message : '未知错误'}`);
          }
        });
      new ButtonComponent(actions).setButtonText('验证并保存修复').setCta().onClick(async () => {
        try {
          const config = await validateSiteConfigSourceForDirectory(this.vaultRoot, draftSource);
          showValidation('success', '校验通过 · 0 个问题', '正在以原子事务保存修复，不会发布。');
          try {
            const saved = await saveSiteConfigToDirectory(this.vaultRoot, config, {
              expectedRevision: revision,
              sourceOverride: draftSource,
            });
            source = saved.source;
            revision = saved.revision;
            draftSource = source;
            editor.value = source;
            renderLineNumbers(source);
            discardArmed = false;
            discardButton.setButtonText('载入当前配置并放弃修复草稿');
            showValidation('success', '校验通过 · 修复已保存', '配置已安全写入；没有触发预览或发布。');
            new Notice('站点配置已修复并保存；没有发布。请回到设置页重新载入。');
          } catch (error) {
            const message = error instanceof Error ? error.message : '未知错误';
            const issues = validationIssues(error);
            showValidation('danger', `${issues.length} 个保存问题`, message, issues);
            new Notice(`无法保存修复：${message}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '未知错误';
          const issues = validationIssues(error);
          showValidation('danger', `${issues.length} 个校验问题`, message, issues);
          new Notice(`无法保存修复：${message}`);
        }
      });
    } catch (error) {
      container.createEl('p', { cls: 'pages-publish-view__error', text: `无法读取 .publish/site.yml：${error instanceof Error ? error.message : '未知错误'}` });
    }
  }
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
