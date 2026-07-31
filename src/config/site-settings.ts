import { createHash } from 'crypto';
import { scanSiteFromDirectory, type SiteScanResult } from '../content/site-scanner';
import {
  loadSiteConfigFromDirectory,
  readSiteConfigSourceFromDirectory,
  saveSiteConfigToDirectory,
  SiteConfigConflictError,
  validateSiteConfigForDirectory,
  type EditableSiteConfig,
  type SiteConfigV1,
} from './site-config';
import {
  commitArticleIntentEditToDirectory,
  prepareArticleIntentEditFromDirectory,
  readArticleSnapshotFromDirectory,
  restoreArticleSourceToDirectory,
  type PreparedArticleIntentEdit,
  type PreparedArticleSourceRestore,
} from '../publication/article-metadata';
import { loadDirectoryRouteSources } from '../routing/directory-route-sources';
import {
  normalizeRouteUrlPath,
  planSiteRoutes,
  RoutePlanningError,
} from '../routing/route-planner';

export interface SiteUrlChange {
  sourcePath: string;
  onlineUrl: string;
  pendingUrl: string;
}

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
  private readonly commitArticleIntent: typeof commitArticleIntentEditToDirectory;
  private readonly afterArticleCommits?: () => Promise<void>;
  private readonly afterMigrationSnapshot?: (sourcePath: string) => Promise<void>;

  constructor(
    private readonly vaultRoot: string,
    dependencies?: {
      scan?: () => Promise<TScan>;
      commitArticleIntent?: typeof commitArticleIntentEditToDirectory;
      afterArticleCommits?: () => Promise<void>;
      afterMigrationSnapshot?: (sourcePath: string) => Promise<void>;
    },
  ) {
    this.scan =
      dependencies?.scan ??
      (async () => (await scanSiteFromDirectory(vaultRoot)) as TScan);
    this.commitArticleIntent =
      dependencies?.commitArticleIntent ?? commitArticleIntentEditToDirectory;
    this.afterArticleCommits = dependencies?.afterArticleCommits;
    this.afterMigrationSnapshot = dependencies?.afterMigrationSnapshot;
  }

  async save(
    draft: SiteConfigV1,
    expectedRevision: string,
  ): Promise<{
    saved: EditableSiteConfig;
    scan: TScan;
    urlChanges: SiteUrlChange[];
  }> {
    await validateSiteConfigForDirectory(this.vaultRoot, draft);
    const current = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (current.status !== 'editable') {
      throw new Error(`Site config version ${current.version} is read-only.`);
    }
    if (current.revision !== expectedRevision) {
      throw new SiteConfigConflictError(
        expectedRevision,
        current.revision,
        current.source,
        draft,
      );
    }
    const urlChanges = await this.previewUrlChanges(draft);
    const migrations: Array<{
      forward: PreparedArticleIntentEdit;
      rollback: PreparedArticleSourceRestore;
    }> = [];
    for (const change of urlChanges) {
      const snapshot = await readArticleSnapshotFromDirectory(
        this.vaultRoot,
        change.sourcePath,
      );
      const metadata = snapshot.metadata;
      const redirects = [
        ...new Set([
          ...metadata.redirects.value
            .map((redirect) => normalizeRouteUrlPath(redirect))
            .filter((redirect): redirect is string => redirect !== undefined),
          change.onlineUrl,
        ]),
      ];
      if (arraysEqual(metadata.redirects.value, redirects)) continue;
      await this.afterMigrationSnapshot?.(change.sourcePath);
      const forward = await prepareArticleIntentEditFromDirectory(
        this.vaultRoot,
        change.sourcePath,
        {
          redirects,
        },
      );
      if (snapshot.revision !== forward.expectedRevision) {
        throw new Error(
          `Article changed while preparing URL migration: ${change.sourcePath}`,
        );
      }
      migrations.push({
        forward,
        rollback: {
          sourcePath: change.sourcePath,
          expectedRevision: createHash('sha256')
            .update(forward.sourcePreview)
            .digest('hex'),
          source: snapshot.source,
        },
      });
    }
    const saved = await saveSiteConfigToDirectory(this.vaultRoot, draft, {
      expectedRevision,
      afterVerify: () => this.commitArticleRedirects(migrations),
    });
    const scan = await this.scan();
    return { saved, scan, urlChanges };
  }

  private async commitArticleRedirects(
    migrations: Array<{
      forward: PreparedArticleIntentEdit;
      rollback: PreparedArticleSourceRestore;
    }>,
  ): Promise<() => Promise<void>> {
    const rollbacks: PreparedArticleSourceRestore[] = [];
    try {
      for (const migration of migrations) {
        await this.commitArticleIntent(this.vaultRoot, migration.forward);
        rollbacks.push(migration.rollback);
      }
      await this.afterArticleCommits?.();
      for (const rollback of rollbacks) {
        const current = await readArticleSnapshotFromDirectory(
          this.vaultRoot,
          rollback.sourcePath,
        );
        if (current.revision !== rollback.expectedRevision) {
          throw new Error(
            `Article changed after URL migration: ${rollback.sourcePath}`,
          );
        }
      }
    } catch (error) {
      await this.rollbackArticleRedirects(rollbacks, error);
    }
    return () => this.rollbackArticleRedirects(rollbacks);
  }

  private async rollbackArticleRedirects(
    rollbacks: PreparedArticleSourceRestore[],
    originalError?: unknown,
  ): Promise<void> {
    const rollbackErrors: unknown[] = [];
    for (const rollback of [...rollbacks].reverse()) {
      try {
        await restoreArticleSourceToDirectory(this.vaultRoot, rollback);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...rollbackErrors].filter(
          (error) => error !== undefined,
        ),
        'URL migration failed and article rollback was incomplete.',
      );
    }
    if (originalError !== undefined) {
      throw originalError instanceof Error
        ? originalError
        : new Error('URL migration failed.');
    }
  }

  async previewUrlChanges(draft: SiteConfigV1): Promise<SiteUrlChange[]> {
    const current = await loadSiteConfigFromDirectory(this.vaultRoot);
    if (current.status !== 'editable') {
      throw new Error(`Site config version ${current.version} is read-only.`);
    }
    if (!routingConfigChanged(current.config, draft)) {
      return [];
    }
    await validateSiteConfigForDirectory(this.vaultRoot, draft);
    const { inputs } = await loadDirectoryRouteSources(
      this.vaultRoot,
      draft,
    );
    const plan = planSiteRoutes(draft, inputs);
    const blockers = plan.issues.filter((issue) => issue.severity === 'blocker');
    if (blockers.length > 0) throw new RoutePlanningError(blockers);
    const changes: SiteUrlChange[] = [];
    for (const input of inputs) {
      const onlineUrl = normalizeOnlineUrl(input.onlineUrl);
      const pendingUrl = plan.articles.find(
        (article) => article.sourcePath === input.sourcePath,
      )?.url;
      if (!onlineUrl || !pendingUrl || onlineUrl === pendingUrl) continue;
      changes.push({ sourcePath: input.sourcePath, onlineUrl, pendingUrl });
    }
    changes.sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
    const proposedInputs = inputs.map((input) => {
      const change = changes.find(
        (candidate) => candidate.sourcePath === input.sourcePath,
      );
      return change
        ? {
            ...input,
            redirects: [...new Set([...input.redirects, change.onlineUrl])],
          }
        : input;
    });
    const proposedPlan = planSiteRoutes(draft, proposedInputs);
    const proposedBlockers = proposedPlan.issues.filter(
      (issue) => issue.severity === 'blocker',
    );
    if (proposedBlockers.length > 0) {
      throw new RoutePlanningError(proposedBlockers);
    }
    return changes;
  }
}

function routingConfigChanged(current: SiteConfigV1, draft: SiteConfigV1): boolean {
  return (
    JSON.stringify(current.contentRoots) !== JSON.stringify(draft.contentRoots) ||
    current.features.search !== draft.features.search ||
    current.features.graph !== draft.features.graph
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeOnlineUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/')) return normalizeRouteUrlPath(value);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return normalizeRouteUrlPath(parsed.pathname);
  } catch {
    return undefined;
  }
}
