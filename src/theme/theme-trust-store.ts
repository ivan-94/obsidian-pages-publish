import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertExactThemeVersion,
  assertThemeIntegrity,
  assertThemePackageName,
  PAGES_PUBLISH_THEME_CAPABILITIES,
  type ThemeCapability,
} from './theme-contract';
import type { ThemeInstallReceipt } from './theme-store';

export interface ThemeTrustReceipt {
  packageName: string;
  displayName: string;
  version: string;
  integrity: string;
  capabilities: ThemeCapability[];
  executableCodeAccepted: true;
  clientScriptsAccepted: boolean;
  acceptedAt: string;
}

interface ThemeTrustFile {
  formatVersion: 1;
  receipts: ThemeTrustReceipt[];
}

export class ThemeTrustStore {
  private activeWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isTrusted(receipt: ThemeInstallReceipt): Promise<boolean> {
    const trust = await this.read();
    return trust.receipts.some((item) =>
      item.packageName === receipt.packageName &&
      item.version === receipt.version &&
      item.integrity === receipt.integrity &&
      sameCapabilities(item.capabilities, receipt.manifest.metadata.capabilities) &&
      item.executableCodeAccepted &&
      item.clientScriptsAccepted === receipt.manifest.metadata.capabilities.includes('clientScripts'));
  }

  async confirm(receipt: ThemeInstallReceipt): Promise<ThemeTrustReceipt> {
    const trustReceipt: ThemeTrustReceipt = {
      packageName: receipt.packageName,
      displayName: receipt.manifest.metadata.displayName,
      version: receipt.version,
      integrity: receipt.integrity,
      capabilities: [...receipt.manifest.metadata.capabilities].sort(),
      executableCodeAccepted: true,
      clientScriptsAccepted: receipt.manifest.metadata.capabilities.includes('clientScripts'),
      acceptedAt: this.now().toISOString(),
    };
    this.activeWrite = this.activeWrite.then(async () => {
      const current = await this.read();
      current.receipts = current.receipts.filter((item) =>
        item.packageName !== trustReceipt.packageName ||
        item.version !== trustReceipt.version ||
        item.integrity !== trustReceipt.integrity);
      current.receipts.push(trustReceipt);
      current.receipts.sort((left, right) =>
        `${left.packageName}@${left.version}:${left.integrity}`
          .localeCompare(`${right.packageName}@${right.version}:${right.integrity}`));
      await this.write(current);
    });
    await this.activeWrite;
    return trustReceipt;
  }

  private async read(): Promise<ThemeTrustFile> {
    try {
      const value = JSON.parse(await readFile(this.path(), 'utf8')) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Theme trust file must be an object.');
      }
      const trust = value as Partial<ThemeTrustFile>;
      if (trust.formatVersion !== 1 || !Array.isArray(trust.receipts)) {
        throw new Error('Theme trust file has an unsupported format.');
      }
      return {
        formatVersion: 1,
        receipts: trust.receipts.map((receipt, index) =>
          validateTrustReceipt(receipt, `receipts[${index}]`)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { formatVersion: 1, receipts: [] };
      }
      throw error;
    }
  }

  private async write(value: ThemeTrustFile): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private path(): string {
    return join(this.rootDirectory, 'themes', 'trust-receipts.json');
  }
}

function validateTrustReceipt(value: unknown, path: string): ThemeTrustReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Theme trust ${path} must be an object.`);
  }
  const receipt = value as Record<string, unknown>;
  const known = new Set([
    'packageName',
    'displayName',
    'version',
    'integrity',
    'capabilities',
    'executableCodeAccepted',
    'clientScriptsAccepted',
    'acceptedAt',
  ]);
  if (Object.keys(receipt).some((key) => !known.has(key))) {
    throw new Error(`Theme trust ${path} contains an unknown field.`);
  }
  if (
    typeof receipt.packageName !== 'string'
    || typeof receipt.version !== 'string'
    || typeof receipt.integrity !== 'string'
  ) {
    throw new Error(`Theme trust ${path} identity must contain strings.`);
  }
  assertThemePackageName(receipt.packageName, `${path}.packageName`);
  assertExactThemeVersion(receipt.version, `${path}.version`);
  assertThemeIntegrity(receipt.integrity, `${path}.integrity`);
  if (typeof receipt.displayName !== 'string' || receipt.displayName.trim() === '') {
    throw new Error(`Theme trust ${path}.displayName must be a non-empty string.`);
  }
  if (
    !isThemeCapabilities(receipt.capabilities)
    || new Set(receipt.capabilities).size !== receipt.capabilities.length
  ) {
    throw new Error(`Theme trust ${path}.capabilities is invalid.`);
  }
  if (
    receipt.executableCodeAccepted !== true
    || typeof receipt.clientScriptsAccepted !== 'boolean'
  ) {
    throw new Error(`Theme trust ${path} must record explicit execution decisions.`);
  }
  if (
    typeof receipt.acceptedAt !== 'string'
    || Number.isNaN(Date.parse(receipt.acceptedAt))
    || new Date(receipt.acceptedAt).toISOString() !== receipt.acceptedAt
  ) {
    throw new Error(`Theme trust ${path}.acceptedAt must be an ISO timestamp.`);
  }
  return {
    packageName: receipt.packageName,
    displayName: receipt.displayName.trim(),
    version: receipt.version,
    integrity: receipt.integrity,
    capabilities: [...receipt.capabilities],
    executableCodeAccepted: true,
    clientScriptsAccepted: receipt.clientScriptsAccepted,
    acceptedAt: receipt.acceptedAt,
  };
}

function isThemeCapabilities(value: unknown): value is ThemeCapability[] {
  return Array.isArray(value) && value.every((item: unknown) =>
    typeof item === 'string'
    && PAGES_PUBLISH_THEME_CAPABILITIES.includes(item as ThemeCapability));
}

function sameCapabilities(left: ThemeCapability[], right: ThemeCapability[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
