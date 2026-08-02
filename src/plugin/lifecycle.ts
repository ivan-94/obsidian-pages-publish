import {
  PagesPublishApplication,
  type LaunchTarget,
} from '../application';
import type { GlobalUiProjection, GlobalUiRoute } from './global-ui-state';
import { pagesPublishAction } from './safe-actions';

export interface PagesPublishGlobalFeedback {
  update(presentation: GlobalUiProjection): void;
  dispose(): void;
}

export interface PagesPublishHost {
  registerRibbon(
    icon: string,
    label: string,
    callback: () => Promise<void>,
  ): () => void;
  registerCommand(
    id: string,
    name: string,
    callback: () => Promise<void>,
  ): () => void;
  registerVaultChanges(callback: () => void): () => void;
  openWorkspace(target: LaunchTarget): Promise<void>;
  /** Optional for non-Obsidian hosts used by narrow lifecycle integrations. */
  registerGlobalFeedback?(
    callback: (route: GlobalUiRoute) => Promise<void>,
  ): PagesPublishGlobalFeedback;
}

export interface PagesPublishActivation {
  dispose(): Promise<void>;
}

export function activatePagesPublish(
  application: PagesPublishApplication,
  host: PagesPublishHost,
): PagesPublishActivation {
  const openPrimarySurface = async (): Promise<void> => {
    await host.openWorkspace((await application.getGlobalUiState()).ribbon.route);
  };
  const openGlobalFeedback = (route: GlobalUiRoute): Promise<void> =>
    host.openWorkspace(route);
  const openPublishCenter = pagesPublishAction('open-publish-center');
  const unregister = [
    host.registerRibbon('cloud-upload', '打开发布中心', openPrimarySurface),
    host.registerCommand(
      openPublishCenter.id,
      openPublishCenter.name,
      openPrimarySurface,
    ),
    host.registerVaultChanges(() => application.notifyFileChange()),
  ];
  const feedback = host.registerGlobalFeedback?.(openGlobalFeedback);
  let feedbackRevision = 0;
  const refreshGlobalFeedback = (): void => {
    const revision = ++feedbackRevision;
    void application.getGlobalUiState().then((presentation) => {
      if (revision === feedbackRevision) feedback?.update(presentation);
    }).catch(() => undefined);
  };
  const unsubscribeGlobalUi = application.subscribeGlobalUiState(refreshGlobalFeedback);
  refreshGlobalFeedback();

  return {
    async dispose(): Promise<void> {
      unsubscribeGlobalUi();
      feedback?.dispose();
      for (const unregisterEntry of unregister.reverse()) {
        unregisterEntry();
      }
      await application.shutdown();
    },
  };
}
