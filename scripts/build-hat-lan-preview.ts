import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  loadSiteConfigFromDirectory,
  saveSiteConfigToDirectory,
} from '../src/config/site-config';
import { scanSiteFromDirectory } from '../src/content/site-scanner';
import { localPluginStateDirectory } from '../src/plugin/local-state-directory';
import type { ReadyQuartzEngine } from '../src/runtime/quartz-engine-store';
import type { SupportedPlatformIdentity } from '../src/plugin/platform';
import { QuartzBuildRunner } from '../src/site-builder/quartz-build-runner';
import { QuartzSiteBuilder } from '../src/site-builder/quartz-site-builder';
import { ThemeInstaller } from '../src/theme/theme-installer';
import { createQuartzThemeSmoke } from '../src/theme/theme-quartz-smoke';
import { ThemeRegistryClient } from '../src/theme/theme-registry-client';
import { InstalledThemeResolver } from '../src/theme/theme-resolver';
import { ThemeStore } from '../src/theme/theme-store';
import { ThemeTrustStore } from '../src/theme/theme-trust-store';
import { themeOptionsFromSchemaDefaults } from '../src/theme/theme-options-schema';

const vaultRoot = resolve(process.argv[2] ?? 'hats/20260803-custom-quartz-theme/test-vault');
const outputDirectory = resolve(process.argv[3] ?? 'hats/20260803-custom-quartz-theme/lan-preview');
const themeArchive = resolve(
  'external-themes/brutalist/artifacts/pages-publish-theme-brutalist-1.0.0.tgz',
);
const hatEnvironmentRoot = join(dirname(outputDirectory), '.lan-environment');
const environmentRoot = join(
  homedir(),
  'Library',
  'Application Support',
  'pages-publish',
  'environment',
);

const engine = await readyEngine(environmentRoot);
const scan = await scanSiteFromDirectory(vaultRoot);
const blockers = scan.issues.filter((issue) => issue.severity === 'blocker');
if (blockers.length > 0) {
  throw new Error(`HAT Vault has scan blockers:\n${blockers
    .map((issue) => `${issue.code}: ${issue.path}: ${issue.message}`)
    .join('\n')}`);
}

await rm(hatEnvironmentRoot, { recursive: true, force: true });
const themeStore = new ThemeStore({
  rootDirectory: hatEnvironmentRoot,
  smoke: createQuartzThemeSmoke(
    join(hatEnvironmentRoot, 'theme-smoke'),
    async () => engine,
  ),
});
const trustStore = new ThemeTrustStore(hatEnvironmentRoot);
const installer = new ThemeInstaller(
  themeStore,
  new ThemeRegistryClient(async () => {
    throw new Error('The LAN HAT build never accesses the npm registry.');
  }),
);
const imported = await installer.importLocal(
  vaultRoot,
  themeArchive,
  engine.quartzVersion,
);
await trustStore.confirm(imported.installed.receipt);
const loadedConfig = await loadSiteConfigFromDirectory(vaultRoot);
if (loadedConfig.status !== 'editable') {
  throw new Error('The HAT Vault uses an unsupported future site config.');
}
const options = imported.installed.optionsSchema === undefined
  ? {}
  : themeOptionsFromSchemaDefaults(imported.installed.optionsSchema);
await saveSiteConfigToDirectory(vaultRoot, {
  ...loadedConfig.config,
  site: {
    ...loadedConfig.config.site,
    theme: { ...imported.reference, options },
  },
}, { expectedRevision: loadedConfig.revision });
const builder = new QuartzSiteBuilder({
  environment: { ensureReady: async () => engine },
  runner: new QuartzBuildRunner({
    rootDirectory: join(localPluginStateDirectory(vaultRoot), 'quartz'),
    deniedReadRoots: [vaultRoot],
    themeResolver: new InstalledThemeResolver(hatEnvironmentRoot, themeStore, trustStore),
  }),
});
const preview = await builder.build({ vaultRoot, renderMode: 'published' });
const serialized = JSON.stringify(preview.files);
for (const canary of [
  'PRIVATE-CUSTOM-THEME-CANARY-9f421fd6d0f44808',
  'Private brutalist note',
]) {
  if (serialized.includes(canary)) throw new Error(`Private canary leaked: ${canary}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
for (const [path, body] of Object.entries(preview.files)) {
  await writeOutput(outputDirectory, path, body);
}
for (const [path, asset] of Object.entries(preview.assets)) {
  await writeOutput(outputDirectory, path, asset.content);
}

process.stdout.write(`${JSON.stringify({
  vaultRoot,
  outputDirectory,
  engineVersion: engine.engineVersion,
  quartzVersion: engine.quartzVersion,
  scannedArticles: scan.candidates.length,
  warnings: scan.issues.filter((issue) => issue.severity === 'warning').length,
  outputFiles: Object.keys(preview.files).length,
  outputAssets: Object.keys(preview.assets).length,
}, null, 2)}\n`);

async function readyEngine(root: string): Promise<ReadyQuartzEngine> {
  const platform = `${process.platform}-${process.arch}` as SupportedPlatformIdentity;
  const activePath = join(root, `active-${platform}.json`);
  const active = JSON.parse(await readFile(activePath, 'utf8')) as {
    engineVersion: string;
    quartzVersion: string;
    engineDirectory: string;
  };
  const runtimesRoot = join(root, 'runtimes', platform);
  const runtimeNames = (await readdir(runtimesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^node-22\./u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  const runtimeName = runtimeNames.at(-1);
  if (runtimeName === undefined) throw new Error('Managed Node 22 runtime is not installed.');
  const runtimeVersion = runtimeName.slice('node-'.length);
  const runtimeRoot = join(runtimesRoot, runtimeName);
  const npmPackage = JSON.parse(await readFile(
    join(runtimeRoot, 'lib', 'node_modules', 'npm', 'package.json'),
    'utf8',
  )) as { version: string };
  return {
    engineVersion: active.engineVersion,
    quartzVersion: active.quartzVersion,
    engineDirectory: active.engineDirectory,
    platform,
    usingFallback: false,
    nodeExecutable: join(runtimeRoot, 'bin', 'node'),
    nodeVersion: runtimeVersion,
    npmCliPath: join(runtimeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    npmVersion: npmPackage.version,
    source: 'managed',
  };
}

async function writeOutput(
  root: string,
  outputPath: string,
  body: string | Uint8Array,
): Promise<void> {
  const relativePath = outputPath.replace(/^\/+/, '');
  const target = resolve(root, relativePath);
  const relativeTarget = relative(root, target);
  if (
    relativePath.length === 0
    || relativeTarget.startsWith('..')
    || relativeTarget.includes('/../')
  ) {
    throw new Error(`Unsafe generated output path: ${outputPath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}
