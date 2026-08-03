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
import { createControlledQuartzConfig } from './quartz-config';
import type { QuartzStagingCompilation } from './quartz-staging-compiler';

const execFileAsync = promisify(execFile);
const maximumOutputFiles = 20_000;
const maximumOutputFileBytes = 25 * 1024 * 1024;
const maximumOutputBytes = 250 * 1024 * 1024;

export interface QuartzRawBuildOutput {
  files: Readonly<Record<string, Uint8Array>>;
  sourceDigest: string;
  engineVersion: string;
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
        throw new QuartzBuildError(
          'The verified Quartz engine could not build the staged site.',
          error,
        );
      }

      return {
        files: Object.freeze(await collectOutput(outputDirectory)),
        sourceDigest: staging.sourceDigest,
        engineVersion: engine.engineVersion,
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
    const homeEntries = staging.config.site.homeLayout === 'latest'
      ? publicArticles
        .filter((article) => article.kind === 'article')
        .sort(compareLatestArticle)
        .map((article) => ({ title: article.title, url: article.url }))
      : homeSectionEntries(staging, publicArticles);
    const links = homeEntries
      .map((entry) => `- [${entry.title}](${entry.url})`)
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
    const members = publicArticles
      .filter((article) => article.url !== section.url && article.url.startsWith(section.url))
      .sort(compareSectionArticle)
      .map((article) => `- [${article.title}](${article.url})`)
      .join('\n');
    const sectionPath = section.url.replace(/^\//u, '').replace(/\/$/u, '');
    files[`${sectionPath}/index.md`] = systemPage(
      section.directoryPath.split('/').at(-1) ?? staging.config.site.name,
      section.url,
      members,
    );
  }
  return files;
}

type ManifestArticle = QuartzStagingCompilation['routeManifest']['articles'][number];

function homeSectionEntries(
  staging: Readonly<QuartzStagingCompilation>,
  publicArticles: readonly ManifestArticle[],
): Array<{ title: string; url: string }> {
  const entries: Array<{ title: string; url: string }> = [];
  for (const root of staging.config.contentRoots) {
    const rootSection = staging.routePlan.sections.find(
      (section) => section.directoryPath === root.path,
    );
    const directChildren = staging.routePlan.sections.filter((section) => {
      const relative = posix.relative(root.path, section.directoryPath);
      return relative !== ''
        && relative !== '..'
        && !relative.startsWith('../')
        && !relative.includes('/');
    });
    for (const section of directChildren.length > 0
      ? directChildren
      : rootSection ? [rootSection] : []) {
      if (!publicArticles.some((article) => article.url.startsWith(section.url))) continue;
      const customIndex = publicArticles.find((article) => article.url === section.url);
      entries.push({
        title: customIndex?.title
          ?? section.directoryPath.split('/').at(-1)
          ?? section.directoryPath,
        url: section.url,
      });
    }
  }
  return entries.sort((left, right) =>
    left.title.localeCompare(right.title) || left.url.localeCompare(right.url));
}

function compareLatestArticle(left: ManifestArticle, right: ManifestArticle): number {
  return dateSortValue(right.date) - dateSortValue(left.date)
    || left.title.localeCompare(right.title)
    || left.sourcePath.localeCompare(right.sourcePath);
}

function compareSectionArticle(left: ManifestArticle, right: ManifestArticle): number {
  if (left.order !== undefined || right.order !== undefined) {
    if (left.order === undefined) return 1;
    if (right.order === undefined) return -1;
    if (left.order !== right.order) return left.order - right.order;
  }
  return compareLatestArticle(left, right);
}

function dateSortValue(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
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
