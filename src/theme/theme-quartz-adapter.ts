import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type {
  ControlledQuartzThemeConfig,
  ControlledQuartzThemePlugin,
} from '../site-builder/quartz-config';
import type {
  ThemeLayoutSlot,
  ThemeOptions,
  ThemePageType,
} from './theme-contract';
import type { InstalledTheme } from './theme-store';
import {
  linkPackage,
  materializeSdk,
  type InspectedThemeDescriptor,
} from './theme-runtime-inspector';

const ADAPTER_SCOPE = '@pages-publish-theme-adapter';
const RUNTIME_PACKAGE = `${ADAPTER_SCOPE}/runtime`;
const CORE_PACKAGE = `${ADAPTER_SCOPE}/core`;
const SLOTS = [
  'header',
  'beforeBody',
  'afterBody',
  'left',
  'right',
  'footer',
] as const satisfies readonly ThemeLayoutSlot[];

const PAGE_TYPES = [
  { sdk: 'content', quartz: 'content' },
  { sdk: 'folder', quartz: 'folder' },
  { sdk: 'tag', quartz: 'tag' },
  { sdk: 'notFound', quartz: '404' },
] as const;

interface BuiltinComponent {
  packageName: string;
  exportName: string;
  position: ThemeLayoutSlot;
  options?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  enabled: (features: { search: boolean; graph: boolean }) => boolean;
}

const always = (): boolean => true;
const BUILTINS: Readonly<Record<string, BuiltinComponent>> = {
  PageTitle: builtin('@quartz-community/page-title', 'PageTitle', 'left'),
  Search: builtin('@quartz-community/search', 'Search', 'left', {
    layout: { group: 'toolbar', groupOptions: { grow: true } },
    enabled: (features) => features.search,
  }),
  Darkmode: builtin('@quartz-community/darkmode', 'Darkmode', 'left', {
    layout: { group: 'toolbar' },
  }),
  Explorer: builtin('@quartz-community/explorer', 'Explorer', 'left', {
    options: { folderClickBehavior: 'collapse' },
  }),
  Breadcrumbs: builtin('@quartz-community/breadcrumbs', 'Breadcrumbs', 'beforeBody', {
    layout: { condition: 'not-index' },
  }),
  ArticleTitle: builtin('@quartz-community/article-title', 'ArticleTitle', 'beforeBody'),
  NoteProperties: builtin('@quartz-community/note-properties', 'NoteProperties', 'beforeBody', {
    options: {
      includeAll: false,
      includedProperties: ['description', 'tags'],
      excludedProperties: [],
      hidePropertiesView: true,
    },
  }),
  ContentMeta: builtin('@quartz-community/content-meta', 'ContentMeta', 'beforeBody'),
  TagList: builtin('@quartz-community/tag-list', 'TagList', 'beforeBody'),
  Graph: builtin('@quartz-community/graph', 'Graph', 'right', {
    enabled: (features) => features.graph,
  }),
  TableOfContents: builtin(
    '@quartz-community/table-of-contents',
    'TableOfContents',
    'right',
  ),
  Backlinks: builtin('@quartz-community/backlinks', 'Backlinks', 'right'),
};

const DEFAULT_LAYOUT: Readonly<Record<ThemeLayoutSlot, readonly string[]>> = {
  header: [],
  beforeBody: [
    'Breadcrumbs',
    'ArticleTitle',
    'NoteProperties',
    'ContentMeta',
    'TagList',
  ],
  afterBody: [],
  left: ['PageTitle', 'Search', 'Darkmode', 'Explorer'],
  right: ['Graph', 'TableOfContents', 'Backlinks'],
  footer: [],
};

export interface QuartzThemeAdapterInput {
  workspace: string;
  nodeModules: string;
  installed: InstalledTheme;
  descriptor: InspectedThemeDescriptor;
  options: ThemeOptions;
  features: { search: boolean; graph: boolean };
}

export interface MaterializedQuartzTheme {
  config: ControlledQuartzThemeConfig;
  outputAssets: Readonly<Record<string, Uint8Array>>;
  snapshotDirectory: string;
}

export class ThemeQuartzAdapterError extends Error {
  readonly name = 'ThemeQuartzAdapterError';
  readonly code = 'theme-quartz-adapter-failed';

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export async function materializeQuartzThemeAdapter(
  input: QuartzThemeAdapterInput,
): Promise<MaterializedQuartzTheme> {
  const themeRoot = join(input.workspace, '.pages-publish-theme');
  const snapshotDirectory = join(themeRoot, 'package');
  await copyVerifiedSnapshot(input.installed, snapshotDirectory);
  await materializeSdk(input.nodeModules);
  await linkPackage(
    input.nodeModules,
    input.installed.receipt.packageName,
    snapshotDirectory,
  );
  await materializeRuntimePackage(
    input.nodeModules,
    input.installed.receipt.packageName,
    input.options,
  );

  const resources = await collectResources(snapshotDirectory, input.descriptor);
  const frameExports = await materializeCorePackage(
    input.nodeModules,
    input.descriptor,
    resources.css,
    resources.clientScript,
  );
  const hasExplicitSlots = SLOTS.some((slot) =>
    input.descriptor.layout?.[slot] !== undefined ||
    Object.values(input.descriptor.layout?.byPageType ?? {}).some(
      (pageLayout) => pageLayout?.[slot] !== undefined,
    ));
  const plugins: ControlledQuartzThemePlugin[] = [];
  const sourcesByPage = new Map<string, string[]>();

  if (hasExplicitSlots) {
    assertContentVariantsCompatible(input.descriptor);
    for (const pageType of PAGE_TYPES) {
      const layout = effectiveLayout(input.descriptor, pageType.sdk, input.features);
      const pageSources: string[] = [];
      for (const slot of SLOTS) {
        const names = layout[slot];
        for (let index = 0; index < names.length; index += 1) {
          const componentName = names[index] as string;
          const source = await materializeComponentPackage(
            input.nodeModules,
            pageType.quartz,
            slot,
            index,
            componentName,
            input.descriptor,
          );
          const builtinComponent = BUILTINS[componentName];
          plugins.push({
            source,
            enabled: true,
            ...(builtinComponent?.options === undefined
              ? input.descriptor.componentNames.includes(componentName)
                ? { options: structuredClone(input.options) }
                : {}
              : { options: structuredClone(builtinComponent.options) }),
            layout: {
              position: slot,
              priority: (index + 1) * 10,
              ...(builtinComponent?.layout ?? {}),
            },
          });
          pageSources.push(source);
        }
      }
      sourcesByPage.set(pageType.quartz, pageSources);
    }
  }

  plugins.push({
    source: CORE_PACKAGE,
    enabled: true,
    layout: { position: 'footer', priority: 10000 },
  });

  const allPageSources = [...new Set([...sourcesByPage.values()].flat())];
  const defaultComponentSources = hasExplicitSlots
    ? [...new Set(Object.values(BUILTINS).map((component) => component.packageName))]
    : [];
  const layoutByPageType: ControlledQuartzThemeConfig['layoutByPageType'] = {};
  for (const pageType of PAGE_TYPES) {
    const allowed = new Set(sourcesByPage.get(pageType.quartz) ?? []);
    const exclude = [
      ...defaultComponentSources,
      ...allPageSources.filter((source) => !allowed.has(source)),
    ];
    const positions: Record<string, never[]> = {};
    const override = input.descriptor.layout?.byPageType?.[pageType.sdk];
    for (const slot of SLOTS) {
      if (override?.[slot] !== undefined && override[slot]?.length === 0) {
        positions[slot] = [];
      }
    }
    const template = frameTemplate(pageType.sdk, input.descriptor, frameExports);
    layoutByPageType[pageType.quartz] = {
      ...(exclude.length === 0 ? {} : { exclude }),
      ...(Object.keys(positions).length === 0 ? {} : { positions }),
      ...(template === undefined ? {} : { template }),
    };
  }

  return {
    config: {
      ...(input.descriptor.configuration?.typography === undefined
        ? {}
        : { typography: { ...input.descriptor.configuration.typography } }),
      plugins,
      suppressDefaultComponentLayout: hasExplicitSlots,
      layoutByPageType,
    },
    outputAssets: Object.freeze(resources.outputAssets),
    snapshotDirectory,
  };
}

function builtin(
  packageName: string,
  exportName: string,
  position: ThemeLayoutSlot,
  overrides: Partial<Omit<BuiltinComponent, 'packageName' | 'exportName' | 'position'>> = {},
): BuiltinComponent {
  return {
    packageName,
    exportName,
    position,
    enabled: always,
    ...overrides,
  };
}

async function copyVerifiedSnapshot(
  installed: InstalledTheme,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const file of installed.receipt.inventory) {
    const source = join(installed.packageDirectory, ...file.path.split('/'));
    const target = join(destination, ...file.path.split('/'));
    let content: Buffer;
    try {
      content = await readFile(source);
    } catch (error) {
      throw new ThemeQuartzAdapterError(
        `Verified theme resource is missing while creating the build snapshot: ${file.path}.`,
        error,
      );
    }
    if (
      content.byteLength !== file.size ||
      createHash('sha256').update(content).digest('hex') !== file.sha256
    ) {
      throw new ThemeQuartzAdapterError(
        `Verified theme changed while creating the build snapshot: ${file.path}.`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: 0o400 });
  }
}

async function materializeRuntimePackage(
  nodeModules: string,
  themePackageName: string,
  options: ThemeOptions,
): Promise<void> {
  const directory = packageDirectory(nodeModules, RUNTIME_PACKAGE);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: RUNTIME_PACKAGE,
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
    }),
    { flag: 'wx', mode: 0o400 },
  );
  await writeFile(
    join(directory, 'index.js'),
    [
      `import themeModule from ${JSON.stringify(themePackageName)};`,
      `export const options = Object.freeze(${JSON.stringify(options)});`,
      'export const descriptor = typeof themeModule === "function"',
      '  ? await themeModule({ options })',
      '  : themeModule;',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o400 },
  );
}

async function materializeCorePackage(
  nodeModules: string,
  descriptor: InspectedThemeDescriptor,
  css: string,
  clientScript: string,
): Promise<Record<string, string>> {
  const directory = packageDirectory(nodeModules, CORE_PACKAGE);
  await mkdir(directory, { recursive: true });
  const frameExports: Record<string, string> = {};
  const frameManifest: Record<string, { exportName: string }> = {};
  const frameDefinitions: string[] = [
    `import { descriptor } from ${JSON.stringify(RUNTIME_PACKAGE)};`,
    'const frame = (exportName) => {',
    '  const selected = descriptor.pageFrames?.[exportName];',
    '  if (!selected || typeof selected.render !== "function") throw new Error("Theme frame missing: " + exportName);',
    '  return selected;',
    '};',
  ];
  for (const pageType of PAGE_TYPES) {
    const exportName = `PagesPublish${pascal(pageType.quartz)}Frame`;
    const frameName = `pages-publish-theme-${pageType.quartz.toLowerCase()}`;
    frameExports[pageType.sdk] = frameName;
    frameManifest[exportName] = { exportName };
    const selection = pageType.sdk === 'content'
      ? `
        const slug = String(props.componentData?.fileData?.slug ?? "");
        const key = slug === "index" ? "home" : slug === "privacy" ? "privacy" : "content";
        const exportName = descriptor.layout?.frames?.[key] ?? descriptor.layout?.frames?.content ?? descriptor.layout?.frames?.home;
      `
      : `const exportName = descriptor.layout?.frames?.[${JSON.stringify(pageType.sdk)}];`;
    frameDefinitions.push(
      `export const ${exportName} = {`,
      `  name: ${JSON.stringify(frameName)},`,
      `  css: ${JSON.stringify(adapterFrameCss(frameName, descriptor))},`,
      '  render(props) {',
      selection,
      '    if (!exportName) throw new Error("Theme did not map this page frame");',
      '    return frame(exportName).render(props);',
      '  }',
      '};',
    );
  }
  const manifest = {
    name: CORE_PACKAGE,
    displayName: 'Pages Publish theme resources',
    description: 'Controlled adapter for a verified Pages Publish theme.',
    version: '1.0.0',
    category: 'component',
    quartzVersion: '5.0.0',
    components: {
      ThemeResources: {
        name: 'ThemeResources',
        displayName: 'Theme resources',
        description: 'Verified local styles and client scripts.',
        version: '1.0.0',
      },
    },
    frames: frameManifest,
  };
  await Promise.all([
    writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: CORE_PACKAGE,
        version: '1.0.0',
        type: 'module',
        quartz: manifest,
        exports: {
          '.': './index.js',
          './components': './components.js',
          './frames': './frames.js',
          './package.json': './package.json',
        },
      }),
      { flag: 'wx', mode: 0o400 },
    ),
    writeFile(
      join(directory, 'index.js'),
      `export const manifest = ${JSON.stringify(manifest)};\n`,
      { flag: 'wx', mode: 0o400 },
    ),
    writeFile(
      join(directory, 'components.js'),
      [
        'export const ThemeResources = () => {',
        '  const Component = () => null;',
        `  Component.css = ${JSON.stringify(css)};`,
        ...(clientScript.length === 0
          ? []
          : [`  Component.afterDOMLoaded = ${JSON.stringify(clientScript)};`]),
        '  return Component;',
        '};',
        '',
      ].join('\n'),
      { flag: 'wx', mode: 0o400 },
    ),
    writeFile(
      join(directory, 'frames.js'),
      `${frameDefinitions.join('\n')}\n`,
      { flag: 'wx', mode: 0o400 },
    ),
  ]);
  return frameExports;
}

function adapterFrameCss(
  frameName: string,
  descriptor: InspectedThemeDescriptor,
): string {
  const selector = `.page[data-frame=${JSON.stringify(frameName)}]`;
  return [
    `${selector}{max-width:none;margin:0;}`,
    `${selector}>#quartz-body{display:block;max-width:none;margin:0;padding:0;}`,
    `${selector}>#quartz-body>.brutalist-frame-footer{margin:0;}`,
    ...Object.values(descriptor.pageFrames).map((value) => value.css ?? ''),
  ].join('\n');
}

async function materializeComponentPackage(
  nodeModules: string,
  pageType: string,
  slot: ThemeLayoutSlot,
  index: number,
  componentName: string,
  descriptor: InspectedThemeDescriptor,
): Promise<string> {
  const id = createHash('sha256')
    .update(`${pageType}:${slot}:${index}:${componentName}`)
    .digest('hex')
    .slice(0, 16);
  const packageName = `${ADAPTER_SCOPE}/component-${id}`;
  const directory = packageDirectory(nodeModules, packageName);
  await mkdir(directory, { recursive: true });
  const builtinComponent = BUILTINS[componentName];
  if (builtinComponent === undefined && !descriptor.componentNames.includes(componentName)) {
    throw new ThemeQuartzAdapterError(`Unknown layout component: ${componentName}.`);
  }
  const componentSource = builtinComponent === undefined
    ? [
      `import { descriptor } from ${JSON.stringify(RUNTIME_PACKAGE)};`,
      `export const ${componentName} = descriptor.components.${componentName};`,
    ].join('\n')
    : [
      `export { ${builtinComponent.exportName} as ${componentName} }`,
      `  from ${JSON.stringify(`${builtinComponent.packageName}/components`)};`,
    ].join('\n');
  const manifest = {
    name: packageName,
    displayName: componentName,
    description: 'Pages Publish theme layout adapter.',
    version: '1.0.0',
    category: 'component',
    quartzVersion: '5.0.0',
    components: {
      [componentName]: {
        name: componentName,
        displayName: componentName,
        description: 'Theme-controlled presentation component.',
        version: '1.0.0',
      },
    },
  };
  await Promise.all([
    writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        type: 'module',
        quartz: manifest,
        exports: {
          '.': './index.js',
          './components': './components.js',
          './package.json': './package.json',
        },
      }),
      { flag: 'wx', mode: 0o400 },
    ),
    writeFile(
      join(directory, 'index.js'),
      `export const manifest = ${JSON.stringify(manifest)};\n`,
      { flag: 'wx', mode: 0o400 },
    ),
    writeFile(join(directory, 'components.js'), `${componentSource}\n`, {
      flag: 'wx',
      mode: 0o400,
    }),
  ]);
  return packageName;
}

function effectiveLayout(
  descriptor: InspectedThemeDescriptor,
  pageType: ThemePageType,
  features: { search: boolean; graph: boolean },
): Record<ThemeLayoutSlot, string[]> {
  const override = descriptor.layout?.byPageType?.[pageType];
  return Object.fromEntries(SLOTS.map((slot) => {
    const configured = override?.[slot] ?? descriptor.layout?.[slot] ?? DEFAULT_LAYOUT[slot];
    return [
      slot,
      configured.filter((name) => BUILTINS[name]?.enabled(features) ?? true),
    ];
  })) as Record<ThemeLayoutSlot, string[]>;
}

function assertContentVariantsCompatible(descriptor: InspectedThemeDescriptor): void {
  const content = descriptor.layout?.byPageType?.content;
  for (const pageType of ['home', 'privacy'] as const) {
    const variant = descriptor.layout?.byPageType?.[pageType];
    if (variant === undefined) continue;
    for (const slot of SLOTS) {
      if (
        variant[slot] !== undefined &&
        JSON.stringify(variant[slot]) !== JSON.stringify(content?.[slot] ?? descriptor.layout?.[slot])
      ) {
        throw new ThemeQuartzAdapterError(
          `${pageType} uses Quartz's content page type; customize its Page Frame instead of assigning a different ${slot} component set.`,
        );
      }
    }
  }
}

function frameTemplate(
  pageType: ThemePageType,
  descriptor: InspectedThemeDescriptor,
  generated: Record<string, string>,
): string | undefined {
  if (pageType === 'content') {
    return descriptor.layout?.frames?.content !== undefined ||
      descriptor.layout?.frames?.home !== undefined ||
      descriptor.layout?.frames?.privacy !== undefined
      ? generated.content
      : undefined;
  }
  return descriptor.layout?.frames?.[pageType] === undefined
    ? undefined
    : generated[pageType];
}

async function collectResources(
  packageDirectory: string,
  descriptor: InspectedThemeDescriptor,
): Promise<{
  css: string;
  clientScript: string;
  outputAssets: Record<string, Uint8Array>;
}> {
  const declaredAssetPaths = new Set([
    ...descriptor.assets,
    ...descriptor.localFonts,
  ].map((path) => path.slice(2)));
  const outputAssets: Record<string, Uint8Array> = {};
  for (const resource of [...descriptor.assets, ...descriptor.localFonts]) {
    const content = await readResource(packageDirectory, resource);
    outputAssets[`static/pages-publish-theme/${resource.slice(2)}`] = content;
  }
  const css: string[] = [];
  for (const style of descriptor.styles) {
    const source = Buffer.from(await readResource(packageDirectory, style)).toString('utf8');
    css.push(rewriteCssResources(source, style.slice(2), declaredAssetPaths));
  }
  const clientScripts: string[] = [];
  for (const script of descriptor.clientScripts) {
    const source = Buffer.from(await readResource(packageDirectory, script)).toString('utf8');
    if (/\b(?:import|export)\s/u.test(source)) {
      throw new ThemeQuartzAdapterError(
        `Client script must be a prebuilt classic bundle without imports: ${script}.`,
      );
    }
    clientScripts.push(source);
  }
  return {
    css: css.join('\n'),
    clientScript: clientScripts.join('\n'),
    outputAssets,
  };
}

async function readResource(packageDirectory: string, resource: string): Promise<Uint8Array> {
  const path = join(packageDirectory, ...resource.slice(2).split('/'));
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ThemeQuartzAdapterError(`Theme resource is not a regular file: ${resource}.`);
  }
  return new Uint8Array(await readFile(path));
}

function rewriteCssResources(
  source: string,
  stylePath: string,
  declaredAssets: Set<string>,
): string {
  if (/@import\b/iu.test(source)) {
    throw new ThemeQuartzAdapterError('Theme CSS cannot use @import.');
  }
  return source.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/giu,
    (_match, _quote: string, rawValue: string) => {
      const value = rawValue.trim();
      if (value.startsWith('data:') || value.startsWith('#') || value.startsWith('/')) {
        return `url(${JSON.stringify(value)})`;
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value)) {
        throw new ThemeQuartzAdapterError(`Theme CSS contains a remote resource: ${value}.`);
      }
      const resolved = posix.normalize(posix.join(posix.dirname(stylePath), value));
      if (resolved === '..' || resolved.startsWith('../') || !declaredAssets.has(resolved)) {
        throw new ThemeQuartzAdapterError(
          `Theme CSS references an undeclared asset: ${value}.`,
        );
      }
      return `url(${JSON.stringify(`/static/pages-publish-theme/${resolved}`)})`;
    },
  );
}

function packageDirectory(nodeModules: string, packageName: string): string {
  return join(nodeModules, ...packageName.split('/'));
}

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}
