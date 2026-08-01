import type { Plugin } from 'obsidian';
import type { LaunchTarget } from '../application';
import type {
  PagesPublishGlobalFeedback,
  PagesPublishHost,
} from './lifecycle';
import type { GlobalUiProjection, GlobalUiRoute } from './global-ui-state';
import { PAGES_PUBLISH_VIEW_TYPE } from './view';

export class ObsidianPagesPublishHost implements PagesPublishHost {
  private ribbonElement: HTMLElement | undefined;

  constructor(private readonly plugin: Plugin) {}

  registerRibbon(
    icon: string,
    label: string,
    callback: () => Promise<void>,
  ): () => void {
    const element = this.plugin.addRibbonIcon(icon, label, () => {
      void callback();
    });
    this.ribbonElement = element;
    return () => element.remove();
  }

  registerCommand(
    id: string,
    name: string,
    callback: () => Promise<void>,
  ): () => void {
    this.plugin.addCommand({
      id,
      name,
      callback: () => {
        void callback();
      },
    });
    return () => undefined;
  }

  registerVaultChanges(callback: () => void): () => void {
    const vault = this.plugin.app.vault;
    const references = [
      vault.on('create', callback),
      vault.on('modify', callback),
      vault.on('delete', callback),
      vault.on('rename', callback),
    ];
    return () => {
      for (const reference of references) vault.offref(reference);
    };
  }

  registerGlobalFeedback(
    callback: (route: GlobalUiRoute) => Promise<void>,
  ): PagesPublishGlobalFeedback {
    const item = this.plugin.addStatusBarItem();
    let route: GlobalUiRoute = 'publish-center';
    item.addClass('pages-publish-status-bar');
    item.addEventListener('click', () => {
      void callback(route);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void callback(route);
    });
    return {
      update: (presentation) => {
        route = presentation.statusBar?.route ?? presentation.ribbon.route;
        this.updateGlobalFeedback(item, presentation);
      },
      dispose: () => item.remove(),
    };
  }

  async openWorkspace(target: LaunchTarget): Promise<void> {
    const leaf = this.plugin.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: PAGES_PUBLISH_VIEW_TYPE,
      active: true,
      state: { target },
    });
    await this.plugin.app.workspace.revealLeaf(leaf);
  }

  private updateGlobalFeedback(
    item: HTMLElement,
    presentation: GlobalUiProjection,
  ): void {
    this.ribbonElement?.setAttr('aria-label', presentation.ribbon.tooltip);
    this.ribbonElement?.setAttr('data-tooltip', presentation.ribbon.tooltip);
    this.ribbonElement?.setAttr('title', presentation.ribbon.tooltip);
    const status = presentation.statusBar;
    item.empty();
    if (!status) {
      item.addClass('is-hidden');
      item.removeAttribute('aria-label');
      item.removeAttribute('role');
      item.removeAttribute('tabindex');
      return;
    }
    item.removeClass('is-hidden');
    item.setAttr(
      'aria-label',
      `${status.text}；${status.route === 'setup' ? '打开首次设置' : '打开发布中心'}`,
    );
    item.setAttr('role', 'button');
    item.setAttr('tabindex', '0');
    item.createSpan({ text: status.text, attr: { 'aria-live': 'polite' } });
  }
}
