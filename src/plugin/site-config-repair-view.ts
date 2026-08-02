import { ButtonComponent, ItemView, Notice, type Workspace, type WorkspaceLeaf } from 'obsidian';
import { readSiteConfigSourceFromDirectory, saveSiteConfigToDirectory, validateSiteConfigSourceForDirectory } from '../config/site-config';

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
    container.createEl('h2', { text: '站点配置' });
    container.createEl('p', { text: '.publish/site.yml 位于隐藏目录，Obsidian 不能把它作为普通 Vault 文件打开。请在此修复、验证并保存；保存不会发布。' });
    try {
      let { source, revision } = await readSiteConfigSourceFromDirectory(this.vaultRoot);
      const editor = container.createEl('textarea', { cls: 'pages-publish-config-repair__editor' });
      editor.setAttr('aria-label', '站点配置 YAML 修复编辑器');
      editor.value = source;
      let draftSource = source;
      editor.addEventListener('input', () => {
        draftSource = editor.value;
      });
      new ButtonComponent(container).setButtonText('验证并保存修复').setCta().onClick(async () => {
        try {
          const config = await validateSiteConfigSourceForDirectory(this.vaultRoot, draftSource);
          const saved = await saveSiteConfigToDirectory(this.vaultRoot, config, {
            expectedRevision: revision,
            sourceOverride: draftSource,
          });
          source = saved.source;
          revision = saved.revision;
          draftSource = source;
          editor.value = source;
          new Notice('站点配置已修复并保存；没有发布。请回到设置页重新载入。');
        } catch (error) {
          new Notice(`无法保存修复：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });
      new ButtonComponent(container).setButtonText('重新读取当前配置').onClick(async () => {
        try {
          const current = await readSiteConfigSourceFromDirectory(this.vaultRoot);
          const latest = container.createEl('details');
          latest.createEl('summary', { text: '当前磁盘配置（草稿仍保留在编辑器中）' });
          latest.createEl('pre', { text: current.source });
        } catch (error) {
          new Notice(`无法重新读取配置：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });
      new ButtonComponent(container).setButtonText('载入当前配置并放弃修复草稿').onClick(async () => {
        try {
          const current = await readSiteConfigSourceFromDirectory(this.vaultRoot);
          source = current.source;
          revision = current.revision;
          draftSource = source;
          editor.value = source;
          new Notice('已载入当前配置；此前修复草稿已放弃。');
        } catch (error) {
          new Notice(`无法载入当前配置：${error instanceof Error ? error.message : '未知错误'}`);
        }
      });
    } catch (error) {
      container.createEl('p', { cls: 'pages-publish-view__error', text: `无法读取 .publish/site.yml：${error instanceof Error ? error.message : '未知错误'}` });
    }
  }
}
