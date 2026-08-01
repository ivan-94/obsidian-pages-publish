export interface MaintenanceEnvironmentBoundary {
  getStatus(): { stage: string };
  repair(): Promise<{ stage: string }>;
}

export interface RebuildableCacheBoundary {
  clear(): Promise<void>;
}

export interface MaintenanceConnectionBoundary {
  refreshStatus(): Promise<{ state: string }>;
}

export interface MaintenanceLogsBoundary {
  open(): Promise<void>;
}

export interface SafeDiagnosticLogEntry {
  at: string;
  stage: 'scan' | 'build' | 'upload' | 'activate' | 'maintenance';
  code: string;
  counts?: Readonly<Record<string, number>>;
}

export interface DiagnosticErrorSummary {
  stage: SafeDiagnosticLogEntry['stage'];
  code: string;
}

export interface DiagnosticSnapshot {
  pluginVersion: string;
  platform: string;
  config?: unknown;
  logs: readonly SafeDiagnosticLogEntry[];
  error?: DiagnosticErrorSummary;
}

export interface DiagnosticsBoundary {
  collect(): Promise<DiagnosticSnapshot>;
  /** Writes a non-secret, non-content diagnostic document to a user-selected path. */
  write(source: string): Promise<string>;
}

export interface PagesPublishMaintenanceDependencies {
  environment?: MaintenanceEnvironmentBoundary;
  cache: RebuildableCacheBoundary;
  connection?: MaintenanceConnectionBoundary;
  logs?: MaintenanceLogsBoundary;
  retention?: MaintenanceRetentionCoordinator;
  diagnostics: DiagnosticsBoundary;
}

export interface MaintenanceStatus {
  environment: { stage: string };
  cache: { state: 'ready' | 'cleared' };
  connection: { state: string };
  capabilities: {
    repairEnvironment: boolean;
    refreshConnection: boolean;
    openLogs: boolean;
  };
}

/** A bounded, safe-by-construction in-memory log suitable for diagnostics. */
export class BoundedDiagnosticLog {
  private readonly values: SafeDiagnosticLogEntry[] = [];

  constructor(private readonly maxEntries = 200) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer.');
    }
  }

  append(entry: SafeDiagnosticLogEntry): void {
    this.values.push(copySafeLogEntry(entry));
    if (this.values.length > this.maxEntries) {
      this.values.splice(0, this.values.length - this.maxEntries);
    }
  }

  entries(): SafeDiagnosticLogEntry[] {
    return this.values.map(copySafeLogEntry);
  }
}

export class MaintenanceActionUnavailableError extends Error {
  readonly name = 'MaintenanceActionUnavailableError';

  constructor(action: string) {
    super(`${action} is unavailable until the host supplies its local maintenance boundary.`);
  }
}

export interface RetainedArtifact {
  id: string;
  createdAt: string;
  bytes: number;
  /** Pending recovery receipts are safety-critical and must never be pruned. */
  inProgress?: boolean;
}

export interface RetentionTarget {
  list(): Promise<readonly RetainedArtifact[]>;
  remove(id: string): Promise<void>;
}

export class MaintenanceRetentionCoordinator {
  constructor(private readonly dependencies: {
    now?: () => Date;
    policy: { maxAgeMs: number; maxEntries: number; maxBytes: number };
    targets: Record<'logs' | 'builds' | 'receipts', RetentionTarget>;
  }) {}

  async prune(): Promise<Record<'logs' | 'builds' | 'receipts', string[]>> {
    const result: Record<'logs' | 'builds' | 'receipts', string[]> = {
      logs: [], builds: [], receipts: [],
    };
    await Promise.all((Object.keys(this.dependencies.targets) as Array<keyof typeof result>).map(async (kind) => {
      const target = this.dependencies.targets[kind];
      const removed = selectExpiredArtifacts(
        await target.list(),
        this.dependencies.policy,
        (this.dependencies.now ?? (() => new Date()))(),
      );
      for (const artifact of removed) await target.remove(artifact.id);
      result[kind] = removed.map((artifact) => artifact.id);
    }));
    return result;
  }
}

export class MaintenanceConfirmationRequiredError extends Error {
  readonly name = 'MaintenanceConfirmationRequiredError';

  constructor() {
    super('Confirm the diagnostic export after reviewing its included and excluded data.');
  }
}

/**
 * Maintains local, rebuildable publication support data. It intentionally has
 * no ability to view or delete credentials, remote projects, or Vault source.
 */
export class PagesPublishMaintenanceService {
  private status: MaintenanceStatus;

  constructor(private readonly dependencies: PagesPublishMaintenanceDependencies) {
    this.status = {
      environment: dependencies.environment?.getStatus() ?? { stage: 'unavailable' },
      cache: { state: 'ready' },
      connection: { state: 'unchecked' },
      capabilities: {
        repairEnvironment: dependencies.environment !== undefined,
        refreshConnection: dependencies.connection !== undefined,
        openLogs: dependencies.logs !== undefined,
      },
    };
  }

  getStatus(): MaintenanceStatus {
    return {
      environment: { ...this.status.environment },
      cache: { ...this.status.cache },
      connection: { ...this.status.connection },
      capabilities: { ...this.status.capabilities },
    };
  }

  async repairEnvironment(): Promise<void> {
    if (!this.dependencies.environment) throw new MaintenanceActionUnavailableError('Environment repair');
    const result = await this.dependencies.environment.repair();
    this.status = { ...this.status, environment: { stage: result.stage } };
  }

  async clearRebuildableCache(): Promise<void> {
    await this.dependencies.cache.clear();
    await this.dependencies.retention?.prune();
    this.status = { ...this.status, cache: { state: 'cleared' } };
  }

  async pruneRetainedData(): Promise<Record<'logs' | 'builds' | 'receipts', string[]>> {
    if (!this.dependencies.retention) {
      return { logs: [], builds: [], receipts: [] };
    }
    return this.dependencies.retention.prune();
  }

  async refreshConnection(): Promise<void> {
    if (!this.dependencies.connection) throw new MaintenanceActionUnavailableError('Connection refresh');
    const result = await this.dependencies.connection.refreshStatus();
    this.status = { ...this.status, connection: { state: result.state } };
  }

  async openLogs(): Promise<void> {
    if (!this.dependencies.logs) throw new MaintenanceActionUnavailableError('Opening logs');
    await this.dependencies.logs.open();
  }

  describeDiagnosticExport(): {
    included: string[];
    excluded: string[];
  } {
    return {
      included: ['plugin-version', 'platform', 'redacted-config', 'redacted-status', 'safe-logs'],
      excluded: ['credentials', 'authorization-headers', 'article-content', 'private-paths', 'build-output'],
    };
  }

  async exportDiagnostics(
    input: { confirmed?: boolean } = {},
  ): Promise<{ path: string }> {
    if (input.confirmed !== true) throw new MaintenanceConfirmationRequiredError();
    const snapshot = await this.dependencies.diagnostics.collect();
    const source = JSON.stringify({
      schemaVersion: 1,
      pluginVersion: snapshot.pluginVersion,
      platform: snapshot.platform,
      config: summarizeConfig(snapshot.config),
      status: this.getStatus(),
      logs: snapshot.logs.map(copySafeLogEntry),
      ...(snapshot.error === undefined ? {} : { error: copyErrorSummary(snapshot.error) }),
    }, undefined, 2);
    return { path: await this.dependencies.diagnostics.write(source) };
  }
}

function copySafeLogEntry(entry: SafeDiagnosticLogEntry): SafeDiagnosticLogEntry {
  if (!isSafeTimestamp(entry.at) || !isDiagnosticStage(entry.stage) || !isSafeIdentifier(entry.code)) {
    throw new Error('Diagnostic log entries must use safe timestamps, stages, and codes.');
  }
  return {
    at: entry.at,
    stage: entry.stage,
    code: entry.code,
    ...(entry.counts === undefined ? {} : { counts: copyCounts(entry.counts) }),
  };
}

function copyErrorSummary(error: DiagnosticErrorSummary): DiagnosticErrorSummary {
  if (!isDiagnosticStage(error.stage) || !isSafeIdentifier(error.code)) {
    throw new Error('Diagnostic error summaries must use safe stages and codes.');
  }
  return { stage: error.stage, code: error.code };
}

function copyCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts)
    .filter(([key, value]) => isSafeIdentifier(key) && Number.isFinite(value)));
}

function summarizeConfig(value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? value : {};
  const site = isRecord(config.site) ? config.site : {};
  const features = isRecord(config.features) ? config.features : {};
  return {
    hasSiteDescription: typeof site.description === 'string' && site.description.length > 0,
    homeLayout: typeof site.homeLayout === 'string' && isSafeIdentifier(site.homeLayout)
      ? site.homeLayout
      : undefined,
    contentRootCount: Array.isArray(config.contentRoots) ? config.contentRoots.length : 0,
    assetExcludeCount: isRecord(config.assets) && Array.isArray(config.assets.exclude)
      ? config.assets.exclude.length
      : 0,
    features: {
      search: features.search === true,
      graph: features.graph === true,
    },
  };
}

function selectExpiredArtifacts(
  entries: readonly RetainedArtifact[],
  policy: { maxAgeMs: number; maxEntries: number; maxBytes: number },
  now: Date,
): RetainedArtifact[] {
  const keep = entries.filter((entry) => entry.inProgress).map((entry) => entry.id);
  const candidates = entries.filter((entry) => !entry.inProgress)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const remove = candidates.filter((entry) => now.getTime() - Date.parse(entry.createdAt) > policy.maxAgeMs);
  const retained = candidates.filter((entry) => !remove.includes(entry));
  let bytes = entries.filter((entry) => entry.inProgress).reduce((sum, entry) => sum + entry.bytes, 0);
  let retainedCount = entries.filter((entry) => entry.inProgress).length;
  for (const entry of retained) {
    if (retainedCount >= policy.maxEntries || bytes + entry.bytes > policy.maxBytes) {
      remove.push(entry);
    } else {
      retainedCount += 1;
      bytes += entry.bytes;
    }
  }
  return remove.filter((entry) => !keep.includes(entry.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/iu.test(value);
}

function isSafeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function isDiagnosticStage(value: string): value is SafeDiagnosticLogEntry['stage'] {
  return value === 'scan' || value === 'build' || value === 'upload' ||
    value === 'activate' || value === 'maintenance';
}
