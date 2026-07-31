import { createHash, randomUUID } from 'crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface SiteConfigV1 {
  version: 1;
  site: {
    name: string;
    description?: string;
    homeLayout: 'sections' | 'latest';
    timezone?: string;
  };
  contentRoots: Array<{
    path: string;
    publicRoot: string;
  }>;
  assets: {
    exclude: string[];
  };
  features: {
    search: boolean;
    graph: boolean;
  };
  cloudflare: {
    projectName: string;
    customDomain?: string;
  };
}

export interface EditableSiteConfig {
  status: 'editable';
  config: SiteConfigV1;
  revision: string;
  source: string;
}

export interface FutureSiteConfig {
  status: 'future-version';
  version: number;
  source: string;
  revision: string;
}

export type LoadedSiteConfig = EditableSiteConfig | FutureSiteConfig;

export interface SiteConfigSource {
  source: string;
  revision: string;
}

export interface SiteConfigIssue {
  code: string;
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export class SiteConfigValidationError extends Error {
  constructor(readonly issues: SiteConfigIssue[]) {
    super(
      issues
        .map((issue) => {
          const location =
            issue.line === undefined
              ? issue.path
              : `${issue.path} (line ${issue.line}, column ${issue.column ?? 1})`;
          return `${location}: ${issue.message}`;
        })
        .join('; '),
    );
    this.name = 'SiteConfigValidationError';
  }
}

export class SiteConfigConflictError extends Error {
  readonly name = 'SiteConfigConflictError';

  constructor(
    readonly expectedRevision: string | null,
    readonly actualRevision: string,
    readonly currentSource: string,
    readonly draft: SiteConfigV1,
  ) {
    super('Site configuration changed outside this editor.');
  }
}

interface RawSiteConfig {
  version?: unknown;
  site?: {
    name?: unknown;
    description?: unknown;
    home_layout?: unknown;
    timezone?: unknown;
  };
  content_roots?: Array<{
    path?: unknown;
    public_root?: unknown;
  }>;
  assets?: {
    exclude?: unknown;
  };
  features?: {
    search?: unknown;
    graph?: unknown;
  };
  cloudflare?: {
    project_name?: unknown;
    custom_domain?: unknown;
  };
}

export async function loadSiteConfigFromDirectory(
  vaultRoot: string,
): Promise<LoadedSiteConfig> {
  const { source, revision } = await readSiteConfigSourceFromDirectory(vaultRoot);
  const raw = parseSiteConfigYaml(source);
  if (
    typeof raw.version === 'number' &&
    Number.isInteger(raw.version) &&
    raw.version > 1
  ) {
    return {
      status: 'future-version',
      version: raw.version,
      source,
      revision,
    };
  }
  const config = parseSupportedConfig(raw);
  await assertExistingContentRootsStayInVault(vaultRoot, config);

  return {
    status: 'editable',
    config,
    revision,
    source,
  };
}

export async function readSiteConfigSourceFromDirectory(
  vaultRoot: string,
): Promise<SiteConfigSource> {
  await assertSafeConfigPath(vaultRoot, false);
  const source = await readFile(join(vaultRoot, '.publish', 'site.yml'), 'utf8');
  return { source, revision: digest(source) };
}

export async function saveSiteConfigToDirectory(
  vaultRoot: string,
  input: SiteConfigV1,
  options: {
    expectedRevision: string | null;
    systemTimezone?: string;
    beforeReplace?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    removeFile?: (path: string) => Promise<void>;
    replaceFile?: (temporaryPath: string, targetPath: string) => Promise<void>;
  },
): Promise<EditableSiteConfig> {
  const targetPath = join(vaultRoot, '.publish', 'site.yml');
  await assertSafeConfigPath(vaultRoot, true);
  let currentSource: string | undefined;
  try {
    currentSource = await readFile(targetPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const currentRevision = currentSource === undefined ? 'missing' : digest(currentSource);
  if (
    (currentSource === undefined && options.expectedRevision !== null) ||
    (currentSource !== undefined && currentRevision !== options.expectedRevision)
  ) {
    throw new SiteConfigConflictError(
      options.expectedRevision,
      currentRevision,
      currentSource ?? '',
      structuredClone(input),
    );
  }
  if (currentSource !== undefined) {
    const currentRaw = parseSiteConfigYaml(currentSource);
    if (
      typeof currentRaw.version === 'number' &&
      Number.isInteger(currentRaw.version) &&
      currentRaw.version > 1
    ) {
      throw new SiteConfigValidationError([
        {
          code: 'future-version-readonly',
          path: 'version',
          message: `Site config version ${currentRaw.version} is newer than this plugin supports.`,
        },
      ]);
    }
  }

  const config = await validateSiteConfigForDirectory(vaultRoot, input, {
    systemTimezone: options.systemTimezone,
  });
  const raw = toRawConfig(config);
  const source = stringifyYaml(raw);
  await mkdir(join(vaultRoot, '.publish'), { recursive: true });
  await assertSafeConfigPath(vaultRoot, false);
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeReplace?.();
    await assertSafeConfigPath(vaultRoot, false);
    let latestSource: string | undefined;
    try {
      latestSource = await readFile(targetPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const latestRevision =
      latestSource === undefined ? 'missing' : digest(latestSource);
    if (
      (options.expectedRevision === null && latestSource !== undefined) ||
      (options.expectedRevision !== null &&
        latestRevision !== options.expectedRevision)
    ) {
      throw new SiteConfigConflictError(
        options.expectedRevision,
        latestRevision,
        latestSource ?? '',
        structuredClone(input),
      );
    }
    await commitPreparedConfig({
      targetPath,
      temporaryPath,
      expectedRevision: options.expectedRevision,
      draft: input,
      source,
      beforeCommit: options.beforeCommit,
      removeFile: options.removeFile,
      replaceFile: options.replaceFile,
    });
    await (options.removeFile ?? unlink)(temporaryPath).catch(() => undefined);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  return {
    status: 'editable',
    config,
    revision: digest(source),
    source,
  };
}

async function commitPreparedConfig(options: {
  targetPath: string;
  temporaryPath: string;
  expectedRevision: string | null;
  draft: SiteConfigV1;
  source: string;
  beforeCommit?: () => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  replaceFile?: (temporaryPath: string, targetPath: string) => Promise<void>;
}): Promise<void> {
  if (options.expectedRevision === null) {
    await options.beforeCommit?.();
    try {
      await link(options.temporaryPath, options.targetPath);
      return;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      throw await conflictFromCurrentTarget(options);
    }
  }

  const displacedPath = `${options.targetPath}.previous-${randomUUID()}`;
  let displacedCreated = false;
  try {
    try {
      await rename(options.targetPath, displacedPath);
      displacedCreated = true;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      throw new SiteConfigConflictError(
        options.expectedRevision,
        'missing',
        '',
        structuredClone(options.draft),
      );
    }

    const claimedSource = await readFile(displacedPath, 'utf8');
    const claimedRevision = digest(claimedSource);
    if (claimedRevision !== options.expectedRevision) {
      throw new SiteConfigConflictError(
        options.expectedRevision,
        claimedRevision,
        claimedSource,
        structuredClone(options.draft),
      );
    }

    await options.beforeCommit?.();
    try {
      if (options.replaceFile) {
        await options.replaceFile(options.temporaryPath, options.targetPath);
      } else {
        await link(options.temporaryPath, options.targetPath);
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      throw await conflictFromCurrentTarget(options);
    }

    const claimedAfterCommit = await readFile(displacedPath, 'utf8');
    if (digest(claimedAfterCommit) !== options.expectedRevision) {
      await rename(displacedPath, options.targetPath);
      displacedCreated = false;
      throw new SiteConfigConflictError(
        options.expectedRevision,
        digest(claimedAfterCommit),
        claimedAfterCommit,
        structuredClone(options.draft),
      );
    }

    const installedSource = await readFile(options.targetPath, 'utf8');
    if (digest(installedSource) !== digest(options.source)) {
      throw new SiteConfigConflictError(
        options.expectedRevision,
        digest(installedSource),
        installedSource,
        structuredClone(options.draft),
      );
    }
    await (options.removeFile ?? unlink)(displacedPath).catch(() => undefined);
    displacedCreated = false;
  } catch (error) {
    if (displacedCreated) {
      await link(displacedPath, options.targetPath).catch(
        (restoreError: unknown) => {
          if (!isErrno(restoreError, 'EEXIST')) throw restoreError;
        },
      );
      await unlink(displacedPath).catch(() => undefined);
    }
    throw error;
  }
}

async function conflictFromCurrentTarget(options: {
  targetPath: string;
  expectedRevision: string | null;
  draft: SiteConfigV1;
}): Promise<SiteConfigConflictError> {
  try {
    const currentSource = await readFile(options.targetPath, 'utf8');
    return new SiteConfigConflictError(
      options.expectedRevision,
      digest(currentSource),
      currentSource,
      structuredClone(options.draft),
    );
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    return new SiteConfigConflictError(
      options.expectedRevision,
      'missing',
      '',
      structuredClone(options.draft),
    );
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function assertSafeConfigPath(
  vaultRoot: string,
  allowMissingDirectory: boolean,
): Promise<void> {
  const configDirectory = join(vaultRoot, '.publish');
  let directoryStats;
  try {
    directoryStats = await lstat(configDirectory);
  } catch (error) {
    if (
      allowMissingDirectory &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  if (directoryStats.isSymbolicLink()) {
    throw new SiteConfigValidationError([
      {
        code: 'config-path-symlink',
        path: '.publish',
        message: 'The .publish directory cannot be a symbolic link.',
      },
    ]);
  }
  if (!directoryStats.isDirectory()) {
    throw new SiteConfigValidationError([
      invalidField('.publish', 'The .publish path must be a directory.'),
    ]);
  }
  try {
    const targetStats = await lstat(join(configDirectory, 'site.yml'));
    if (targetStats.isSymbolicLink()) {
      throw new SiteConfigValidationError([
        {
          code: 'config-path-symlink',
          path: '.publish/site.yml',
          message: 'The site config file cannot be a symbolic link.',
        },
      ]);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function validateSiteConfigForDirectory(
  vaultRoot: string,
  input: SiteConfigV1,
  options: { systemTimezone?: string } = {},
): Promise<SiteConfigV1> {
  const preparedInput = structuredClone(input);
  preparedInput.site.timezone ??=
    options.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const config = parseSupportedConfig(toRawConfig(preparedInput));
  await assertExistingContentRootsStayInVault(vaultRoot, config);
  return config;
}

async function assertExistingContentRootsStayInVault(
  vaultRoot: string,
  config: SiteConfigV1,
): Promise<void> {
  const canonicalVaultRoot = await realpath(vaultRoot);
  for (let index = 0; index < config.contentRoots.length; index += 1) {
    const contentRoot = config.contentRoots[index] as SiteConfigV1['contentRoots'][number];
    let canonicalContentRoot: string;
    try {
      canonicalContentRoot = await realpath(join(vaultRoot, contentRoot.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const relativeToVault = relative(canonicalVaultRoot, canonicalContentRoot);
    if (
      relativeToVault === '..' ||
      relativeToVault.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(relativeToVault)
    ) {
      throw new SiteConfigValidationError([
        {
          code: 'content-root-symlink-escape',
          path: `content_roots[${index}].path`,
          message: 'Content root resolves outside the Vault.',
        },
      ]);
    }
    if (canonicalContentRoot !== resolve(canonicalVaultRoot, contentRoot.path)) {
      throw new SiteConfigValidationError([
        {
          code: 'content-root-symlink',
          path: `content_roots[${index}].path`,
          message: 'Symbolic links cannot be used as content roots.',
        },
      ]);
    }
  }
}

function parseSupportedConfig(raw: RawSiteConfig): SiteConfigV1 {
  assertOptionalStringType(raw.site?.description, 'site.description');
  assertOptionalStringType(raw.site?.timezone, 'site.timezone');
  assertOptionalStringType(
    raw.cloudflare?.custom_domain,
    'cloudflare.custom_domain',
  );
  const name = stringValue(raw.site?.name);
  const description = optionalString(raw.site?.description);
  const homeLayout = raw.site?.home_layout;
  const timezone = optionalString(raw.site?.timezone);
  const projectName = stringValue(raw.cloudflare?.project_name);
  const customDomain = optionalString(raw.cloudflare?.custom_domain);
  const excludes = raw.assets?.exclude ?? [];

  if (description !== undefined && Array.from(description).length > 160) {
    throw new SiteConfigValidationError([
      {
        code: 'site-description-too-long',
        path: 'site.description',
        message: 'Site description must contain at most 160 visible characters.',
      },
    ]);
  }
  if (customDomain !== undefined && !isHostname(customDomain)) {
    throw new SiteConfigValidationError([
      {
        code: 'invalid-custom-domain',
        path: 'cloudflare.custom_domain',
        message: 'Custom domain must be a hostname without a scheme, port, or path.',
      },
    ]);
  }
  if (timezone !== undefined && !isIanaTimezone(timezone)) {
    throw new SiteConfigValidationError([
      {
        code: 'invalid-site-timezone',
        path: 'site.timezone',
        message: 'Site timezone must be a valid IANA timezone.',
      },
    ]);
  }

  const schemaIssues: SiteConfigIssue[] = [];
  if (raw.version !== 1) {
    schemaIssues.push(invalidField('version', 'version must be exactly 1.'));
  }
  if (!name) {
    schemaIssues.push(invalidField('site.name', 'site.name must be a non-empty string.'));
  }
  if (homeLayout !== 'sections' && homeLayout !== 'latest') {
    schemaIssues.push(
      invalidField(
        'site.home_layout',
        'site.home_layout must be sections or latest.',
      ),
    );
  }
  if (!Array.isArray(raw.content_roots) || raw.content_roots.length === 0) {
    schemaIssues.push(
      invalidField(
        'content_roots',
        'content_roots must be a non-empty list.',
      ),
    );
  } else {
    for (let index = 0; index < raw.content_roots.length; index += 1) {
      const root = raw.content_roots[index] as unknown;
      if (root === null || typeof root !== 'object' || Array.isArray(root)) {
        schemaIssues.push(
          invalidField(
            `content_roots[${index}]`,
            'Each content root must be a YAML mapping.',
          ),
        );
      }
    }
  }
  if (
    !Array.isArray(excludes) ||
    !excludes.every((value) => stringValue(value) !== undefined)
  ) {
    schemaIssues.push(
      invalidField('assets.exclude', 'assets.exclude must be a list of strings.'),
    );
  }
  if (typeof raw.features?.search !== 'boolean') {
    schemaIssues.push(
      invalidField('features.search', 'features.search must be a boolean.'),
    );
  }
  if (typeof raw.features?.graph !== 'boolean') {
    schemaIssues.push(
      invalidField('features.graph', 'features.graph must be a boolean.'),
    );
  }
  if (!projectName) {
    schemaIssues.push(
      invalidField(
        'cloudflare.project_name',
        'cloudflare.project_name must be a non-empty string.',
      ),
    );
  }
  if (schemaIssues.length > 0) throw new SiteConfigValidationError(schemaIssues);

  const contentRoots = (raw.content_roots as NonNullable<RawSiteConfig['content_roots']>).map((root, index) => {
    const path = stringValue(root.path);
    const publicRoot = stringValue(root.public_root);
    if (!path || !publicRoot) {
      throw new SiteConfigValidationError([
        invalidField(
          !path
            ? `content_roots[${index}].path`
            : `content_roots[${index}].public_root`,
          'Content root path and public_root must be non-empty strings.',
        ),
      ]);
    }
    assertSafeContentRootPath(path, index);
    assertSafePublicRoot(publicRoot, index);
    return { path, publicRoot: normalizePublicRoot(publicRoot) };
  });
  assertContentRootsDoNotOverlap(contentRoots);
  assertPublicRootsDoNotConflict(contentRoots);

  return {
    version: 1,
    site: {
      name: name as string,
      ...(description === undefined ? {} : { description }),
      homeLayout: homeLayout as 'sections' | 'latest',
      ...(timezone === undefined ? {} : { timezone }),
    },
    contentRoots,
    assets: {
      exclude: (excludes as unknown[]).map((value) => stringValue(value) as string),
    },
    features: {
      search: raw.features?.search as boolean,
      graph: raw.features?.graph as boolean,
    },
    cloudflare: {
      projectName: projectName as string,
      ...(customDomain === undefined ? {} : { customDomain }),
    },
  };
}

function parseSiteConfigYaml(source: string): RawSiteConfig {
  try {
    const parsed = parseYaml(source) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SiteConfigValidationError([
        {
          code: 'invalid-field-type',
          path: '$',
          message: 'Site configuration must be a YAML mapping.',
        },
      ]);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SiteConfigValidationError) throw error;
    const position = yamlErrorPosition(error);
    throw new SiteConfigValidationError([
      {
        code: 'invalid-yaml',
        path: '$',
        message: 'Site configuration is not valid YAML.',
        ...(position === undefined ? {} : position),
      },
    ]);
  }
}

function invalidField(path: string, message: string): SiteConfigIssue {
  return { code: 'invalid-field-type', path, message };
}

function yamlErrorPosition(
  error: unknown,
): { line: number; column: number } | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const linePos = (error as { linePos?: unknown }).linePos;
  if (!Array.isArray(linePos)) return undefined;
  const first = linePos[0] as { line?: unknown; col?: unknown } | undefined;
  if (typeof first?.line !== 'number' || typeof first.col !== 'number') {
    return undefined;
  }
  return { line: first.line, column: first.col };
}

function assertOptionalStringType(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new SiteConfigValidationError([
      {
        code: 'invalid-field-type',
        path,
        message: `${path} must be a string when present.`,
      },
    ]);
  }
}

function assertSafePublicRoot(publicRoot: string, index: number): void {
  const segments = publicRoot.split('/');
  if (
    !publicRoot.startsWith('/') ||
    publicRoot.startsWith('//') ||
    publicRoot.includes('\\') ||
    publicRoot.includes('?') ||
    publicRoot.includes('#') ||
    segments.includes('.') ||
    segments.includes('..')
  ) {
    throw new SiteConfigValidationError([
      {
        code: 'unsafe-public-root',
        path: `content_roots[${index}].public_root`,
        message: 'Public root must be an absolute URL path without traversal.',
      },
    ]);
  }
}

function normalizePublicRoot(publicRoot: string): string {
  const normalized = `/${publicRoot.split('/').filter(Boolean).join('/')}`;
  return normalized || '/';
}

function toRawConfig(config: SiteConfigV1): RawSiteConfig {
  return {
    version: config.version,
    site: {
      name: config.site.name,
      ...(config.site.description === undefined
        ? {}
        : { description: config.site.description }),
      home_layout: config.site.homeLayout,
      ...(config.site.timezone === undefined
        ? {}
        : { timezone: config.site.timezone }),
    },
    content_roots: config.contentRoots.map((root) => ({
      path: root.path,
      public_root: root.publicRoot,
    })),
    assets: { exclude: [...config.assets.exclude] },
    features: { ...config.features },
    cloudflare: {
      project_name: config.cloudflare.projectName,
      ...(config.cloudflare.customDomain === undefined
        ? {}
        : { custom_domain: config.cloudflare.customDomain }),
    },
  };
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function assertSafeContentRootPath(path: string, index: number): void {
  const segments = path.split('/');
  if (
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    segments.includes('..') ||
    (segments.includes('.') && path !== '.')
  ) {
    throw new SiteConfigValidationError([
      {
        code: 'unsafe-content-root',
        path: `content_roots[${index}].path`,
        message: 'Content root must be a Vault-relative path without traversal.',
      },
    ]);
  }
}

function assertPublicRootsDoNotConflict(
  contentRoots: Array<{ path: string; publicRoot: string }>,
): void {
  const normalizedRoots = contentRoots.map((root) =>
    normalizePublicRoot(root.publicRoot),
  );
  for (let index = 0; index < normalizedRoots.length; index += 1) {
    const current = normalizedRoots[index] as string;
    const previousIndex = normalizedRoots.indexOf(current);
    if (previousIndex !== index) {
      throw new SiteConfigValidationError([
        {
          code: 'public-root-conflict',
          path: `content_roots[${index}].public_root`,
          message: `Public root conflicts with content_roots[${previousIndex}].public_root.`,
        },
      ]);
    }
  }
}

function assertContentRootsDoNotOverlap(
  contentRoots: Array<{ path: string; publicRoot: string }>,
): void {
  const normalizedPaths = contentRoots.map((root) =>
    root.path.split('/').filter(Boolean).join('/'),
  );
  for (let index = 0; index < normalizedPaths.length; index += 1) {
    const current = normalizedPaths[index] as string;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = normalizedPaths[previousIndex] as string;
      if (
        current === previous ||
        current.startsWith(`${previous}/`) ||
        previous.startsWith(`${current}/`)
      ) {
        throw new SiteConfigValidationError([
          {
            code: 'content-root-overlap',
            path: `content_roots[${index}].path`,
            message: `Content root overlaps content_roots[${previousIndex}].path.`,
          },
        ]);
      }
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : stringValue(value);
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isHostname(value: string): boolean {
  try {
    const url = new URL(`http://${value}`);
    return (
      url.hostname.length > 0 &&
      url.port === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !value.includes('@')
    );
  } catch {
    return false;
  }
}
