import {
  PagesPublishApplication,
  type LaunchTarget,
} from '../application';

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
  openWorkspace(target: LaunchTarget): Promise<void>;
}

export interface PagesPublishActivation {
  dispose(): Promise<void>;
}

export function activatePagesPublish(
  application: PagesPublishApplication,
  host: PagesPublishHost,
): PagesPublishActivation {
  const openPrimarySurface = async (): Promise<void> => {
    await host.openWorkspace(await application.getLaunchTarget());
  };
  const unregister = [
    host.registerRibbon('cloud-upload', '打开发布中心', openPrimarySurface),
    host.registerCommand(
      'open-publish-center',
      '打开发布中心',
      openPrimarySurface,
    ),
  ];

  return {
    async dispose(): Promise<void> {
      for (const unregisterEntry of unregister.reverse()) {
        unregisterEntry();
      }
      await application.shutdown();
    },
  };
}
