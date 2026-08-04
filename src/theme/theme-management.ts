import type { ReadyQuartzEngine } from '../runtime/quartz-engine-store';
import type { ExternalThemeReference } from './theme-contract';
import {
  themeOptionsFromSchemaDefaults,
  type ThemeOptionsSchema,
} from './theme-options-schema';
import { ThemeInstaller } from './theme-installer';
import { ThemeStore, type InstalledTheme } from './theme-store';
import { ThemeTrustStore } from './theme-trust-store';

export interface ThemeCandidate {
  reference: ExternalThemeReference;
  packageName: string;
  displayName: string;
  version: string;
  integrity: string;
  capabilities: readonly string[];
  publisher?: { name?: string; email?: string };
  optionsSchema?: ThemeOptionsSchema;
}

export interface ThemePanelState {
  configured?: ThemeCandidate & { trusted: boolean };
  configuredError?: { code: string; message: string };
  installed: Array<ThemeCandidate & { trusted: boolean }>;
}

export class ThemeManagementService {
  constructor(
    private readonly vaultRoot: string,
    private readonly store: ThemeStore,
    private readonly installer: ThemeInstaller,
    private readonly trust: ThemeTrustStore,
    private readonly ensureEngine: (signal?: AbortSignal) => Promise<ReadyQuartzEngine>,
  ) {}

  async panelState(
    configured?: ExternalThemeReference,
    signal?: AbortSignal,
  ): Promise<ThemePanelState> {
    const engine = await this.ensureEngine(signal);
    const installedThemes = await this.store.listInstalled(engine.quartzVersion, signal);
    const installed = await Promise.all(installedThemes.map(async (theme) => ({
      ...candidate(theme, referenceForInstalled(theme)),
      trusted: await this.trust.isTrusted(theme.receipt),
    })));
    if (configured === undefined) return { installed };
    try {
      const theme = configured.source === 'npm'
        ? await this.store.resolveExact(
          configured.package,
          configured.version,
          configured.integrity,
          engine.quartzVersion,
          signal,
        )
        : await this.store.resolveIntegrity(
          configured.integrity,
          engine.quartzVersion,
          signal,
        );
      return {
        configured: {
          ...candidate(theme, configured),
          trusted: await this.trust.isTrusted(theme.receipt),
        },
        installed,
      };
    } catch (error) {
      return {
        configuredError: {
          code: errorCode(error) ?? 'theme-unavailable',
          message: error instanceof Error ? error.message : 'Theme is unavailable.',
        },
        installed,
      };
    }
  }

  async installNpm(
    packageName: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<ThemeCandidate> {
    const engine = await this.ensureEngine(signal);
    const result = await this.installer.installNpm(
      packageName,
      version,
      engine.quartzVersion,
      signal,
    );
    return candidate(result.installed, result.reference);
  }

  async importLocal(selectedFile: string, signal?: AbortSignal): Promise<ThemeCandidate> {
    const engine = await this.ensureEngine(signal);
    const result = await this.installer.importLocal(
      this.vaultRoot,
      selectedFile,
      engine.quartzVersion,
      signal,
    );
    return candidate(result.installed, result.reference);
  }

  async importLocalArchive(
    fileName: string,
    archive: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ThemeCandidate> {
    const engine = await this.ensureEngine(signal);
    const result = await this.installer.importLocalArchive(
      this.vaultRoot,
      fileName,
      archive,
      engine.quartzVersion,
      signal,
    );
    return candidate(result.installed, result.reference);
  }

  async confirmTrust(candidateInput: ThemeCandidate): Promise<void> {
    const engine = await this.ensureEngine();
    const installed = candidateInput.reference.source === 'npm'
      ? await this.store.resolveExact(
        candidateInput.reference.package,
        candidateInput.reference.version,
        candidateInput.reference.integrity,
        engine.quartzVersion,
      )
      : await this.store.resolveIntegrity(
        candidateInput.reference.integrity,
        engine.quartzVersion,
      );
    await this.trust.confirm(installed.receipt);
  }

  async repair(reference: ExternalThemeReference, signal?: AbortSignal): Promise<void> {
    const engine = await this.ensureEngine(signal);
    await this.installer.repair(this.vaultRoot, reference, engine.quartzVersion, signal);
  }

  async uninstall(candidateInput: ThemeCandidate, active?: ExternalThemeReference): Promise<void> {
    await this.store.uninstall({
      packageName: candidateInput.packageName,
      version: candidateInput.version,
      integrity: candidateInput.integrity,
    }, async (theme) => active !== undefined &&
      active.integrity === theme.integrity &&
      (active.source === 'local' ||
        active.package === theme.packageName && active.version === theme.version));
  }
}

function candidate(installed: InstalledTheme, reference: ExternalThemeReference): ThemeCandidate {
  const normalizedReference = structuredClone(reference);
  if (
    installed.optionsSchema !== undefined &&
    Object.keys(normalizedReference.options).length === 0
  ) {
    normalizedReference.options = themeOptionsFromSchemaDefaults(installed.optionsSchema);
  }
  return {
    reference: normalizedReference,
    packageName: installed.receipt.packageName,
    displayName: installed.receipt.manifest.metadata.displayName,
    version: installed.receipt.version,
    integrity: installed.receipt.integrity,
    capabilities: [...installed.receipt.manifest.metadata.capabilities],
    ...(installed.receipt.source.kind === 'npm' && installed.receipt.source.publisher !== undefined
      ? { publisher: { ...installed.receipt.source.publisher } }
      : {}),
    ...(installed.optionsSchema === undefined
      ? {}
      : { optionsSchema: installed.optionsSchema }),
  };
}

function referenceForInstalled(installed: InstalledTheme): ExternalThemeReference {
  return installed.receipt.source.kind === 'npm'
    ? {
      source: 'npm',
      package: installed.receipt.packageName,
      version: installed.receipt.version,
      integrity: installed.receipt.integrity,
      options: {},
    }
    : {
      source: 'local',
      artifact: installed.receipt.source.artifact,
      integrity: installed.receipt.integrity,
      options: {},
    };
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
