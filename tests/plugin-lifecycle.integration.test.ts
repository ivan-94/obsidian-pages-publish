import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(host.disposedRegistrations).toBe(2);
    expect(host.vaultChange).toBeUndefined();
  });

  it('starts a configured vault scan when the plugin activates', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    await mkdir(join(vault, '.publish'), { recursive: true });
    await writeFile(join(vault, '.publish', 'site.yml'), 'configured', 'utf8');
    const scan = vi.fn(async () => ({
      configRevision: 'config',
      digest: 'scan',
      candidates: [],
      issues: [],
    }));
    const application = new PagesPublishApplication(vault, undefined, { scan });
    const host = new RecordingHost();

    const activation = activatePagesPublish(application, host);

    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'plugin-load' }),
      );
    });
    await activation.dispose();
  });

  it('debounces vault file events through the application scanner', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-plugin-'));
    vaults.push(vault);
    const scan = vi.fn(async () => ({
      configRevision: 'config',
      digest: 'scan',
      candidates: [],
      issues: [],
    }));
    const application = new PagesPublishApplication(vault, undefined, {
      scan,
      scanDebounceMs: 0,
    });
    const host = new RecordingHost();
    const activation = activatePagesPublish(application, host);

    host.emitVaultChange();

    await vi.waitFor(() => {
      expect(scan).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'file-change' }),
      );
    });
    await activation.dispose();
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
  vaultChange: (() => void) | undefined;

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

  registerVaultChanges(callback: () => void): () => void {
    this.vaultChange = callback;
    return () => {
      this.vaultChange = undefined;
      this.disposedRegistrations += 1;
    };
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

  emitVaultChange(): void {
    this.vaultChange?.();
  }
}
