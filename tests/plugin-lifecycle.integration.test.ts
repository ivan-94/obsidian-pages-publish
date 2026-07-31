import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PagesPublishApplication } from '../src/application';
import {
  activatePagesPublish,
  type PagesPublishHost,
} from '../src/plugin/lifecycle';

describe('plugin lifecycle', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('routes ribbon and command through the same launch target and disposes registrations', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    const application = new PagesPublishApplication(vault);
    const host = new RecordingHost();

    const activation = activatePagesPublish(application, host);
    await host.clickRibbon();
    await host.runCommand('open-publish-center');

    expect(host.openedTargets).toEqual(['setup', 'setup']);
    expect(host.ribbon).toMatchObject({
      icon: 'cloud-upload',
      label: '打开发布中心',
    });
    expect(host.command).toMatchObject({
      id: 'open-publish-center',
      name: '打开发布中心',
    });

    await activation.dispose();
    expect(host.disposedRegistrations).toBe(1);
  });
});

class RecordingHost implements PagesPublishHost {
  ribbon:
    | { icon: string; label: string; callback: () => Promise<void> }
    | undefined;
  command:
    | { id: string; name: string; callback: () => Promise<void> }
    | undefined;
  openedTargets: string[] = [];
  disposedRegistrations = 0;

  registerRibbon(
    icon: string,
    label: string,
    callback: () => Promise<void>,
  ): () => void {
    this.ribbon = { icon, label, callback };
    return () => {
      this.disposedRegistrations += 1;
    };
  }

  registerCommand(
    id: string,
    name: string,
    callback: () => Promise<void>,
  ): () => void {
    this.command = { id, name, callback };
    return () => undefined;
  }

  async openWorkspace(target: 'setup' | 'publish-center'): Promise<void> {
    this.openedTargets.push(target);
  }

  async clickRibbon(): Promise<void> {
    await this.ribbon?.callback();
  }

  async runCommand(id: string): Promise<void> {
    if (this.command?.id === id) {
      await this.command.callback();
    }
  }
}
