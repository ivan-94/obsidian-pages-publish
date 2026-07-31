import { scanSiteFromDirectory, type SiteScanResult } from '../content/site-scanner';
import {
  loadSiteConfigFromDirectory,
  readSiteConfigSourceFromDirectory,
  saveSiteConfigToDirectory,
  type EditableSiteConfig,
  type SiteConfigV1,
} from './site-config';

export interface SiteConfigEditorState {
  status: 'clean' | 'dirty' | 'conflict';
  canSave: boolean;
  draft: SiteConfigV1;
  revision: string;
  comparison?: {
    currentSource: string;
    draft: SiteConfigV1;
  };
}

export interface SiteConfigSaveInput {
  draft: SiteConfigV1;
  expectedRevision: string;
}

export class SiteConfigEditorSession {
  private draft: SiteConfigV1;
  private revision: string;
  private dirty = false;
  private comparison?: SiteConfigEditorState['comparison'];

  private constructor(
    private readonly vaultRoot: string,
    loaded: EditableSiteConfig,
  ) {
    this.draft = structuredClone(loaded.config);
    this.revision = loaded.revision;
  }

  static async open(vaultRoot: string): Promise<SiteConfigEditorSession> {
    const loaded = await loadSiteConfigFromDirectory(vaultRoot);
    if (loaded.status !== 'editable') {
      throw new Error(`Site config version ${loaded.version} is read-only.`);
    }
    return new SiteConfigEditorSession(vaultRoot, loaded);
  }

  update(change: (draft: SiteConfigV1) => void): SiteConfigEditorState {
    change(this.draft);
    this.dirty = true;
    return this.getState();
  }

  async detectExternalChange(): Promise<SiteConfigEditorState> {
    let currentSource;
    try {
      currentSource = await readSiteConfigSourceFromDirectory(this.vaultRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      currentSource = { source: '', revision: 'missing' };
    }
    if (currentSource.revision === this.revision) return this.getState();
    if (this.dirty || currentSource.revision === 'missing') {
      this.comparison = {
        currentSource: currentSource.source,
        draft: structuredClone(this.draft),
      };
      return this.getState();
    }
    try {
      const current = await loadSiteConfigFromDirectory(this.vaultRoot);
      if (current.status !== 'editable') {
        this.comparison = {
          currentSource: current.source,
          draft: structuredClone(this.draft),
        };
        return this.getState();
      }
      this.replaceWith(current);
    } catch {
      this.comparison = {
        currentSource: currentSource.source,
        draft: structuredClone(this.draft),
      };
    }
    return this.getState();
  }

  async reloadExternal(): Promise<SiteConfigEditorState> {
    const current = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (current.status !== 'editable') {
      throw new Error(`Site config version ${current.version} is read-only.`);
    }
    this.replaceWith(current);
    return this.getState();
  }

  getState(): SiteConfigEditorState {
    return {
      status: this.comparison ? 'conflict' : this.dirty ? 'dirty' : 'clean',
      canSave: this.comparison === undefined,
      draft: structuredClone(this.draft),
      revision: this.revision,
      ...(this.comparison === undefined
        ? {}
        : { comparison: structuredClone(this.comparison) }),
    };
  }

  getSaveInput(): SiteConfigSaveInput {
    if (this.comparison) {
      throw new Error('Resolve the external site config conflict before saving.');
    }
    return {
      draft: structuredClone(this.draft),
      expectedRevision: this.revision,
    };
  }

  private replaceWith(loaded: EditableSiteConfig): void {
    this.draft = structuredClone(loaded.config);
    this.revision = loaded.revision;
    this.dirty = false;
    this.comparison = undefined;
  }
}

export class SiteSettingsService<TScan = SiteScanResult> {
  private readonly scan: () => Promise<TScan>;

  constructor(
    private readonly vaultRoot: string,
    dependencies?: { scan?: () => Promise<TScan> },
  ) {
    this.scan =
      dependencies?.scan ??
      (async () => (await scanSiteFromDirectory(vaultRoot)) as TScan);
  }

  async save(
    draft: SiteConfigV1,
    expectedRevision: string,
  ): Promise<{ saved: EditableSiteConfig; scan: TScan }> {
    const saved = await saveSiteConfigToDirectory(this.vaultRoot, draft, {
      expectedRevision,
    });
    const scan = await this.scan();
    return { saved, scan };
  }
}
