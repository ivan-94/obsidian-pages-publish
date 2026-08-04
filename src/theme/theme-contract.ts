import type { BuiltinThemeId } from './builtin-theme-catalog';

export const PAGES_PUBLISH_THEME_API_VERSION = 1 as const;

export const PAGES_PUBLISH_THEME_CAPABILITIES = [
  'styles',
  'assets',
  'layout',
  'components',
  'clientScripts',
  'localFonts',
] as const;

export type ThemeCapability =
  (typeof PAGES_PUBLISH_THEME_CAPABILITIES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ThemeOptions = Readonly<Record<string, JsonValue>>;

export interface NpmThemeReference {
  source: 'npm';
  package: string;
  version: string;
  integrity: string;
  options: ThemeOptions;
}

export interface LocalThemeReference {
  source: 'local';
  artifact: string;
  integrity: string;
  options: ThemeOptions;
}

export interface BuiltinThemeReference {
  source: 'builtin';
  id: BuiltinThemeId;
}

export type ExternalThemeReference = NpmThemeReference | LocalThemeReference;
export type SiteThemeReference = BuiltinThemeReference | ExternalThemeReference;

export function isExternalThemeReference(
  reference: SiteThemeReference,
): reference is ExternalThemeReference {
  return reference.source === 'npm' || reference.source === 'local';
}

export const THEME_LAYOUT_SLOTS = [
  'header',
  'beforeBody',
  'afterBody',
  'left',
  'right',
  'footer',
] as const;

export type ThemeLayoutSlot = (typeof THEME_LAYOUT_SLOTS)[number];

export const THEME_PAGE_TYPES = [
  'home',
  'folder',
  'tag',
  'content',
  'notFound',
  'privacy',
] as const;

export type ThemePageType = (typeof THEME_PAGE_TYPES)[number];

export type ThemeComponent = (...args: readonly unknown[]) => unknown;

export interface ThemePageFrame {
  name: string;
  css?: string;
  render: ThemeComponent;
}

export interface ThemeTypography {
  header?: string;
  body?: string;
  code?: string;
}

export interface ThemeConfiguration {
  typography?: ThemeTypography;
}

export type ThemeLayout = Partial<
  Record<ThemeLayoutSlot, readonly string[]>
> & {
  byPageType?: Partial<
    Record<ThemePageType, Partial<Record<ThemeLayoutSlot, readonly string[]>>>
  >;
  frames?: Partial<Record<ThemePageType, string>>;
};

export interface ThemeDescriptor {
  configuration?: ThemeConfiguration;
  layout?: ThemeLayout;
  components?: Readonly<Record<string, ThemeComponent>>;
  pageFrames?: Readonly<Record<string, ThemePageFrame>>;
  styles?: readonly string[];
  assets?: readonly string[];
  clientScripts?: readonly string[];
  localFonts?: readonly string[];
}

export interface ThemeManifestMetadata {
  apiVersion: typeof PAGES_PUBLISH_THEME_API_VERSION;
  displayName: string;
  quartzVersion: string;
  entry: string;
  capabilities: ThemeCapability[];
  optionsSchema?: string;
}

export interface ValidatedThemePackageManifest {
  name: string;
  version: string;
  type: 'module';
  entry: string;
  metadata: ThemeManifestMetadata;
}

export interface ResolvedTheme {
  packageName: string;
  version: string;
  integrity: string;
  packageDirectory: string;
  descriptor: ThemeDescriptor;
  options: ThemeOptions;
}

export class ThemeContractError extends Error {
  readonly name = 'ThemeContractError';

  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

export function defineTheme<const T extends ThemeDescriptor>(descriptor: T): T {
  validateThemeDescriptor(descriptor);
  return descriptor;
}

export function validateThemeDescriptor(value: unknown): ThemeDescriptor {
  const descriptor = plainRecord(value, '$', 'Theme descriptor must be an object.');
  assertKnownKeys(
    descriptor,
    [
      'configuration',
      'layout',
      'components',
      'pageFrames',
      'styles',
      'assets',
      'clientScripts',
      'localFonts',
    ],
    '$',
  );

  if (descriptor.configuration !== undefined) {
    validateConfiguration(descriptor.configuration);
  }
  if (descriptor.layout !== undefined) validateLayout(descriptor.layout);
  if (descriptor.components !== undefined) {
    const components = plainRecord(
      descriptor.components,
      '$.components',
      'components must be an object.',
    );
    for (const [name, component] of Object.entries(components)) {
      assertComponentName(name, `$.components.${name}`);
      if (typeof component !== 'function') {
        throw contractError(
          'invalid-component',
          `$.components.${name}`,
          'Theme components must be functions.',
        );
      }
    }
  }
  if (descriptor.pageFrames !== undefined) {
    const frames = plainRecord(
      descriptor.pageFrames,
      '$.pageFrames',
      'pageFrames must be an object.',
    );
    for (const [exportName, frameValue] of Object.entries(frames)) {
      assertComponentName(exportName, `$.pageFrames.${exportName}`);
      const frame = plainRecord(
        frameValue,
        `$.pageFrames.${exportName}`,
        'Page frame must be an object.',
      );
      assertKnownKeys(frame, ['name', 'css', 'render'], `$.pageFrames.${exportName}`);
      const frameName = requiredString(frame.name, `$.pageFrames.${exportName}.name`);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(frameName)) {
        throw contractError(
          'invalid-frame-name',
          `$.pageFrames.${exportName}.name`,
          'Page frame name must be a lowercase kebab-case identifier.',
        );
      }
      if (frame.css !== undefined && typeof frame.css !== 'string') {
        throw contractError(
          'invalid-frame-css',
          `$.pageFrames.${exportName}.css`,
          'Page frame css must be a string.',
        );
      }
      if (typeof frame.render !== 'function') {
        throw contractError(
          'invalid-frame-render',
          `$.pageFrames.${exportName}.render`,
          'Page frame render must be a function.',
        );
      }
    }
  }
  validateResourceList(descriptor.styles, '$.styles');
  validateResourceList(descriptor.assets, '$.assets');
  validateResourceList(descriptor.clientScripts, '$.clientScripts');
  validateResourceList(descriptor.localFonts, '$.localFonts');

  return value as ThemeDescriptor;
}

export function validateThemePackageManifest(
  value: unknown,
  supportedQuartzVersion: string,
): ValidatedThemePackageManifest {
  const manifest = plainRecord(value, '$', 'package.json must be an object.');
  const name = requiredString(manifest.name, '$.name');
  if (!isValidPackageName(name)) {
    throw contractError('invalid-package-name', '$.name', 'Invalid npm package name.');
  }
  const version = requiredString(manifest.version, '$.version');
  if (!isExactSemver(version)) {
    throw contractError(
      'invalid-exact-version',
      '$.version',
      'Theme version must be an exact semantic version.',
    );
  }
  if (manifest.type !== 'module') {
    throw contractError('invalid-module-type', '$.type', 'type must be module.');
  }
  validateExports(manifest.exports);
  validatePackageDependencies(manifest);
  validatePackageScripts(manifest.scripts);

  const metadata = plainRecord(
    manifest.pagesPublishTheme,
    '$.pagesPublishTheme',
    'pagesPublishTheme metadata is required.',
  );
  assertKnownKeys(
    metadata,
    [
      'apiVersion',
      'displayName',
      'quartzVersion',
      'entry',
      'capabilities',
      'optionsSchema',
    ],
    '$.pagesPublishTheme',
  );
  if (metadata.apiVersion !== PAGES_PUBLISH_THEME_API_VERSION) {
    throw contractError(
      'unsupported-api-version',
      '$.pagesPublishTheme.apiVersion',
      `Only Theme API ${PAGES_PUBLISH_THEME_API_VERSION} is supported.`,
    );
  }
  const displayName = requiredString(
    metadata.displayName,
    '$.pagesPublishTheme.displayName',
  );
  const quartzVersion = requiredString(
    metadata.quartzVersion,
    '$.pagesPublishTheme.quartzVersion',
  );
  if (!isExactSemver(quartzVersion) || quartzVersion !== supportedQuartzVersion) {
    throw contractError(
      'incompatible-quartz-version',
      '$.pagesPublishTheme.quartzVersion',
      `Theme requires Quartz ${quartzVersion}; this engine provides ${supportedQuartzVersion}.`,
    );
  }
  const entry = validatePackageResourcePath(
    metadata.entry,
    '$.pagesPublishTheme.entry',
  );
  const exportedEntry = exportedPackageEntry(manifest.exports);
  if (entry !== exportedEntry) {
    throw contractError(
      'entry-export-mismatch',
      '$.pagesPublishTheme.entry',
      'Theme entry must match exports["."].',
    );
  }
  const capabilities = validateCapabilities(metadata.capabilities);
  const optionsSchema = metadata.optionsSchema === undefined
    ? undefined
    : validatePackageResourcePath(
      metadata.optionsSchema,
      '$.pagesPublishTheme.optionsSchema',
    );

  return {
    name,
    version,
    type: 'module',
    entry,
    metadata: {
      apiVersion: PAGES_PUBLISH_THEME_API_VERSION,
      displayName,
      quartzVersion,
      entry,
      capabilities,
      ...(optionsSchema === undefined ? {} : { optionsSchema }),
    },
  };
}

export function normalizeThemeOptions(
  value: unknown,
  path = 'site.theme.options',
): ThemeOptions {
  if (value === undefined) return Object.freeze({});
  const options = plainRecord(value, path, `${path} must be a YAML mapping.`);
  return Object.freeze(sortJsonRecord(options, path));
}

export function assertExactThemeVersion(value: string, path: string): void {
  if (!isExactSemver(value)) {
    throw contractError(
      'invalid-exact-version',
      path,
      `${path} must be an exact semantic version.`,
    );
  }
}

export function assertThemeIntegrity(value: string, path: string): void {
  const encoded = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value)?.[1];
  let valid = false;
  if (encoded !== undefined) {
    try {
      const digest = Buffer.from(encoded, 'base64');
      valid = digest.byteLength === 64 && digest.toString('base64') === encoded;
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw contractError(
      'invalid-integrity',
      path,
      `${path} must be a sha512 Subresource Integrity value.`,
    );
  }
}

export function assertThemePackageName(value: string, path: string): void {
  if (!isValidPackageName(value)) {
    throw contractError('invalid-package-name', path, `${path} is not a valid npm package name.`);
  }
}

export function assertLocalThemeArtifact(value: string, path: string): void {
  const segments = value.split('/');
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    !value.startsWith('.publish/themes/') ||
    !value.endsWith('.tgz') ||
    segments.includes('.') ||
    segments.includes('..')
  ) {
    throw contractError(
      'unsafe-theme-artifact',
      path,
      'Local theme artifact must be a .publish/themes/*.tgz Vault-relative path without traversal.',
    );
  }
}

function validateConfiguration(value: unknown): void {
  const configuration = plainRecord(
    value,
    '$.configuration',
    'configuration must be an object.',
  );
  assertKnownKeys(configuration, ['typography'], '$.configuration');
  if (configuration.typography === undefined) return;
  const typography = plainRecord(
    configuration.typography,
    '$.configuration.typography',
    'typography must be an object.',
  );
  assertKnownKeys(typography, ['header', 'body', 'code'], '$.configuration.typography');
  for (const [key, font] of Object.entries(typography)) {
    requiredString(font, `$.configuration.typography.${key}`);
  }
}

function validateLayout(value: unknown): void {
  const layout = plainRecord(value, '$.layout', 'layout must be an object.');
  assertKnownKeys(layout, [...THEME_LAYOUT_SLOTS, 'byPageType', 'frames'], '$.layout');
  for (const slot of THEME_LAYOUT_SLOTS) {
    validateComponentNameList(layout[slot], `$.layout.${slot}`);
  }
  if (layout.byPageType !== undefined) {
    const byPageType = plainRecord(
      layout.byPageType,
      '$.layout.byPageType',
      'byPageType must be an object.',
    );
    assertKnownKeys(byPageType, THEME_PAGE_TYPES, '$.layout.byPageType');
    for (const [pageType, pageLayoutValue] of Object.entries(byPageType)) {
      const pageLayout = plainRecord(
        pageLayoutValue,
        `$.layout.byPageType.${pageType}`,
        'Page layout must be an object.',
      );
      assertKnownKeys(pageLayout, THEME_LAYOUT_SLOTS, `$.layout.byPageType.${pageType}`);
      for (const slot of THEME_LAYOUT_SLOTS) {
        validateComponentNameList(
          pageLayout[slot],
          `$.layout.byPageType.${pageType}.${slot}`,
        );
      }
    }
  }
  if (layout.frames !== undefined) {
    const frames = plainRecord(
      layout.frames,
      '$.layout.frames',
      'frames must be an object.',
    );
    assertKnownKeys(frames, THEME_PAGE_TYPES, '$.layout.frames');
    for (const [pageType, frame] of Object.entries(frames)) {
      const name = requiredString(frame, `$.layout.frames.${pageType}`);
      assertComponentName(name, `$.layout.frames.${pageType}`);
    }
  }
}

function validateComponentNameList(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw contractError('invalid-layout-slot', path, 'Layout slot must be a list of component names.');
  }
  for (let index = 0; index < value.length; index += 1) {
    const name = requiredString(value[index], `${path}[${index}]`);
    assertComponentName(name, `${path}[${index}]`);
  }
}

function validateResourceList(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw contractError('invalid-resource-list', path, `${path} must be a list.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    validatePackageResourcePath(value[index], `${path}[${index}]`);
  }
}

function validateCapabilities(value: unknown): ThemeCapability[] {
  if (!Array.isArray(value)) {
    throw contractError(
      'invalid-capabilities',
      '$.pagesPublishTheme.capabilities',
      'capabilities must be a list.',
    );
  }
  const supported = new Set<string>(PAGES_PUBLISH_THEME_CAPABILITIES);
  const capabilities: ThemeCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const capability = requiredString(
      value[index],
      `$.pagesPublishTheme.capabilities[${index}]`,
    );
    if (!supported.has(capability)) {
      throw contractError(
        'unknown-capability',
        `$.pagesPublishTheme.capabilities[${index}]`,
        `Unknown theme capability: ${capability}.`,
      );
    }
    if (capabilities.includes(capability as ThemeCapability)) {
      throw contractError(
        'duplicate-capability',
        `$.pagesPublishTheme.capabilities[${index}]`,
        `Duplicate theme capability: ${capability}.`,
      );
    }
    capabilities.push(capability as ThemeCapability);
  }
  return capabilities;
}

function validateExports(value: unknown): void {
  exportedPackageEntry(value);
}

function exportedPackageEntry(value: unknown): string {
  const exports = plainRecord(value, '$.exports', 'exports must be an object.');
  assertKnownKeys(exports, ['.'], '$.exports');
  const rootExport = exports['.'];
  if (typeof rootExport === 'string') {
    return validatePackageResourcePath(rootExport, '$.exports["."]');
  }
  const conditions = plainRecord(
    rootExport,
    '$.exports["."]',
    'The root export must be a path or condition object.',
  );
  assertKnownKeys(conditions, ['import', 'default'], '$.exports["."]');
  return validatePackageResourcePath(
    conditions.import ?? conditions.default,
    '$.exports["."].import',
  );
}

function validatePackageDependencies(manifest: Record<string, unknown>): void {
  for (const key of ['dependencies', 'optionalDependencies', 'bundledDependencies']) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length > 0 : Object.keys(plainRecord(value, `$.${key}`, `${key} must be an object.`)).length > 0) {
      throw contractError(
        'unsupported-dependency',
        `$.${key}`,
        `${key} are not allowed in a theme package.`,
      );
    }
  }
  if (manifest.peerDependencies === undefined) return;
  const peers = plainRecord(
    manifest.peerDependencies,
    '$.peerDependencies',
    'peerDependencies must be an object.',
  );
  assertKnownKeys(peers, ['@pages-publish/theme-sdk', 'preact'], '$.peerDependencies');
  for (const [name, version] of Object.entries(peers)) {
    requiredString(version, `$.peerDependencies.${name}`);
  }
}

function validatePackageScripts(value: unknown): void {
  if (value === undefined) return;
  const scripts = plainRecord(value, '$.scripts', 'scripts must be an object.');
  for (const lifecycle of [
    'preinstall',
    'install',
    'postinstall',
    'prepack',
    'prepare',
  ]) {
    if (scripts[lifecycle] !== undefined) {
      throw contractError(
        'lifecycle-script-forbidden',
        `$.scripts.${lifecycle}`,
        `Theme package cannot define ${lifecycle}.`,
      );
    }
  }
}

function sortJsonRecord(
  value: Record<string, unknown>,
  path: string,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = normalizeJsonValue(value[key], `${path}.${key}`);
  }
  return result;
}

function normalizeJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) return sortJsonRecord(value, path);
  throw contractError(
    'invalid-theme-option',
    path,
    'Theme options must contain only JSON-compatible values.',
  );
}

function validatePackageResourcePath(value: unknown, path: string): string {
  const resource = requiredString(value, path);
  const segments = resource.split('/');
  if (
    !resource.startsWith('./') ||
    resource.includes('\\') ||
    resource.includes('\0') ||
    resource.includes('?') ||
    resource.includes('#') ||
    segments.includes('..')
  ) {
    throw contractError(
      'unsafe-package-path',
      path,
      'Package resource must be a ./ relative path without traversal.',
    );
  }
  return resource;
}

function assertComponentName(value: string, path: string): void {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(value)) {
    throw contractError(
      'invalid-component-name',
      path,
      'Component names must be PascalCase identifiers.',
    );
  }
}

function isExactSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function isValidPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw contractError('invalid-field', path, `${path} must be a non-empty string.`);
  }
  return value.trim();
}

function plainRecord(
  value: unknown,
  path: string,
  message: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw contractError('invalid-field', path, message);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
): void {
  const supported = new Set(known);
  const unknown = Object.keys(value).find((key) => !supported.has(key));
  if (unknown !== undefined) {
    throw contractError(
      'unknown-field',
      `${path}.${unknown}`,
      `Unknown field: ${unknown}.`,
    );
  }
}

function contractError(code: string, path: string, message: string): ThemeContractError {
  return new ThemeContractError(code, path, message);
}
