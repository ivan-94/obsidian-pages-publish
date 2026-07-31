import { access } from 'fs/promises';
import { join } from 'path';
import {
  prepareLocalPreviewFromDirectory,
  type LocalPreview,
} from './core/preview';
import { LocalPreviewServer, type PreviewSession } from './preview/server';

export type LaunchTarget = 'setup' | 'publish-center';

export class PagesPublishApplication {
  private readonly previewServer = new LocalPreviewServer();

  constructor(
    private readonly vaultRoot: string,
    private readonly openExternal: (url: string) => void = () => undefined,
  ) {}

  async getLaunchTarget(): Promise<LaunchTarget> {
    try {
      await access(join(this.vaultRoot, '.publish', 'site.yml'));
      return 'publish-center';
    } catch {
      return 'setup';
    }
  }

  async openPreview(): Promise<PreviewSession> {
    const preview = await this.preparePreview();
    const session = await this.previewServer.start(preview.files);
    this.openExternal(session.url);
    return session;
  }

  async preparePreview(): Promise<LocalPreview> {
    return prepareLocalPreviewFromDirectory(this.vaultRoot);
  }

  async shutdown(): Promise<void> {
    await this.previewServer.stop();
  }
}
