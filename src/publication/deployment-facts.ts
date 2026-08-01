import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clearArticleDeploymentFactsToDirectory,
  writeArticleDeploymentFactsToDirectory,
  type PublicationDeploymentFacts,
} from './article-metadata';
import type { PublicationSnapshot } from './publish-center';
import type { PublishBaseline, DeploymentBaselineArticle } from './publish-center';

export interface DeploymentManifestArticle extends DeploymentBaselineArticle {
  title: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
}

export interface DeploymentManifest {
  deploymentId: string;
  deploymentUrl: string;
  scanDigest: string;
  publishedAt: string;
  articles: DeploymentManifestArticle[];
}

export interface DeploymentRecoveryReceipt {
  schemaVersion: 1;
  deployment: {
    deploymentId: string;
    url: string;
    scanDigest: string;
  };
  manifest: DeploymentManifest;
  takedowns: Array<{ sourcePath: string; firstPublishedAt?: string }>;
}

export interface DeploymentStateStore {
  readLatestManifest(): Promise<DeploymentManifest | undefined>;
  writeLatestManifest(manifest: DeploymentManifest): Promise<void>;
  readRecoveryReceipt(): Promise<DeploymentRecoveryReceipt | undefined>;
  writeRecoveryReceipt(receipt: DeploymentRecoveryReceipt): Promise<void>;
  clearRecoveryReceipt(): Promise<void>;
}

export interface FileSystemDeploymentStateStoreOptions {
  /** Injectable only for deterministic durability tests. */
  syncDirectory?: () => Promise<void>;
}

/**
 * Persists only non-secret deployment facts outside the Vault. Writes use a
 * durable replacement so a crash leaves either the old record or a complete
 * new record, never partially written JSON.
 */
export class FileSystemDeploymentStateStore implements DeploymentStateStore {
  private readonly syncDirectory: () => Promise<void>;

  constructor(
    private readonly directory: string,
    options: FileSystemDeploymentStateStoreOptions = {},
  ) {
    this.syncDirectory = options.syncDirectory ?? (() => syncStateDirectory(directory));
  }

  async readLatestManifest(): Promise<DeploymentManifest | undefined> {
    return this.readRecord('latest-deployment.json', parseManifest);
  }

  async writeLatestManifest(manifest: DeploymentManifest): Promise<void> {
    await this.writeRecord('latest-deployment.json', copyManifest(manifest));
  }

  async readRecoveryReceipt(): Promise<DeploymentRecoveryReceipt | undefined> {
    return this.readRecord('deployment-recovery.json', parseReceipt);
  }

  async writeRecoveryReceipt(receipt: DeploymentRecoveryReceipt): Promise<void> {
    await this.writeRecord('deployment-recovery.json', copyReceipt(receipt));
  }

  async clearRecoveryReceipt(): Promise<void> {
    try {
      await unlink(join(this.directory, 'deployment-recovery.json'));
      await this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async readRecord<T>(
    filename: string,
    parse: (value: unknown) => T | undefined,
  ): Promise<T | undefined> {
    let source: string;
    try {
      source = await readFile(join(this.directory, filename), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error('Local deployment state is corrupted; export diagnostics and repair it before publishing.');
    }
    const record = parse(value);
    if (record === undefined) {
      throw new Error('Local deployment state has an unsupported format; export diagnostics and repair it before publishing.');
    }
    return record;
  }

  private async writeRecord(filename: string, value: object): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, filename);
    const temporary = join(this.directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export class PublicationReconciliationRequiredError extends Error {
  readonly name = 'PublicationReconciliationRequiredError';

  constructor(readonly deploymentId?: string) {
    super('The site is online, but local publishing facts need repair before another publish can start.');
  }
}

export interface ActivatedDeployment {
  deploymentId: string;
  url: string;
  scanDigest: string;
}

export interface ActivatedDeploymentInspector {
  inspect(deploymentId: string): Promise<{
    deploymentId: string;
    url: string;
    /** Cloudflare's reported state; only the terminal `success` state is accepted. */
    status: string;
  }>;
}

export interface DeploymentFactsCoordinatorDependencies {
  vaultRoot: string;
  store: DeploymentStateStore;
  now?: () => Date;
  writeFacts?: (input: {
    sourcePath: string;
    facts: PublicationDeploymentFacts;
    defaultWrite: () => Promise<void>;
  }) => Promise<void>;
}

/**
 * Coordinates the deliberately non-atomic boundary after remote activation.
 * A recovery receipt is durable before the first Frontmatter mutation, so the
 * operation can be replayed safely after an app or process restart.
 */
export class DeploymentFactsCoordinator {
  private readonly now: () => Date;
  private readonly writeFacts: NonNullable<DeploymentFactsCoordinatorDependencies['writeFacts']>;

  constructor(private readonly dependencies: DeploymentFactsCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.writeFacts = dependencies.writeFacts ?? (async (input) => input.defaultWrite());
  }

  async assertReadyForPublication(): Promise<void> {
    const receipt = await this.dependencies.store.readRecoveryReceipt();
    if (receipt) throw new PublicationReconciliationRequiredError(receipt.deployment.deploymentId);
  }

  async getBaseline(): Promise<PublishBaseline> {
    const manifest = await this.dependencies.store.readLatestManifest();
    return manifest
      ? { status: 'available', articles: manifest.articles.map(copyBaselineArticle) }
      : { status: 'missing' };
  }

  async reconcile(
    deployment: ActivatedDeployment,
    snapshot: PublicationSnapshot,
  ): Promise<DeploymentManifest> {
    const [existing, previous] = await Promise.all([
      this.dependencies.store.readRecoveryReceipt(),
      this.dependencies.store.readLatestManifest(),
    ]);
    if (existing && existing.deployment.deploymentId !== deployment.deploymentId) {
      throw new PublicationReconciliationRequiredError(existing.deployment.deploymentId);
    }
    const receipt = existing ?? receiptFor(deployment, snapshot, this.now(), previous);
    try {
      if (!existing) await this.dependencies.store.writeRecoveryReceipt(receipt);
      return await this.completeReceipt(receipt);
    } catch {
      throw new PublicationReconciliationRequiredError(receipt.deployment.deploymentId);
    }
  }

  async recover(inspector: ActivatedDeploymentInspector): Promise<DeploymentManifest | undefined> {
    const receipt = await this.dependencies.store.readRecoveryReceipt();
    if (!receipt) return undefined;
    try {
      const remote = await inspector.inspect(receipt.deployment.deploymentId);
      if (
        remote.deploymentId !== receipt.deployment.deploymentId ||
        remote.url !== receipt.deployment.url ||
        remote.status !== 'success'
      ) {
        throw new Error('The active Cloudflare deployment does not match the pending local recovery receipt.');
      }
      return await this.completeReceipt(receipt);
    } catch {
      throw new PublicationReconciliationRequiredError(receipt.deployment.deploymentId);
    }
  }

  private async completeReceipt(receipt: DeploymentRecoveryReceipt): Promise<DeploymentManifest> {
    for (const article of receipt.manifest.articles) {
      const facts: PublicationDeploymentFacts = {
        url: article.url,
        firstPublishedAt: article.firstPublishedAt,
        lastPublishedAt: article.lastPublishedAt,
        sourceDigest: article.sourceDigest,
        deploymentId: receipt.deployment.deploymentId,
      };
      const defaultWrite = async (): Promise<void> => {
        await writeArticleDeploymentFactsToDirectory(
          this.dependencies.vaultRoot,
          article.sourcePath,
          facts,
        );
      };
      try {
        await this.writeFacts({ sourcePath: article.sourcePath, facts, defaultWrite });
      } catch (error) {
        // An edit made after the immutable snapshot may delete a source file.
        // Its just-activated remote version remains in the saved manifest so
        // the next complete publish presents it as a takedown; there is no
        // local Frontmatter left to reconcile.
        if (isMissingSourceArticle(error)) continue;
        throw error;
      }
    }
    for (const takedown of receipt.takedowns) {
      try {
        await clearArticleDeploymentFactsToDirectory(
          this.dependencies.vaultRoot,
          takedown.sourcePath,
          takedown.firstPublishedAt,
        );
      } catch (error) {
        if (isMissingSourceArticle(error)) continue;
        throw error;
      }
    }
    await this.dependencies.store.writeLatestManifest(receipt.manifest);
    await this.dependencies.store.clearRecoveryReceipt();
    return copyManifest(receipt.manifest);
  }
}

function receiptFor(
  deployment: ActivatedDeployment,
  snapshot: PublicationSnapshot,
  now: Date,
  previous: DeploymentManifest | undefined,
): DeploymentRecoveryReceipt {
  const publishedAt = timestampInTimeZone(now, snapshot.timeZone ?? 'UTC');
  const previousBySource = new Map(
    (previous?.articles ?? []).map((article) => [article.sourcePath, article]),
  );
  const articles = snapshot.articles
    .filter((article) =>
      (article.visibility === 'public' || article.visibility === 'unlisted') &&
      article.url !== undefined,
    )
    .map((article): DeploymentManifestArticle => {
      const prior = previousBySource.get(article.sourcePath);
      const changed = prior === undefined ||
        prior.sourceDigest !== article.sourceDigest ||
        prior.url !== article.url ||
        prior.visibility !== article.visibility ||
        prior.title !== article.title;
      return {
        sourcePath: article.sourcePath,
        title: article.title,
        url: article.url as string,
        visibility: article.visibility,
        sourceDigest: article.sourceDigest,
        firstPublishedAt: prior?.firstPublishedAt ?? article.firstPublishedAt ?? publishedAt,
        // The value is decided before the durable receipt is written. Recovery
        // can therefore replay this exact result without advancing dates.
        lastPublishedAt: changed
          ? publishedAt
          : prior.lastPublishedAt ?? article.lastPublishedAt ?? previous?.publishedAt ?? publishedAt,
      };
    })
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return {
    schemaVersion: 1,
    deployment: {
      deploymentId: deployment.deploymentId,
      url: deployment.url,
      scanDigest: deployment.scanDigest,
    },
    manifest: {
      deploymentId: deployment.deploymentId,
      deploymentUrl: deployment.url,
      scanDigest: deployment.scanDigest,
      publishedAt,
      articles,
    },
    takedowns: (previous?.articles ?? [])
      .filter((previousArticle) =>
        !articles.some((article) => article.sourcePath === previousArticle.sourcePath),
      )
      .map((article) => ({
        sourcePath: article.sourcePath,
        ...(article.firstPublishedAt === undefined
          ? {}
          : { firstPublishedAt: article.firstPublishedAt }),
      })),
  };
}

function timestampInTimeZone(date: Date, timeZone: string): string {
  const values = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = requiredPart(values, 'year');
  const month = requiredPart(values, 'month');
  const day = requiredPart(values, 'day');
  const hour = requiredPart(values, 'hour');
  const minute = requiredPart(values, 'minute');
  const second = requiredPart(values, 'second');
  const apparentUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMinutes = Math.round((apparentUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetMinute = String(absoluteOffset % 60).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

function requiredPart(values: Map<string, string>, part: string): string {
  const value = values.get(part);
  if (!value) throw new Error(`Could not format the deployment timestamp ${part}.`);
  return value;
}

function parseManifest(value: unknown): DeploymentManifest | undefined {
  if (!isRecord(value) || !isString(value.deploymentId) || !isString(value.deploymentUrl) ||
    !isString(value.scanDigest) || !isString(value.publishedAt) || !Array.isArray(value.articles)) {
    return undefined;
  }
  const articles = value.articles.map(parseManifestArticle);
  return articles.every((article): article is DeploymentManifestArticle => article !== undefined)
    ? {
        deploymentId: value.deploymentId,
        deploymentUrl: value.deploymentUrl,
        scanDigest: value.scanDigest,
        publishedAt: value.publishedAt,
        articles,
      }
    : undefined;
}

function parseReceipt(value: unknown): DeploymentRecoveryReceipt | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.deployment)) {
    return undefined;
  }
  const manifest = parseManifest(value.manifest);
  if (!manifest || !isString(value.deployment.deploymentId) || !isString(value.deployment.url) ||
    !isString(value.deployment.scanDigest)) {
    return undefined;
  }
  const takedowns = value.takedowns === undefined ? [] : parseTakedowns(value.takedowns);
  if (
    takedowns === undefined ||
    manifest.deploymentId !== value.deployment.deploymentId ||
    manifest.deploymentUrl !== value.deployment.url ||
    manifest.scanDigest !== value.deployment.scanDigest
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    deployment: {
      deploymentId: value.deployment.deploymentId,
      url: value.deployment.url,
      scanDigest: value.deployment.scanDigest,
    },
    manifest,
    takedowns,
  };
}

function parseManifestArticle(value: unknown): DeploymentManifestArticle | undefined {
  if (!isRecord(value) || !isString(value.sourcePath) || !isString(value.title) ||
    !isString(value.url) || !isString(value.sourceDigest) ||
    !isString(value.firstPublishedAt) || !isString(value.lastPublishedAt) ||
    (value.visibility !== 'public' && value.visibility !== 'unlisted')) {
    return undefined;
  }
  return {
    sourcePath: value.sourcePath,
    title: value.title,
    url: value.url,
    visibility: value.visibility,
    sourceDigest: value.sourceDigest,
    firstPublishedAt: value.firstPublishedAt,
    lastPublishedAt: value.lastPublishedAt,
  };
}

function copyManifest(manifest: DeploymentManifest): DeploymentManifest {
  return {
    ...manifest,
    articles: manifest.articles.map((article) => ({ ...article })),
  };
}

function copyReceipt(receipt: DeploymentRecoveryReceipt): DeploymentRecoveryReceipt {
  return {
    schemaVersion: 1,
    deployment: { ...receipt.deployment },
    manifest: copyManifest(receipt.manifest),
    takedowns: receipt.takedowns.map((takedown) => ({ ...takedown })),
  };
}

function copyBaselineArticle(article: DeploymentManifestArticle): DeploymentBaselineArticle {
  return {
    sourcePath: article.sourcePath,
    sourceDigest: article.sourceDigest,
    url: article.url,
    visibility: article.visibility,
    title: article.title,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingSourceArticle(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseTakedowns(
  value: unknown,
): Array<{ sourcePath: string; firstPublishedAt?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const takedowns: Array<{ sourcePath: string; firstPublishedAt?: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry.sourcePath)) return undefined;
    if (entry.firstPublishedAt !== undefined && !isString(entry.firstPublishedAt)) {
      return undefined;
    }
    takedowns.push({
      sourcePath: entry.sourcePath,
      ...(entry.firstPublishedAt === undefined
        ? {}
        : { firstPublishedAt: entry.firstPublishedAt }),
    });
  }
  return takedowns;
}

async function syncStateDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
