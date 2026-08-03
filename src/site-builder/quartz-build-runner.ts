import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ReadyQuartzEngine } from '../runtime/quartz-engine-store';
import { siteCanonicalOrigin } from '../site/discovery';
import { rethrowAbort } from '../runtime/quartz-environment-error';
import { createControlledQuartzConfig } from './quartz-config';
import {
  markdownRouteLink,
  quartzHomeEntries,
  quartzSectionListingMarkdown,
} from './quartz-listing';
import type { QuartzStagingCompilation } from './quartz-staging-compiler';

const execFileAsync = promisify(execFile);
const maximumOutputFiles = 20_000;
const maximumOutputFileBytes = 25 * 1024 * 1024;
const maximumOutputBytes = 250 * 1024 * 1024;

export interface QuartzRawBuildOutput {
  files: Readonly<Record<string, Uint8Array>>;
  sourceDigest: string;
  engineVersion: string;
  /** Ephemeral absolute paths that must never appear in collected output. */
  forbiddenOutputText?: readonly string[];
}

export class QuartzBuildError extends Error {
  readonly name = 'QuartzBuildError';
  readonly code = 'quartz-build-failed';

  constructor(message: string, cause?: unknown) {
    super(message);
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class QuartzBuildRunner {
  constructor(private readonly input: {
    rootDirectory: string;
    deniedReadRoots?: readonly string[];
  }) {}

  async run(
    engine: ReadyQuartzEngine,
    staging: Readonly<QuartzStagingCompilation>,
    signal?: AbortSignal,
  ): Promise<QuartzRawBuildOutput> {
    await mkdir(join(this.input.rootDirectory, 'builds'), { recursive: true });
    const workspace = await realpath(
      await mkdtemp(join(this.input.rootDirectory, 'builds', '.build-')),
    );
    const engineDirectory = await realpath(engine.engineDirectory);
    try {
      const contentDirectory = join(workspace, 'content');
      const outputDirectory = join(workspace, 'output');
      const temporaryDirectory = join(workspace, 'tmp');
      await Promise.all([
        mkdir(contentDirectory, { recursive: true }),
        mkdir(outputDirectory, { recursive: true }),
        mkdir(temporaryDirectory, { recursive: true }),
      ]);
      await materializeStaging(contentDirectory, staging);
      await prepareQuartzWorkspace(workspace, engineDirectory);
      const canonicalOrigin = siteCanonicalOrigin(staging.config);
      await writeFile(
        join(workspace, 'quartz.config.yaml'),
        createControlledQuartzConfig({
          siteName: staging.config.site.name,
          baseUrl: new URL(canonicalOrigin).host,
          search: staging.config.features.search,
          graph: staging.config.features.graph,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      const nodeArguments = [
        '--permission',
        `--allow-fs-read=${workspace}`,
        `--allow-fs-read=${engineDirectory}`,
        `--allow-fs-write=${workspace}`,
        '--allow-addons',
        '--allow-child-process',
        '--allow-worker',
        join(engineDirectory, 'quartz', 'bootstrap-cli.mjs'),
        'build',
        '--directory',
        contentDirectory,
        '--output',
        outputDirectory,
        '--concurrency',
        '1',
      ];
      const sandbox = await sandboxedQuartzCommand(
        workspace,
        engineDirectory,
        engine.nodeExecutable,
        nodeArguments,
        this.input.deniedReadRoots ?? [],
      );

      try {
        await execFileAsync(
          sandbox.executable,
          sandbox.arguments,
          {
            cwd: workspace,
            env: {
              PATH: dirname(engine.nodeExecutable),
              TMPDIR: temporaryDirectory,
              ...(staging.config.site.timezone === undefined
                ? {}
                : { TZ: staging.config.site.timezone }),
            },
            maxBuffer: 4 * 1024 * 1024,
            signal,
          },
        );
      } catch (error) {
        rethrowAbort(error);
        throw new QuartzBuildError(
          'The verified Quartz engine could not build the staged site.',
          error,
        );
      }

      const files = await collectOutput(outputDirectory);
      const runtimeAssetsDirectory = join(engineDirectory, '.pages-publish-runtime-assets');
      try {
        const runtimeAssets = await collectOutput(runtimeAssetsDirectory);
        for (const [path, content] of Object.entries(runtimeAssets)) {
          if (files[path] !== undefined) {
            throw new QuartzBuildError(`Quartz output conflicts with pinned runtime asset ${path}.`);
          }
          files[path] = content;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assertCollectedOutputBudget(files);
      return {
        files: Object.freeze(files),
        sourceDigest: staging.sourceDigest,
        engineVersion: engine.engineVersion,
        forbiddenOutputText: Object.freeze([workspace, engineDirectory]),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function sandboxedQuartzCommand(
  workspace: string,
  engineDirectory: string,
  nodeExecutable: string,
  nodeArguments: readonly string[],
  deniedReadRoots: readonly string[],
): Promise<{ executable: string; arguments: string[] }> {
  if (process.platform !== 'darwin') {
    return { executable: nodeExecutable, arguments: [...nodeArguments] };
  }
  const profilePath = join(workspace, 'pages-publish.sb');
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sandboxLiteral(workspace)}))`,
    ...deniedReadRoots.map((path) =>
      `(deny file-read* (subpath ${sandboxLiteral(resolve(path))}))`),
    `(allow file-read* (subpath ${sandboxLiteral(engineDirectory)}))`,
    `(allow file-read* (subpath ${sandboxLiteral(workspace)}))`,
    `(allow file-read* (subpath ${sandboxLiteral(resolve(dirname(nodeExecutable), '..'))}))`,
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

async function materializeStaging(
  contentDirectory: string,
  staging: Readonly<QuartzStagingCompilation>,
): Promise<void> {
  for (const [path, source] of Object.entries(staging.contentFiles)) {
    await writeSafeFile(contentDirectory, path, source);
  }
  for (const [path, asset] of Object.entries(staging.assetFiles)) {
    await writeSafeFile(contentDirectory, path, asset.content);
  }
  const generated = generatedSystemPages(staging);
  for (const [path, source] of Object.entries(generated)) {
    if (staging.contentFiles[path] !== undefined) {
      throw new QuartzBuildError('A generated Quartz system page conflicts with staged content.');
    }
    await writeSafeFile(contentDirectory, path, source);
  }
}

function generatedSystemPages(
  staging: Readonly<QuartzStagingCompilation>,
): Record<string, string> {
  const files: Record<string, string> = {};
  const occupiedRoutes = new Set(staging.routeManifest.articles.map((article) => article.url));
  const publicArticles = staging.routeManifest.articles.filter(
    (article) => article.visibility === 'public',
  );
  if (!occupiedRoutes.has('/')) {
    const homeEntries = quartzHomeEntries(
      staging.config.site.homeLayout,
      staging.config.contentRoots,
      staging.routePlan.sections,
      publicArticles,
    );
    const links = homeEntries
      .map((entry) => markdownRouteLink(entry.title, entry.url))
      .join('\n');
    files['index.md'] = systemPage(
      staging.config.site.name,
      '/',
      [staging.config.site.description, links].filter(Boolean).join('\n\n'),
    );
  }
  files['404.md'] = systemPage('页面未找到', '/404/', '请求的页面不存在。');
  files['privacy.md'] = systemPage(
    '隐私',
    '/privacy/',
    '本站是静态站点，不启用分析脚本或第三方评论。',
  );
  if (staging.config.features.search) {
    files['search.md'] = systemPage(
      '搜索',
      '/search/',
      '使用页面侧栏中的 Quartz 搜索查找已公开内容。',
    );
  }
  if (staging.config.features.graph) {
    files['graph.md'] = systemPage(
      '关系图谱',
      '/graph/',
      '使用页面侧栏中的 Quartz 图谱浏览已公开内容之间的关系。',
    );
  }
  for (const section of staging.routePlan.sections) {
    if (section.url === '/' || section.sourcePath || occupiedRoutes.has(section.url)) continue;
    const members = quartzSectionListingMarkdown(publicArticles, section.url);
    const sectionPath = section.url.replace(/^\//u, '').replace(/\/$/u, '');
    files[`${sectionPath}/index.md`] = systemPage(
      section.directoryPath.split('/').at(-1) ?? staging.config.site.name,
      section.url,
      members,
    );
  }
  return files;
}

function systemPage(title: string, permalink: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\npermalink: ${permalink}\n---\n${body}\n`;
}

async function prepareQuartzWorkspace(workspace: string, engineDirectory: string): Promise<void> {
  const workspaceQuartz = join(workspace, 'quartz');
  const engineQuartz = join(engineDirectory, 'quartz');
  await mkdir(workspaceQuartz, { recursive: true });
  await mkdir(join(workspaceQuartz, '.quartz-cache'), { recursive: true });
  for (const entry of await readdir(engineQuartz, { withFileTypes: true })) {
    if (entry.name === '.quartz-cache') continue;
    await symlink(join(engineQuartz, entry.name), join(workspaceQuartz, entry.name));
  }
  for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
    try {
      await lstat(join(engineDirectory, name));
      await symlink(join(engineDirectory, name), join(workspace, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function writeSafeFile(
  root: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const normalized = posix.normalize(relativePath);
  if (
    normalized !== relativePath
    || normalized.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('\\')
  ) {
    throw new QuartzBuildError('Quartz staging contains an unsafe path.');
  }
  const target = resolve(root, ...normalized.split('/'));
  const rootPath = resolve(root);
  if (!target.startsWith(`${rootPath}${sep}`)) {
    throw new QuartzBuildError('Quartz staging contains an unsafe path.');
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
}

async function collectOutput(outputDirectory: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new QuartzBuildError('Quartz output contains a symbolic link.');
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new QuartzBuildError('Quartz output contains an unsupported file type.');
      }
      const content = new Uint8Array(await readFile(absolutePath));
      if (content.byteLength > maximumOutputFileBytes) {
        throw new QuartzBuildError('A Quartz output file exceeds the publication resource budget.');
      }
      totalBytes += content.byteLength;
      if (Object.keys(files).length >= maximumOutputFiles || totalBytes > maximumOutputBytes) {
        throw new QuartzBuildError('Quartz output exceeds the publication resource budget.');
      }
      files[relativePath] = content;
    }
  }
  await visit(outputDirectory, '');
  return files;
}

function assertCollectedOutputBudget(files: Readonly<Record<string, Uint8Array>>): void {
  const entries = Object.values(files);
  if (
    entries.length > maximumOutputFiles
    || entries.reduce((total, content) => total + content.byteLength, 0) > maximumOutputBytes
  ) {
    throw new QuartzBuildError('Quartz output exceeds the publication resource budget.');
  }
}
