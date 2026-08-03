import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  validateThemeDescriptor,
  type ThemeConfiguration,
  type ThemeLayout,
  type ThemeOptions,
  type ValidatedThemePackageManifest,
} from './theme-contract';

const execFileAsync = promisify(execFile);
const INSPECTOR_TIMEOUT_MS = 10_000;
const INSPECTOR_OUTPUT_BYTES = 1024 * 1024;

export interface InspectedThemeDescriptor {
  configuration?: ThemeConfiguration;
  layout?: ThemeLayout;
  componentNames: string[];
  pageFrames: Record<string, { name: string; css?: string }>;
  styles: string[];
  assets: string[];
  clientScripts: string[];
  localFonts: string[];
}

export interface ThemeRuntimeInspectorInput {
  rootDirectory: string;
  nodeExecutable: string;
  engineDirectory: string;
  packageDirectory: string;
  manifest: ValidatedThemePackageManifest;
  options?: ThemeOptions;
  signal?: AbortSignal;
}

export class ThemeRuntimeInspectionError extends Error {
  readonly name = 'ThemeRuntimeInspectionError';
  readonly code = 'theme-runtime-inspection-failed';

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export async function inspectThemeRuntime(
  input: ThemeRuntimeInspectorInput,
): Promise<InspectedThemeDescriptor> {
  await mkdir(join(input.rootDirectory, 'theme-smoke'), { recursive: true });
  const workspace = await realpath(
    await mkdtemp(join(input.rootDirectory, 'theme-smoke', '.inspect-')),
  );
  const engineDirectory = await realpath(input.engineDirectory);
  try {
    const snapshot = join(workspace, 'theme-package');
    await copyPackageSnapshot(input.packageDirectory, snapshot);
    await prepareNodeModules(
      join(engineDirectory, 'node_modules'),
      join(workspace, 'node_modules'),
    );
    await linkPackage(
      join(workspace, 'node_modules'),
      input.manifest.name,
      snapshot,
    );
    await materializeSdk(join(workspace, 'node_modules'));
    const inspectorPath = join(workspace, 'inspect-theme.mjs');
    await writeFile(
      inspectorPath,
      inspectorSource(input.manifest.name, input.options ?? {}),
      { flag: 'wx', mode: 0o600 },
    );
    const temporaryDirectory = join(workspace, 'tmp');
    await mkdir(temporaryDirectory);
    const nodeArguments = [
      '--max-old-space-size=128',
      '--permission',
      `--allow-fs-read=${workspace}`,
      `--allow-fs-read=${engineDirectory}`,
      inspectorPath,
    ];
    const command = await sandboxedInspectorCommand(
      workspace,
      input.nodeExecutable,
      nodeArguments,
    );
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(command.executable, command.arguments, {
        cwd: workspace,
        env: {
          PATH: dirname(input.nodeExecutable),
          TMPDIR: temporaryDirectory,
        },
        encoding: 'utf8',
        maxBuffer: INSPECTOR_OUTPUT_BYTES,
        timeout: INSPECTOR_TIMEOUT_MS,
        signal: input.signal,
      }));
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ThemeRuntimeInspectionError(
        'Theme entry could not be evaluated inside the restricted runtime.',
        error,
      );
    }
    let projection: unknown;
    try {
      projection = JSON.parse(stdout) as unknown;
    } catch (error) {
      throw new ThemeRuntimeInspectionError(
        'Theme runtime returned an invalid descriptor projection.',
        error,
      );
    }
    return validateProjection(projection, input.manifest);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function copyPackageSnapshot(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
      throw new ThemeRuntimeInspectionError('Theme snapshot contains an unsafe filesystem entry.');
    }
    if (entry.isDirectory()) {
      await copyPackageSnapshot(sourcePath, destinationPath);
    } else {
      await writeFile(destinationPath, await readFile(sourcePath), {
        flag: 'wx',
        mode: 0o400,
      });
    }
  }
}

export async function prepareNodeModules(
  engineNodeModules: string,
  workspaceNodeModules: string,
): Promise<void> {
  await mkdir(workspaceNodeModules, { recursive: true });
  let entries;
  try {
    entries = await readdir(engineNodeModules, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const targetScope = join(workspaceNodeModules, entry.name);
      await mkdir(targetScope, { recursive: true });
      for (const scopedEntry of await readdir(join(engineNodeModules, entry.name))) {
        await symlink(
          join(engineNodeModules, entry.name, scopedEntry),
          join(targetScope, scopedEntry),
        );
      }
      continue;
    }
    await symlink(join(engineNodeModules, entry.name), join(workspaceNodeModules, entry.name));
  }
}

export async function linkPackage(
  nodeModules: string,
  packageName: string,
  packageDirectory: string,
): Promise<void> {
  const segments = packageName.split('/');
  const target = join(nodeModules, ...segments);
  await mkdir(dirname(target), { recursive: true });
  try {
    await symlink(packageDirectory, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ThemeRuntimeInspectionError(
        `Theme package conflicts with an engine dependency: ${packageName}.`,
        error,
      );
    }
    throw error;
  }
}

export async function materializeSdk(nodeModules: string): Promise<void> {
  const directory = join(nodeModules, '@pages-publish', 'theme-sdk');
  try {
    await lstat(directory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@pages-publish/theme-sdk',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
    }),
    { flag: 'wx', mode: 0o400 },
  );
  await writeFile(
    join(directory, 'index.js'),
    [
      'export const THEME_API_VERSION = 1;',
      'export const defineTheme = (descriptor) => descriptor;',
      'export default { defineTheme };',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o400 },
  );
}

function inspectorSource(packageName: string, options: ThemeOptions): string {
  return `
import themeModule from ${JSON.stringify(packageName)};

const descriptor = typeof themeModule === "function"
  ? await themeModule({ options: Object.freeze(${JSON.stringify(options)}) })
  : themeModule;

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!plain(descriptor)) throw new Error("Theme descriptor must be an object");
const componentNames = Object.keys(descriptor.components ?? {}).sort();
for (const name of componentNames) {
  if (typeof descriptor.components[name] !== "function") throw new Error("Invalid component: " + name);
}
const pageFrames = {};
for (const name of Object.keys(descriptor.pageFrames ?? {}).sort()) {
  const frame = descriptor.pageFrames[name];
  if (!plain(frame) || typeof frame.name !== "string" || typeof frame.render !== "function") {
    throw new Error("Invalid page frame: " + name);
  }
  pageFrames[name] = { name: frame.name, ...(frame.css === undefined ? {} : { css: frame.css }) };
}
const list = (name) => {
  const value = descriptor[name] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Invalid resource list: " + name);
  }
  return [...value];
};
const projection = {
  ...(descriptor.configuration === undefined ? {} : { configuration: descriptor.configuration }),
  ...(descriptor.layout === undefined ? {} : { layout: descriptor.layout }),
  componentNames,
  pageFrames,
  styles: list("styles"),
  assets: list("assets"),
  clientScripts: list("clientScripts"),
  localFonts: list("localFonts"),
};
process.stdout.write(JSON.stringify(projection));
`;
}

function validateProjection(
  value: unknown,
  manifest: ValidatedThemePackageManifest,
): InspectedThemeDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ThemeRuntimeInspectionError('Theme descriptor projection must be an object.');
  }
  const projection = value as Partial<InspectedThemeDescriptor>;
  if (
    !Array.isArray(projection.componentNames) ||
    projection.componentNames.some((name) => typeof name !== 'string') ||
    projection.pageFrames === null ||
    typeof projection.pageFrames !== 'object' ||
    Array.isArray(projection.pageFrames) ||
    !Array.isArray(projection.styles) ||
    !Array.isArray(projection.assets) ||
    !Array.isArray(projection.clientScripts) ||
    !Array.isArray(projection.localFonts)
  ) {
    throw new ThemeRuntimeInspectionError('Theme descriptor projection is incomplete.');
  }
  const component = (): unknown => undefined;
  const descriptor = {
    ...(projection.configuration === undefined
      ? {}
      : { configuration: projection.configuration }),
    ...(projection.layout === undefined ? {} : { layout: projection.layout }),
    components: Object.fromEntries(
      projection.componentNames.map((name) => [name, component]),
    ),
    pageFrames: Object.fromEntries(
      Object.entries(projection.pageFrames).map(([name, frame]) => [
        name,
        { ...frame, render: component },
      ]),
    ),
    styles: projection.styles,
    assets: projection.assets,
    clientScripts: projection.clientScripts,
    localFonts: projection.localFonts,
  };
  try {
    validateThemeDescriptor(descriptor);
    validateCapabilities(projection as InspectedThemeDescriptor, manifest);
    validateReferences(projection as InspectedThemeDescriptor);
  } catch (error) {
    throw new ThemeRuntimeInspectionError(
      'Theme descriptor projection violates the host Theme Contract.',
      error,
    );
  }
  return projection as InspectedThemeDescriptor;
}

function validateCapabilities(
  descriptor: InspectedThemeDescriptor,
  manifest: ValidatedThemePackageManifest,
): void {
  const declared = new Set(manifest.metadata.capabilities);
  const required = new Set<string>();
  if (descriptor.styles.length > 0) required.add('styles');
  if (descriptor.assets.length > 0) required.add('assets');
  if (descriptor.layout !== undefined || Object.keys(descriptor.pageFrames).length > 0) {
    required.add('layout');
  }
  if (descriptor.componentNames.length > 0) required.add('components');
  if (descriptor.clientScripts.length > 0) required.add('clientScripts');
  if (descriptor.localFonts.length > 0) required.add('localFonts');
  for (const capability of required) {
    if (!declared.has(capability as never)) {
      throw new Error(`Theme uses undeclared capability: ${capability}.`);
    }
  }
}

function validateReferences(descriptor: InspectedThemeDescriptor): void {
  const frames = descriptor.layout?.frames;
  if (frames !== undefined) {
    for (const [pageType, exportName] of Object.entries(frames)) {
      if (exportName !== undefined && descriptor.pageFrames[exportName] === undefined) {
        throw new Error(`Layout frame ${pageType} references unknown export ${exportName}.`);
      }
    }
  }
  const custom = new Set(descriptor.componentNames);
  const builtins = new Set([
    'Explorer',
    'Search',
    'Darkmode',
    'Graph',
    'TableOfContents',
    'Backlinks',
    'ArticleTitle',
    'ContentMeta',
    'TagList',
    'PageTitle',
    'Breadcrumbs',
  ]);
  const lists: string[][] = [];
  const layout = descriptor.layout;
  if (layout !== undefined) {
    for (const slot of ['header', 'beforeBody', 'afterBody', 'left', 'right', 'footer'] as const) {
      if (layout[slot] !== undefined) lists.push([...layout[slot]]);
    }
    for (const pageLayout of Object.values(layout.byPageType ?? {})) {
      if (pageLayout === undefined) continue;
      for (const slot of ['header', 'beforeBody', 'afterBody', 'left', 'right', 'footer'] as const) {
        if (pageLayout[slot] !== undefined) lists.push([...pageLayout[slot]]);
      }
    }
  }
  for (const name of lists.flat()) {
    if (!custom.has(name) && !builtins.has(name)) {
      throw new Error(`Layout references unknown component ${name}.`);
    }
  }
}

async function sandboxedInspectorCommand(
  workspace: string,
  nodeExecutable: string,
  nodeArguments: readonly string[],
): Promise<{ executable: string; arguments: string[] }> {
  if (process.platform !== 'darwin') {
    return { executable: nodeExecutable, arguments: [...nodeArguments] };
  }
  const profilePath = join(workspace, 'theme-inspector.sb');
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sandboxLiteral(workspace)}))`,
    '',
  ].join('\n');
  await writeFile(profilePath, profile, { flag: 'wx', mode: 0o600 });
  return {
    executable: '/usr/bin/sandbox-exec',
    arguments: ['-f', profilePath, nodeExecutable, ...nodeArguments],
  };
}

function sandboxLiteral(value: string): string {
  return JSON.stringify(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isPathInside(root: string, path: string): boolean {
  const rootPath = resolve(root);
  const target = resolve(path);
  return target === rootPath || target.startsWith(`${rootPath}${sep}`);
}
