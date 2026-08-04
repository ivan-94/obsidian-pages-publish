import type { ReadyQuartzEngine } from '../runtime/quartz-engine-store';
import type {
  ExternalThemeReference,
  ThemeOptions,
} from './theme-contract';
import { validateThemeOptionsAgainstSchema } from './theme-options-schema';
import type { InstalledTheme } from './theme-store';
import { ThemeStore } from './theme-store';
import { ThemeTrustStore } from './theme-trust-store';
import {
  inspectThemeRuntime,
  type InspectedThemeDescriptor,
} from './theme-runtime-inspector';

export interface ResolvedBuildTheme {
  installed: InstalledTheme;
  descriptor: InspectedThemeDescriptor;
  options: ThemeOptions;
}

export class ThemeResolutionError extends Error {
  readonly name = 'ThemeResolutionError';

  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class InstalledThemeResolver {
  constructor(
    private readonly rootDirectory: string,
    private readonly store: ThemeStore,
    private readonly trustStore: ThemeTrustStore,
  ) {}

  async resolve(
    reference: ExternalThemeReference,
    engine: ReadyQuartzEngine,
    signal?: AbortSignal,
  ): Promise<ResolvedBuildTheme> {
    let installed: InstalledTheme;
    try {
      installed = reference.source === 'npm'
        ? await this.store.resolveExact(
          reference.package,
          reference.version,
          reference.integrity,
          engine.quartzVersion,
          signal,
        )
        : await this.store.resolveIntegrity(
          reference.integrity,
          engine.quartzVersion,
          signal,
        );
    } catch (error) {
      throw new ThemeResolutionError(
        errorCode(error) ?? 'theme-not-installed',
        'Configured theme is not installed or no longer verifies.',
        error,
      );
    }
    if (!(await this.trustStore.isTrusted(installed.receipt))) {
      throw new ThemeResolutionError(
        'theme-not-trusted',
        'Configured executable theme has not been explicitly trusted for this integrity.',
      );
    }
    let options: ThemeOptions;
    try {
      options = installed.optionsSchema === undefined
        ? reference.options
        : validateThemeOptionsAgainstSchema(
          reference.options,
          installed.optionsSchema,
        );
    } catch (error) {
      throw new ThemeResolutionError(
        'theme-options-invalid',
        'Configured theme options do not satisfy the installed theme schema.',
        error,
      );
    }
    let descriptor: InspectedThemeDescriptor;
    try {
      descriptor = await inspectThemeRuntime({
        rootDirectory: this.rootDirectory,
        nodeExecutable: engine.nodeExecutable,
        engineDirectory: engine.engineDirectory,
        packageDirectory: installed.packageDirectory,
        manifest: installed.receipt.manifest,
        options,
        signal,
      });
    } catch (error) {
      throw new ThemeResolutionError(
        'theme-build-load-failed',
        'Configured theme entry failed in the restricted runtime.',
        error,
      );
    }
    return { installed, descriptor, options };
  }
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
