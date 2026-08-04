import { createHash } from 'crypto';
import { access } from 'fs/promises';
import { join } from 'path';
import {
  loadSiteConfigFromDirectory,
  saveSiteConfigToDirectory,
  validateSiteConfigForDirectory,
  type SiteConfigV1,
} from '../config/site-config';
import { scanSiteFromDirectory, type SiteScanResult } from '../content/site-scanner';

export interface SetupAccount {
  id: string;
  name: string;
}

export interface SetupProject {
  id: string;
  name: string;
  accountId: string;
  pagesDevUrl: string;
  compatible: boolean;
}

export interface SetupCustomDomainResult {
  status: 'pending' | 'active' | 'failed';
  message?: string;
}

/** The non-secret Cloudflare project boundary used by the first-site wizard. */
export interface CloudflarePagesProjectBoundary {
  findProject(input: { accountId: string; projectName: string }): Promise<SetupProject | undefined>;
  listProjects?(input: { accountId: string }): Promise<SetupProject[]>;
  createProject(input: { accountId: string; projectName: string }): Promise<SetupProject>;
  verifyProject(project: SetupProject): Promise<SetupProject>;
  ensureCustomDomain(input: {
    project: SetupProject;
    hostname: string;
  }): Promise<SetupCustomDomainResult>;
  /** Read-only status refresh for a previously configured custom domain. */
  inspectCustomDomain?(input: {
    project: SetupProject;
    hostname: string;
  }): Promise<SetupCustomDomainResult>;
}

export interface SetupDraft {
  config: SiteConfigV1;
  cloudflare: {
    account: SetupAccount;
    action: 'create' | 'bind';
    projectName: string;
    domain: { kind: 'pages-dev' } | { kind: 'custom'; hostname: string };
  };
}

export interface SetupContentSummary {
  candidateCount: number;
  eligibleCount: number;
  issues?: SiteScanResult['issues'];
  examples?: Array<{ sourcePath: string; url: string }>;
  roots?: Array<{ path: string; candidateCount: number }>;
}

export interface SetupReview {
  config: SiteConfigV1;
  cloudflare: {
    account: SetupAccount;
    action: 'create' | 'bind';
    projectName: string;
    domain: SetupDraft['cloudflare']['domain'];
  };
  candidateCount: number;
  eligibleCount: number;
  issues: SiteScanResult['issues'];
  examples: Array<{ sourcePath: string; url: string }>;
  roots?: Array<{ path: string; candidateCount: number }>;
}

export interface SetupResult {
  stage: 'ready';
  project: SetupProject & { created: boolean };
  domain: SetupCustomDomainResult | { status: 'active'; url: string };
  scan: SetupContentSummary;
}

export type SetupProgressStage = 'validate' | 'project' | 'domain' | 'config' | 'scan';

export class SiteSetupError extends Error {
  readonly name = 'SiteSetupError';

  constructor(
    readonly code:
      | 'already-configured'
      | 'existing-project-not-found'
      | 'project-account-mismatch'
      | 'project-incompatible'
      | 'invalid-pages-domain'
      | 'custom-domain-failed'
      | 'different-plan-in-progress'
      | 'setup-config-changed'
      | 'project-list-unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Coordinates first-site creation without storing credentials or wizard state.
 * Calling review is side-effect-free; all remote and formal-local work begins
 * only in confirm.
 */
export class SiteSetupService {
  private readonly scan: (config: SiteConfigV1) => Promise<SetupContentSummary>;
  private readonly saveConfig: (config: SiteConfigV1) => Promise<void>;
  private confirmation:
    | { planDigest: string; result: Promise<SetupResult> }
    | undefined;
  private resumableConfirmation:
    | {
      planDigest: string;
      config: SiteConfigV1;
      project: SetupResult['project'];
      domain: SetupResult['domain'];
    }
    | undefined;

  constructor(
    private readonly vaultRoot: string,
    private readonly dependencies: {
      projects: CloudflarePagesProjectBoundary;
      scan?: (config: SiteConfigV1) => Promise<SetupContentSummary>;
      saveConfig?: (config: SiteConfigV1) => Promise<void>;
    },
  ) {
    this.scan = dependencies.scan ?? (async (config) => {
      const result = await scanSiteFromDirectory(this.vaultRoot, { config });
      const blockerPaths = new Set(
        result.issues
          .filter((issue) => issue.severity === 'blocker')
          .map((issue) => issue.path),
      );
      return {
        candidateCount: result.candidates.length,
        eligibleCount: result.candidates.filter(
          (candidate) => !blockerPaths.has(candidate.sourcePath),
        ).length,
        issues: result.issues,
        examples: (result.routePlan?.articles ?? [])
          .slice(0, 3)
          .map((article) => ({ sourcePath: article.sourcePath, url: article.url })),
        roots: config.contentRoots.map((root) => ({
          path: root.path,
          candidateCount: result.candidates.filter((candidate) =>
            isSourceInsideRoot(candidate.sourcePath, root.path),
          ).length,
        })),
      };
    });
    this.saveConfig = dependencies.saveConfig ?? (async (config) => {
      await saveSiteConfigToDirectory(this.vaultRoot, config, {
        expectedRevision: null,
      });
    });
  }

  async review(draft: SetupDraft): Promise<SetupReview> {
    const config = await this.validateDraft(draft);
    const scan = await this.scan(config);
    return {
      config,
      cloudflare: structuredClone(draft.cloudflare),
      candidateCount: scan.candidateCount,
      eligibleCount: scan.eligibleCount,
      issues: scan.issues ?? [],
      examples: scan.examples ?? [],
      ...(scan.roots === undefined ? {} : { roots: scan.roots }),
    };
  }

  async listProjects(account: SetupAccount): Promise<SetupProject[]> {
    if (!this.dependencies.projects.listProjects) {
      throw new SiteSetupError(
        'project-list-unavailable',
        'Listing existing Pages projects is unavailable for this Cloudflare adapter.',
      );
    }
    const projects = await this.dependencies.projects.listProjects({ accountId: account.id });
    return projects.filter((project) => project.accountId === account.id);
  }

  async verifyConfiguredProject(
    account: SetupAccount,
    projectName: string,
  ): Promise<SetupProject> {
    const project = await this.dependencies.projects.findProject({
      accountId: account.id,
      projectName,
    });
    if (!project) {
      throw new SiteSetupError(
        'existing-project-not-found',
        'The selected Pages project was not found in this Cloudflare account.',
      );
    }
    const verified = await this.dependencies.projects.verifyProject(project);
    this.assertProjectMatches(verified, {
      account,
      action: 'bind',
      projectName,
      domain: { kind: 'pages-dev' },
    });
    return verified;
  }

  async connectConfiguredCustomDomain(
    account: SetupAccount,
    projectName: string,
    hostname: string,
  ): Promise<SetupCustomDomainResult> {
    const project = await this.verifyConfiguredProject(account, projectName);
    const result = await this.dependencies.projects.ensureCustomDomain({
      project,
      hostname,
    });
    if (result.status === 'failed') {
      throw new SiteSetupError(
        'custom-domain-failed',
        result.message ?? 'Cloudflare could not bind the custom domain.',
      );
    }
    return result;
  }

  confirm(
    draft: SetupDraft,
    onProgress: (stage: SetupProgressStage) => void = () => undefined,
  ): Promise<SetupResult> {
    const frozenDraft = structuredClone(draft);
    const planDigest = createHash('sha256')
      .update(JSON.stringify(frozenDraft))
      .digest('hex');
    if (this.confirmation) {
      if (this.confirmation.planDigest === planDigest) return this.confirmation.result;
      return Promise.reject(new SiteSetupError(
        'different-plan-in-progress',
        'Another site setup plan is already being created. Wait for it to finish before changing the plan.',
      ));
    }
    const confirmation = this.confirmExclusive(frozenDraft, planDigest, onProgress);
    this.confirmation = { planDigest, result: confirmation };
    void confirmation.finally(() => {
      if (this.confirmation?.result === confirmation) this.confirmation = undefined;
    }).catch(() => undefined);
    return confirmation;
  }

  private async confirmExclusive(
    draft: SetupDraft,
    planDigest: string,
    onProgress: (stage: SetupProgressStage) => void,
  ): Promise<SetupResult> {
    if (this.resumableConfirmation) {
      if (this.resumableConfirmation.planDigest !== planDigest) {
        throw new SiteSetupError(
          'different-plan-in-progress',
          'The confirmed site configuration is waiting for its final scan. Retry that plan before changing it.',
        );
      }
      const resumed = this.resumableConfirmation;
      await this.assertResumableConfig(resumed.config);
      for (const stage of ['validate', 'project', 'domain', 'config', 'scan'] as const) {
        onProgress(stage);
      }
      const scan = await this.scan(resumed.config);
      this.resumableConfirmation = undefined;
      return { stage: 'ready', project: resumed.project, domain: resumed.domain, scan };
    }
    await this.assertUnconfigured();
    onProgress('validate');
    const review = await this.review(draft);
    onProgress('project');
    const project = await this.ensureProject(review.cloudflare);
    onProgress('domain');
    const domain = await this.ensureDomain(project, review.cloudflare.domain);
    const confirmedConfig = structuredClone(review.config);
    confirmedConfig.cloudflare.pagesDevDomain = new URL(project.pagesDevUrl).hostname;
    onProgress('config');
    await this.saveConfig(confirmedConfig);
    this.resumableConfirmation = {
      planDigest,
      config: confirmedConfig,
      project,
      domain,
    };
    onProgress('scan');
    const scan = await this.scan(confirmedConfig);
    this.resumableConfirmation = undefined;
    return { stage: 'ready', project, domain, scan };
  }

  private async assertResumableConfig(expected: SiteConfigV1): Promise<void> {
    try {
      const loaded = await loadSiteConfigFromDirectory(this.vaultRoot);
      if (
        loaded.status === 'editable'
        && JSON.stringify(loaded.config) === JSON.stringify(expected)
      ) {
        return;
      }
    } catch {
      // Missing, unreadable, or invalid formal configuration cannot resume.
    }
    this.resumableConfirmation = undefined;
    throw new SiteSetupError(
      'setup-config-changed',
      'The saved site configuration changed after setup. Open settings or the configuration file to repair it before scanning.',
    );
  }

  private async validateDraft(draft: SetupDraft): Promise<SiteConfigV1> {
    const config = structuredClone(draft.config);
    config.cloudflare = {
      projectName: draft.cloudflare.projectName,
      ...(draft.cloudflare.domain.kind === 'custom'
        ? { customDomain: draft.cloudflare.domain.hostname }
        : {}),
    };
    return validateSiteConfigForDirectory(this.vaultRoot, config);
  }

  private async assertUnconfigured(): Promise<void> {
    try {
      await access(join(this.vaultRoot, '.publish', 'site.yml'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new SiteSetupError(
      'already-configured',
      'This Vault already has a site configuration. Use settings to change its binding.',
    );
  }

  private async ensureProject(
    plan: SetupDraft['cloudflare'],
  ): Promise<SetupProject & { created: boolean }> {
    let project = await this.dependencies.projects.findProject({
      accountId: plan.account.id,
      projectName: plan.projectName,
    });
    let created = false;
    if (!project && plan.action === 'bind') {
      throw new SiteSetupError(
        'existing-project-not-found',
        'The selected Pages project was not found in this Cloudflare account.',
      );
    }
    if (!project) {
      try {
        project = await this.dependencies.projects.createProject({
          accountId: plan.account.id,
          projectName: plan.projectName,
        });
        created = true;
      } catch (error) {
        project = await this.dependencies.projects.findProject({
          accountId: plan.account.id,
          projectName: plan.projectName,
        });
        if (!project) throw error;
      }
    }
    const verified = await this.dependencies.projects.verifyProject(project);
    this.assertProjectMatches(verified, plan);
    return { ...verified, created };
  }

  private assertProjectMatches(
    project: SetupProject,
    plan: SetupDraft['cloudflare'],
  ): void {
    if (project.accountId !== plan.account.id || project.name !== plan.projectName) {
      throw new SiteSetupError(
        'project-account-mismatch',
        'The selected Pages project does not belong to the selected Cloudflare account.',
      );
    }
    if (!project.compatible) {
      throw new SiteSetupError(
        'project-incompatible',
        'The selected Pages project is not compatible with this publishing workflow.',
      );
    }
    try {
      const url = new URL(project.pagesDevUrl);
      const hostnameLabels = url.hostname.split('.');
      const projectSubdomain = hostnameLabels[0] ?? '';
      if (
        url.protocol !== 'https:' ||
        url.port !== '' ||
        hostnameLabels.length !== 3 ||
        hostnameLabels[1] !== 'pages' ||
        hostnameLabels[2] !== 'dev' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(projectSubdomain) ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== '' ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw new Error('invalid pages.dev URL');
      }
    } catch {
      throw new SiteSetupError(
        'invalid-pages-domain',
        'Cloudflare returned an invalid pages.dev domain for this project.',
      );
    }
  }

  private async ensureDomain(
    project: SetupProject,
    domain: SetupDraft['cloudflare']['domain'],
  ): Promise<SetupCustomDomainResult | { status: 'active'; url: string }> {
    if (domain.kind === 'pages-dev') {
      return { status: 'active', url: project.pagesDevUrl };
    }
    const result = await this.dependencies.projects.ensureCustomDomain({
      project,
      hostname: domain.hostname,
    });
    if (result.status === 'failed') {
      throw new SiteSetupError(
        'custom-domain-failed',
        result.message ?? 'Cloudflare could not bind the custom domain.',
      );
    }
    return result;
  }
}

function isSourceInsideRoot(sourcePath: string, rootPath: string): boolean {
  const normalized = rootPath.replace(/^\.\//, '').replace(/\/$/, '');
  return normalized === '' || normalized === '.' || sourcePath.startsWith(`${normalized}/`);
}
