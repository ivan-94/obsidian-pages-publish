import { createHash, randomUUID } from 'crypto';
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';
import { parse as parseYaml, parseDocument } from 'yaml';

export type PublicationVisibility = 'public' | 'unlisted' | 'private';

export interface ArticlePublicationMetadata {
  visibility: {
    value: PublicationVisibility;
    source: 'publication.visibility' | 'default';
  };
  title: EffectiveValue<string, 'publication.title' | 'first-h1' | 'filename'>;
  summary?: EffectiveValue<
    string,
    'publication.summary' | 'body-summary'
  >;
  slug: EffectiveValue<string, 'publication.slug' | 'filename'>;
  date?: EffectiveValue<
    string,
    'publication.date' | 'frontmatter.date' | 'deployment.first_published_at'
  >;
  updated?: EffectiveValue<
    string,
    'publication.updated' | 'deployment.last_published_at'
  >;
  tags: EffectiveValue<
    string[],
    'publication.tags' | 'frontmatter.tags' | 'default'
  >;
  cover?: EffectiveValue<string, 'publication.cover'>;
  kind: EffectiveValue<'article' | 'index', 'publication.kind' | 'default'>;
  order?: EffectiveValue<number, 'publication.order'>;
  redirects: EffectiveValue<string[], 'publication.redirects' | 'default'>;
  deployment?: PublicationDeploymentFacts;
}

export interface EffectiveValue<T, TSource extends string> {
  value: T;
  source: TSource;
}

export interface ArticleMetadataIssue {
  code: 'invalid-publication-field' | 'invalid-frontmatter';
  path: string;
  message: string;
}

export class ArticleMetadataValidationError extends Error {
  readonly name = 'ArticleMetadataValidationError';

  constructor(readonly issues: ArticleMetadataIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
}

export interface PublicationDeploymentFacts {
  url?: string;
  firstPublishedAt?: string;
  lastPublishedAt?: string;
  sourceDigest?: string;
  deploymentId?: string;
}

export interface ArticleSourceSnapshot {
  sourcePath: string;
  source: string;
  revision: string;
  body: string;
  bodyStartLine: number;
  metadata: ArticlePublicationMetadata;
}

export interface ArticleIntentPatch {
  visibility?: PublicationVisibility | null;
  title?: string | null;
  summary?: string | null;
  slug?: string | null;
  date?: string | null;
  updated?: string | null;
  tags?: string[] | null;
  cover?: string | null;
  kind?: 'article' | 'index' | null;
  order?: number | null;
  redirects?: string[] | null;
}

export interface PreparedArticleIntentEdit {
  sourcePath: string;
  expectedRevision: string;
  patch: ArticleIntentPatch;
  current: ArticlePublicationMetadata;
  next: ArticlePublicationMetadata;
  sourcePreview: string;
  confirmation?: {
    kind: 'takedown';
    onlineUrl?: string;
  };
}

export interface PreparedLegacyPublicationMigration
  extends PreparedArticleIntentEdit {
  legacyFields: Array<{
    path: 'publish' | 'published';
    value: boolean;
  }>;
}

export class ArticleIntentConflictError extends Error {
  readonly name = 'ArticleIntentConflictError';

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
    readonly currentSource: string,
    readonly prepared: PreparedArticleIntentEdit,
  ) {
    super('Article changed outside this editor.');
  }
}

export class ArticleIntentConfirmationRequiredError extends Error {
  readonly name = 'ArticleIntentConfirmationRequiredError';

  constructor(readonly confirmation: { kind: 'takedown'; onlineUrl?: string }) {
    super('Confirm the pending takedown before saving private visibility.');
  }
}

export interface PreparedArticleSourceRestore {
  sourcePath: string;
  expectedRevision: string;
  source: string;
}

export class ArticleSourceRestoreConflictError extends Error {
  readonly name = 'ArticleSourceRestoreConflictError';

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
    readonly currentSource: string,
  ) {
    super('Article changed before its exact source could be restored.');
  }
}

export async function readArticleMetadataFromDirectory(
  vaultRoot: string,
  sourcePath: string,
): Promise<ArticlePublicationMetadata> {
  return (await readArticleSnapshotFromDirectory(vaultRoot, sourcePath)).metadata;
}

export async function readArticleSnapshotFromDirectory(
  vaultRoot: string,
  sourcePath: string,
): Promise<ArticleSourceSnapshot> {
  const relativePath = safeRelativeArticlePath(vaultRoot, sourcePath);
  const targetPath = join(vaultRoot, relativePath);
  await assertSafeArticleFile(vaultRoot, targetPath);
  const source = await readFile(targetPath, 'utf8');
  return readArticleSnapshotFromSource(relativePath, source);
}

export function readArticleSnapshotFromSource(
  sourcePath: string,
  source: string,
): ArticleSourceSnapshot {
  const document = parseMarkdownDocument(source);
  return {
    sourcePath,
    source,
    revision: digest(source),
    body: document.body,
    bodyStartLine:
      source.slice(0, document.bodyStart).split('\n').length,
    metadata: readArticleMetadataFromParsedDocument(sourcePath, document),
  };
}

export async function prepareArticleIntentEditFromDirectory(
  vaultRoot: string,
  sourcePath: string,
  patch: ArticleIntentPatch,
): Promise<PreparedArticleIntentEdit> {
  const relativePath = safeRelativeArticlePath(vaultRoot, sourcePath);
  const targetPath = join(vaultRoot, relativePath);
  await assertSafeArticleFile(vaultRoot, targetPath);
  const source = await readFile(targetPath, 'utf8');
  validateIntentPatch(patch);
  const current = readArticleMetadataFromSource(relativePath, source);
  const sourcePreview = applyIntentPatch(source, patch);
  const next = readArticleMetadataFromSource(relativePath, sourcePreview);
  const confirmation = requiredTakedownConfirmation(current, next);
  return {
    sourcePath: relativePath,
    expectedRevision: digest(source),
    patch: structuredClone(patch),
    current,
    next,
    sourcePreview,
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

export async function prepareLegacyPublicationMigrationFromDirectory(
  vaultRoot: string,
  sourcePath: string,
): Promise<PreparedLegacyPublicationMigration | undefined> {
  const relativePath = safeRelativeArticlePath(vaultRoot, sourcePath);
  const targetPath = join(vaultRoot, relativePath);
  await assertSafeArticleFile(vaultRoot, targetPath);
  const source = await readFile(targetPath, 'utf8');
  const frontmatter = parseMarkdownDocument(source).frontmatter;
  if (recordValue(frontmatter.publication)?.visibility !== undefined) {
    return undefined;
  }
  const legacyFields: PreparedLegacyPublicationMigration['legacyFields'] = [];
  const issues: ArticleMetadataIssue[] = [];
  for (const field of ['publish', 'published'] as const) {
    const value = frontmatter[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      issues.push({
        code: 'invalid-publication-field',
        path: field,
        message: `${field} must be a boolean to migrate safely.`,
      });
      continue;
    }
    legacyFields.push({ path: field, value });
  }
  if (issues.length > 0) throw new ArticleMetadataValidationError(issues);
  if (legacyFields.length === 0) return undefined;
  const values = new Set(legacyFields.map((field) => field.value));
  if (values.size !== 1) {
    throw new ArticleMetadataValidationError([
      {
        code: 'invalid-publication-field',
        path: 'publish,published',
        message: 'Legacy publish fields disagree; choose visibility explicitly.',
      },
    ]);
  }
  const visibility = legacyFields[0]?.value ? 'public' : 'private';
  const prepared = await prepareArticleIntentEditFromDirectory(
    vaultRoot,
    relativePath,
    { visibility },
  );
  return { ...prepared, legacyFields };
}

export async function commitArticleIntentEditToDirectory(
  vaultRoot: string,
  prepared: PreparedArticleIntentEdit,
  options: {
    beforeClaim?: () => Promise<void>;
    confirmTakedown?: boolean;
  } = {},
): Promise<ArticlePublicationMetadata> {
  const relativePath = safeRelativeArticlePath(vaultRoot, prepared.sourcePath);
  const targetPath = join(vaultRoot, relativePath);
  await assertSafeArticleFile(vaultRoot, targetPath);
  const currentSource = await readFile(targetPath, 'utf8');
  const currentRevision = digest(currentSource);
  if (currentRevision !== prepared.expectedRevision) {
    throw new ArticleIntentConflictError(
      prepared.expectedRevision,
      currentRevision,
      currentSource,
      structuredClone(prepared),
    );
  }
  validateIntentPatch(prepared.patch);
  const current = readArticleMetadataFromSource(relativePath, currentSource);
  const sourcePreview = applyIntentPatch(currentSource, prepared.patch);
  const next = readArticleMetadataFromSource(relativePath, sourcePreview);
  const confirmation = requiredTakedownConfirmation(current, next);
  if (confirmation && options.confirmTakedown !== true) {
    throw new ArticleIntentConfirmationRequiredError(confirmation);
  }
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  const displacedPath = `${targetPath}.previous-${randomUUID()}`;
  let temporaryCreated = false;
  let displacedCreated = false;
  try {
    const currentMode = (await stat(targetPath)).mode;
    const handle = await open(temporaryPath, 'wx', currentMode & 0o777);
    temporaryCreated = true;
    try {
      await handle.writeFile(sourcePreview, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, currentMode & 0o777);
    await options.beforeClaim?.();
    await assertSafeArticleFile(vaultRoot, targetPath);
    await rename(targetPath, displacedPath);
    displacedCreated = true;
    await assertSafeArticleFile(vaultRoot, displacedPath);
    const claimedSource = await readFile(displacedPath, 'utf8');
    const claimedRevision = digest(claimedSource);
    if (claimedRevision !== prepared.expectedRevision) {
      await rename(displacedPath, targetPath);
      displacedCreated = false;
      throw new ArticleIntentConflictError(
        prepared.expectedRevision,
        claimedRevision,
        claimedSource,
        structuredClone(prepared),
      );
    }
    try {
      await assertSafeArticleFile(vaultRoot, displacedPath);
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      const externalSource = await readFile(targetPath, 'utf8');
      throw new ArticleIntentConflictError(
        prepared.expectedRevision,
        digest(externalSource),
        externalSource,
        structuredClone(prepared),
      );
    }
    await unlink(displacedPath).catch(() => undefined);
    displacedCreated = false;
    await unlink(temporaryPath).catch(() => undefined);
    temporaryCreated = false;
    return next;
  } catch (error) {
    if (displacedCreated) {
      try {
        await lstat(targetPath);
      } catch (targetError) {
        if (isErrno(targetError, 'ENOENT')) {
          await rename(displacedPath, targetPath);
          displacedCreated = false;
        }
      }
    }
    throw error;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (displacedCreated) await unlink(displacedPath).catch(() => undefined);
  }
}

export async function restoreArticleSourceToDirectory(
  vaultRoot: string,
  prepared: PreparedArticleSourceRestore,
): Promise<void> {
  const relativePath = safeRelativeArticlePath(vaultRoot, prepared.sourcePath);
  const targetPath = join(vaultRoot, relativePath);
  await assertSafeArticleFile(vaultRoot, targetPath);
  const currentSource = await readFile(targetPath, 'utf8');
  const currentRevision = digest(currentSource);
  if (currentRevision !== prepared.expectedRevision) {
    throw new ArticleSourceRestoreConflictError(
      prepared.expectedRevision,
      currentRevision,
      currentSource,
    );
  }
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  const displacedPath = `${targetPath}.previous-${randomUUID()}`;
  let temporaryCreated = false;
  let displacedCreated = false;
  try {
    const currentMode = (await stat(targetPath)).mode;
    const handle = await open(temporaryPath, 'wx', currentMode & 0o777);
    temporaryCreated = true;
    try {
      await handle.writeFile(prepared.source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, currentMode & 0o777);
    await assertSafeArticleFile(vaultRoot, targetPath);
    await rename(targetPath, displacedPath);
    displacedCreated = true;
    await assertSafeArticleFile(vaultRoot, displacedPath);
    const claimedSource = await readFile(displacedPath, 'utf8');
    const claimedRevision = digest(claimedSource);
    if (claimedRevision !== prepared.expectedRevision) {
      await rename(displacedPath, targetPath);
      displacedCreated = false;
      throw new ArticleSourceRestoreConflictError(
        prepared.expectedRevision,
        claimedRevision,
        claimedSource,
      );
    }
    try {
      await assertSafeArticleFile(vaultRoot, displacedPath);
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      const externalSource = await readFile(targetPath, 'utf8');
      throw new ArticleSourceRestoreConflictError(
        prepared.expectedRevision,
        digest(externalSource),
        externalSource,
      );
    }
    await unlink(displacedPath).catch(() => undefined);
    displacedCreated = false;
    await unlink(temporaryPath).catch(() => undefined);
    temporaryCreated = false;
  } catch (error) {
    if (displacedCreated) {
      try {
        await lstat(targetPath);
      } catch (targetError) {
        if (isErrno(targetError, 'ENOENT')) {
          await rename(displacedPath, targetPath);
          displacedCreated = false;
        }
      }
    }
    throw error;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (displacedCreated) await unlink(displacedPath).catch(() => undefined);
  }
}

function requiredTakedownConfirmation(
  current: ArticlePublicationMetadata,
  next: ArticlePublicationMetadata,
): { kind: 'takedown'; onlineUrl?: string } | undefined {
  if (
    current.deployment === undefined ||
    current.visibility.value === 'private' ||
    next.visibility.value !== 'private'
  ) {
    return undefined;
  }
  return {
    kind: 'takedown',
    ...(current.deployment.url === undefined
      ? {}
      : { onlineUrl: current.deployment.url }),
  };
}

export function readArticleMetadataFromSource(
  relativePath: string,
  source: string,
): ArticlePublicationMetadata {
  const document = parseMarkdownDocument(source);
  return readArticleMetadataFromParsedDocument(relativePath, document);
}

function readArticleMetadataFromParsedDocument(
  relativePath: string,
  document: { frontmatter: Record<string, unknown>; body: string },
): ArticlePublicationMetadata {
  const frontmatter = document.frontmatter;
  const publication = validatePublication(frontmatter.publication);
  const explicitVisibility = publication?.visibility;
  const visibility = isVisibility(explicitVisibility)
    ? {
        value: explicitVisibility,
        source: 'publication.visibility' as const,
      }
    : { value: 'private' as const, source: 'default' as const };
  const rawDeployment = recordValue(publication?.deployment);
  const deployment = rawDeployment
    ? compactDeployment({
        url: stringValue(rawDeployment.url),
        firstPublishedAt: stringValue(rawDeployment.first_published_at),
        lastPublishedAt: stringValue(rawDeployment.last_published_at),
        sourceDigest: stringValue(rawDeployment.source_digest),
        deploymentId: stringValue(rawDeployment.deployment_id),
      })
    : undefined;
  const filename = basename(relativePath, extname(relativePath));
  const explicitTitle = stringValue(publication?.title);
  const heading = firstHeading(document.body);
  const title = explicitTitle
    ? { value: explicitTitle, source: 'publication.title' as const }
    : heading
      ? { value: heading, source: 'first-h1' as const }
      : { value: filename, source: 'filename' as const };
  const explicitSummary = stringValue(publication?.summary);
  const fallbackSummary = bodySummary(document.body);
  const summary = explicitSummary
    ? { value: explicitSummary, source: 'publication.summary' as const }
    : fallbackSummary
      ? { value: fallbackSummary, source: 'body-summary' as const }
      : undefined;
  const explicitSlug = stringValue(publication?.slug);
  const explicitDate = stringValue(publication?.date);
  const fallbackDate = stringValue(frontmatter.date);
  const explicitUpdated = stringValue(publication?.updated);
  const explicitTags = stringList(publication?.tags);
  const fallbackTags = generalTagList(frontmatter.tags);
  const explicitCover = stringValue(publication?.cover);
  const explicitKind = publication?.kind;
  const explicitOrder = publication?.order;
  const explicitRedirects = stringList(publication?.redirects);
  return {
    visibility,
    title,
    ...(summary === undefined ? {} : { summary }),
    slug: explicitSlug
      ? { value: explicitSlug, source: 'publication.slug' }
      : { value: filename, source: 'filename' },
    ...(explicitDate
      ? { date: { value: explicitDate, source: 'publication.date' as const } }
      : fallbackDate
        ? { date: { value: fallbackDate, source: 'frontmatter.date' as const } }
        : deployment?.firstPublishedAt
          ? {
              date: {
                value: deployment.firstPublishedAt,
                source: 'deployment.first_published_at' as const,
              },
            }
          : {}),
    ...(explicitUpdated
      ? {
          updated: {
            value: explicitUpdated,
            source: 'publication.updated' as const,
          },
        }
      : deployment?.lastPublishedAt
        ? {
            updated: {
              value: deployment.lastPublishedAt,
              source: 'deployment.last_published_at' as const,
            },
          }
        : {}),
    tags: explicitTags
      ? { value: explicitTags, source: 'publication.tags' }
      : fallbackTags
        ? { value: fallbackTags, source: 'frontmatter.tags' }
        : { value: [], source: 'default' },
    ...(explicitCover
      ? { cover: { value: explicitCover, source: 'publication.cover' as const } }
      : {}),
    kind:
      explicitKind === 'article' || explicitKind === 'index'
        ? { value: explicitKind, source: 'publication.kind' }
        : { value: 'article', source: 'default' },
    ...(typeof explicitOrder === 'number' && Number.isFinite(explicitOrder)
      ? {
          order: {
            value: explicitOrder,
            source: 'publication.order' as const,
          },
        }
      : {}),
    redirects: explicitRedirects
      ? { value: explicitRedirects, source: 'publication.redirects' }
      : { value: [], source: 'default' },
    ...(deployment === undefined ? {} : { deployment }),
  };
}

const intentFields = [
  'visibility',
  'title',
  'summary',
  'slug',
  'date',
  'updated',
  'tags',
  'cover',
  'kind',
  'order',
  'redirects',
] as const;

function validateIntentPatch(patch: ArticleIntentPatch): void {
  const keys = Object.keys(patch);
  const unknown = keys.find(
    (key) => !(intentFields as readonly string[]).includes(key),
  );
  if (unknown) {
    throw new ArticleMetadataValidationError([
      invalidPublicationField(
        `publication.${unknown}`,
        `${unknown} is not an editable publication intent field.`,
      ),
    ]);
  }
  if (keys.length === 0) {
    throw new ArticleMetadataValidationError([
      invalidPublicationField('publication', 'At least one edit is required.'),
    ]);
  }
  validatePublication(
    Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    ),
  );
}

function applyIntentPatch(source: string, patch: ArticleIntentPatch): string {
  const boundary = findFrontmatterBoundary(source);
  const document = parseDocument(
    boundary ? source.slice(boundary.yamlStart, boundary.closingStart) : '',
  );
  for (const field of intentFields) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value === null) document.deleteIn(['publication', field]);
    else document.setIn(['publication', field], value);
  }
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lineEnding = boundary?.lineEnding ?? '\n';
  const body = boundary
    ? source.slice(boundary.bodyStart)
    : source.slice(bom.length);
  const yaml = document
    .toString()
    .trimEnd()
    .replaceAll('\n', lineEnding);
  return `${bom}---${lineEnding}${yaml}${lineEnding}---${lineEnding}${body}`;
}

function safeRelativeArticlePath(vaultRoot: string, sourcePath: string): string {
  const absolutePath = resolve(vaultRoot, sourcePath);
  const relativePath = relative(resolve(vaultRoot), absolutePath);
  if (
    !sourcePath ||
    isAbsolute(sourcePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Article path must stay inside the Vault.');
  }
  return relativePath;
}

async function assertSafeArticleFile(
  vaultRoot: string,
  targetPath: string,
): Promise<void> {
  const lexicalRelative = relative(resolve(vaultRoot), resolve(targetPath));
  const segments = lexicalRelative.split(sep);
  let cursor = resolve(vaultRoot);
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error('Article path cannot contain symbolic links.');
    }
  }
  const entry = await lstat(targetPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('Article must be a regular Markdown file.');
  }
  const [realVaultRoot, realTarget] = await Promise.all([
    realpath(vaultRoot),
    realpath(targetPath),
  ]);
  const targetRelative = relative(realVaultRoot, realTarget);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(
      `..${process.platform === 'win32' ? '\\' : '/'}`,
    ) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error('Article path must stay inside the Vault.');
  }
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function validatePublication(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const publication = recordValue(value);
  if (!publication) {
    throw new ArticleMetadataValidationError([
      invalidPublicationField(
        'publication',
        'publication must be a YAML mapping.',
      ),
    ]);
  }
  const issues: ArticleMetadataIssue[] = [];
  if (
    publication.visibility !== undefined &&
    !isVisibility(publication.visibility)
  ) {
    issues.push(
      invalidPublicationField(
        'publication.visibility',
        'visibility must be public, unlisted, or private.',
      ),
    );
  }
  for (const field of [
    'title',
    'summary',
    'slug',
    'date',
    'updated',
    'cover',
  ] as const) {
    if (
      publication[field] !== undefined &&
      stringValue(publication[field]) === undefined
    ) {
      issues.push(
        invalidPublicationField(
          `publication.${field}`,
          `${field} must be a non-empty string.`,
        ),
      );
    }
  }
  for (const field of ['tags', 'redirects'] as const) {
    if (
      publication[field] !== undefined &&
      stringList(publication[field]) === undefined
    ) {
      issues.push(
        invalidPublicationField(
          `publication.${field}`,
          `${field} must be a list of non-empty strings.`,
        ),
      );
    }
  }
  if (
    publication.kind !== undefined &&
    publication.kind !== 'article' &&
    publication.kind !== 'index'
  ) {
    issues.push(
      invalidPublicationField(
        'publication.kind',
        'kind must be article or index.',
      ),
    );
  }
  if (
    publication.order !== undefined &&
    (typeof publication.order !== 'number' ||
      !Number.isFinite(publication.order))
  ) {
    issues.push(
      invalidPublicationField(
        'publication.order',
        'order must be a finite number.',
      ),
    );
  }
  if (
    publication.deployment !== undefined &&
    recordValue(publication.deployment) === undefined
  ) {
    issues.push(
      invalidPublicationField(
        'publication.deployment',
        'deployment must be a YAML mapping.',
      ),
    );
  }
  const deployment = recordValue(publication.deployment);
  if (deployment) {
    for (const field of [
      'url',
      'first_published_at',
      'last_published_at',
      'source_digest',
      'deployment_id',
    ] as const) {
      if (
        deployment[field] !== undefined &&
        stringValue(deployment[field]) === undefined
      ) {
        issues.push(
          invalidPublicationField(
            `publication.deployment.${field}`,
            `${field} must be a non-empty string.`,
          ),
        );
      }
    }
  }
  if (issues.length > 0) throw new ArticleMetadataValidationError(issues);
  return publication;
}

function invalidPublicationField(
  path: string,
  message: string,
): ArticleMetadataIssue {
  return { code: 'invalid-publication-field', path, message };
}

function parseMarkdownDocument(source: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  bodyStart: number;
} {
  const boundary = findFrontmatterBoundary(source);
  if (!boundary) return { frontmatter: {}, body: source, bodyStart: 0 };
  let parsed: unknown;
  try {
    parsed = parseYaml(
      source.slice(boundary.yamlStart, boundary.closingStart),
    ) as unknown;
  } catch (error) {
    throw new ArticleMetadataValidationError([
      {
        code: 'invalid-frontmatter',
        path: 'frontmatter',
        message: error instanceof Error ? error.message : 'Invalid YAML.',
      },
    ]);
  }
  if (parsed !== null && recordValue(parsed) === undefined) {
    throw new ArticleMetadataValidationError([
      {
        code: 'invalid-frontmatter',
        path: 'frontmatter',
        message: 'Frontmatter YAML root must be a mapping.',
      },
    ]);
  }
  return {
    frontmatter: recordValue(parsed) ?? {},
    body: source.slice(boundary.bodyStart),
    bodyStart: boundary.bodyStart,
  };
}

interface FrontmatterBoundary {
  lineEnding: '\n' | '\r\n';
  yamlStart: number;
  closingStart: number;
  bodyStart: number;
}

function findFrontmatterBoundary(
  source: string,
): FrontmatterBoundary | undefined {
  const bomLength = source.startsWith('\uFEFF') ? 1 : 0;
  const content = source.slice(bomLength);
  const lineEnding = content.startsWith('---\r\n')
    ? '\r\n'
    : content.startsWith('---\n')
      ? '\n'
      : undefined;
  if (!lineEnding) return undefined;
  const yamlStart = bomLength + 3 + lineEnding.length;
  const closingToken = `${lineEnding}---${lineEnding}`;
  const closingStart = source.indexOf(closingToken, yamlStart);
  if (closingStart === -1) {
    throw new ArticleMetadataValidationError([
      {
        code: 'invalid-frontmatter',
        path: 'frontmatter',
        message: 'Frontmatter starts with --- but has no closing boundary.',
      },
    ]);
  }
  return {
    lineEnding,
    yamlStart,
    closingStart,
    bodyStart: closingStart + closingToken.length,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isVisibility(value: unknown): value is PublicationVisibility {
  return value === 'public' || value === 'unlisted' || value === 'private';
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(stringValue);
  return values.every((entry): entry is string => entry !== undefined)
    ? values
    : undefined;
}

function generalTagList(value: unknown): string[] | undefined {
  const single = stringValue(value);
  return single === undefined ? stringList(value) : [single];
}

function firstHeading(source: string): string | undefined {
  return /^#\s+(.+)$/m.exec(source)?.[1]?.trim();
}

function bodySummary(source: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

function compactDeployment(
  deployment: PublicationDeploymentFacts,
): PublicationDeploymentFacts | undefined {
  return Object.values(deployment).some((value) => value !== undefined)
    ? deployment
    : undefined;
}
