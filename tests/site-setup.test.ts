import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SiteSetupService,
  type CloudflarePagesProjectBoundary,
  type SetupDraft,
  type SetupProject,
} from '../src/setup/site-setup';

describe('site setup service', () => {
  const vaults: string[] = [];

  afterEach(async () => {
    await Promise.all(
      vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })),
    );
  });

  it('keeps a new-site plan local until final confirmation, then creates and scans', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const notePath = join(vault, 'notes', 'first.md');
    await writeFile(notePath, '# First note\n', 'utf8');
    const findProject = vi.fn(async () => undefined);
    const createProject = vi.fn(async (): Promise<SetupProject> => ({
      id: 'project-1',
      name: 'my-wiki',
      accountId: 'account-1',
      pagesDevUrl: 'https://my-wiki.pages.dev',
      compatible: true,
    }));
    const projects: CloudflarePagesProjectBoundary = {
      ...recordingProjects(),
      findProject,
      createProject,
    };
    const scan = vi.fn(async () => ({ candidateCount: 1, eligibleCount: 1 }));
    const service = new SiteSetupService(vault, { projects, scan });
    const draft = newSiteDraft();

    await expect(service.review(draft)).resolves.toMatchObject({
      cloudflare: { projectName: 'my-wiki', action: 'create' },
      candidateCount: 1,
    });
    expect(findProject).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    await expect(access(join(vault, '.publish', 'site.yml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(service.confirm(draft)).resolves.toMatchObject({
      stage: 'ready',
      project: { name: 'my-wiki', created: true },
      scan: { candidateCount: 1, eligibleCount: 1 },
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    await expect(readFile(join(vault, '.publish', 'site.yml'), 'utf8')).resolves.toContain(
      'project_name: my-wiki',
    );
    await expect(readFile(notePath, 'utf8')).resolves.toBe('# First note\n');
  });

  it('reuses a matching project after the local configuration step fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    let remoteProject: Awaited<ReturnType<CloudflarePagesProjectBoundary['createProject']>>;
    const createProject = vi.fn(async () => {
      remoteProject = {
        id: 'project-1',
        name: 'my-wiki',
        accountId: 'account-1',
        pagesDevUrl: 'https://my-wiki.pages.dev',
        compatible: true,
      };
      return remoteProject;
    });
    const saveConfig = vi
      .fn<(config: SetupDraft['config']) => Promise<void>>()
      .mockRejectedValueOnce(new Error('local disk is temporarily unavailable'));
    const service = new SiteSetupService(vault, {
      projects: {
        ...recordingProjects(),
        findProject: vi.fn(async () => remoteProject),
        createProject,
      },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
      saveConfig,
    });

    await expect(service.confirm(newSiteDraft())).rejects.toThrow('local disk');
    await expect(service.confirm(newSiteDraft())).resolves.toMatchObject({
      project: { created: false, id: 'project-1' },
    });
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('resumes only the final scan when the confirmed configuration was already written', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const scan = vi
      .fn<() => Promise<{ candidateCount: number; eligibleCount: number }>>()
      .mockResolvedValueOnce({ candidateCount: 1, eligibleCount: 1 })
      .mockRejectedValueOnce(new Error('scan temporarily unavailable'))
      .mockResolvedValueOnce({ candidateCount: 1, eligibleCount: 1 });
    const projectBoundary = recordingProjects();
    const createProject = vi.fn((input: { accountId: string; projectName: string }) =>
      projectBoundary.createProject(input),
    );
    const service = new SiteSetupService(vault, {
      projects: { ...projectBoundary, createProject },
      scan,
    });

    await expect(service.confirm(newSiteDraft())).rejects.toThrow('scan temporarily unavailable');
    await expect(service.confirm(newSiteDraft())).resolves.toMatchObject({
      stage: 'ready',
      scan: { candidateCount: 1, eligibleCount: 1 },
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('refuses to resume the final scan after the formal configuration changes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const scan = vi
      .fn<() => Promise<{ candidateCount: number; eligibleCount: number }>>()
      .mockResolvedValueOnce({ candidateCount: 1, eligibleCount: 1 })
      .mockRejectedValueOnce(new Error('scan temporarily unavailable'));
    const service = new SiteSetupService(vault, {
      projects: recordingProjects(),
      scan,
    });

    await expect(service.confirm(newSiteDraft())).rejects.toThrow('scan temporarily unavailable');
    const configPath = join(vault, '.publish', 'site.yml');
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace('name: My Wiki', 'name: Changed elsewhere'),
      'utf8',
    );

    await expect(service.confirm(newSiteDraft())).rejects.toMatchObject({
      code: 'setup-config-changed',
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not mark setup ready or write formal configuration when custom-domain binding fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const projects = recordingProjects();
    projects.ensureCustomDomain = vi.fn(async () => ({
      status: 'failed' as const,
      message: 'DNS record is missing',
    }));
    const service = new SiteSetupService(vault, {
      projects,
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });
    const draft = newSiteDraft();
    draft.cloudflare.domain = { kind: 'custom', hostname: 'wiki.example.com' };

    await expect(service.confirm(draft)).rejects.toMatchObject({
      code: 'custom-domain-failed',
    });
    await expect(access(join(vault, '.publish', 'site.yml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('coalesces concurrent final confirmations so only one project is created', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createProject = vi.fn(async () => {
      await createGate;
      return {
        id: 'project-1',
        name: 'my-wiki',
        accountId: 'account-1',
        pagesDevUrl: 'https://my-wiki.pages.dev',
        compatible: true,
      };
    });
    const service = new SiteSetupService(vault, {
      projects: { ...recordingProjects(), createProject },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });

    const first = service.confirm(newSiteDraft());
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const second = service.confirm(newSiteDraft());
    releaseCreate?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('reports truthful confirmation stages in the order they execute', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const stages: string[] = [];
    const service = new SiteSetupService(vault, {
      projects: recordingProjects(),
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });

    await service.confirm(newSiteDraft(), (stage) => stages.push(stage));

    expect(stages).toEqual(['validate', 'project', 'domain', 'config', 'scan']);
  });

  it('rejects a different plan while another final confirmation is in progress', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    let releaseCreate: (() => void) | undefined;
    const createProject = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return {
        id: 'project-1',
        name: 'my-wiki',
        accountId: 'account-1',
        pagesDevUrl: 'https://my-wiki.pages.dev',
        compatible: true,
      };
    });
    const service = new SiteSetupService(vault, {
      projects: { ...recordingProjects(), createProject },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });
    const first = service.confirm(newSiteDraft());
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    const different = newSiteDraft();
    different.cloudflare.projectName = 'other-wiki';
    different.config.cloudflare.projectName = 'other-wiki';

    const second = service.confirm(different);
    releaseCreate?.();
    await expect(second).rejects.toMatchObject({
      code: 'different-plan-in-progress',
    });
    await expect(first).resolves.toMatchObject({ project: { name: 'my-wiki' } });
  });

  it('uses the normal content scanner to review a draft without writing site.yml', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, 'notes', 'draft.md'), '# Draft only\n', 'utf8');
    const service = new SiteSetupService(vault, { projects: recordingProjects() });

    await expect(service.review(newSiteDraft())).resolves.toMatchObject({
      candidateCount: 1,
      eligibleCount: 1,
    });
    await expect(access(join(vault, '.publish', 'site.yml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports candidate counts for each configured content root', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    await mkdir(join(vault, 'guide'), { recursive: true });
    await writeFile(join(vault, 'notes', 'one.md'), '# One\n', 'utf8');
    await writeFile(join(vault, 'guide', 'two.md'), '# Two\n', 'utf8');
    await writeFile(join(vault, 'guide', 'three.md'), '# Three\n', 'utf8');
    const draft = newSiteDraft();
    draft.config.contentRoots.push({ path: 'guide', publicRoot: '/guide' });
    const service = new SiteSetupService(vault, { projects: recordingProjects() });

    await expect(service.review(draft)).resolves.toMatchObject({
      roots: [
        { path: 'notes', candidateCount: 1 },
        { path: 'guide', candidateCount: 2 },
      ],
    });
  });

  it('rejects a non-canonical pages.dev URL returned by the adapter', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    await mkdir(join(vault, 'notes'), { recursive: true });
    const service = new SiteSetupService(vault, {
      projects: {
        ...recordingProjects(),
        createProject: async () => ({
          id: 'project-1',
          name: 'my-wiki',
          accountId: 'account-1',
          pagesDevUrl: 'https://my-wiki.pages.dev:444/unexpected?debug=1',
          compatible: true,
        }),
      },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });

    await expect(service.confirm(newSiteDraft())).rejects.toMatchObject({
      code: 'invalid-pages-domain',
    });
  });

  it('lists existing compatible Pages projects for a binding plan without creating one', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    const listProjects = vi.fn(async (): Promise<SetupProject[]> => [{
      id: 'project-existing',
      name: 'existing-wiki',
      accountId: 'account-1',
      pagesDevUrl: 'https://existing-wiki.pages.dev',
      compatible: true,
    }]);
    const createProject = vi.fn();
    const service = new SiteSetupService(vault, {
      projects: { ...recordingProjects(), listProjects, createProject },
      scan: async () => ({ candidateCount: 0, eligibleCount: 0 }),
    });

    await expect(service.listProjects({ id: 'account-1', name: 'Personal' })).resolves.toEqual([
      expect.objectContaining({ name: 'existing-wiki' }),
    ]);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('verifies an existing project and connects its custom domain without creating a project', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'pages-publish-setup-'));
    vaults.push(vault);
    const project = {
      id: 'project-existing',
      name: 'existing-wiki',
      accountId: 'account-1',
      pagesDevUrl: 'https://existing-wiki.pages.dev',
      compatible: true,
    };
    const createProject = vi.fn();
    const ensureCustomDomain = vi.fn(async (_input: {
      project: SetupProject;
      hostname: string;
    }) => ({ status: 'pending' as const }));
    const service = new SiteSetupService(vault, {
      projects: {
        ...recordingProjects(),
        findProject: async () => project,
        createProject,
        ensureCustomDomain,
      },
    });

    await expect(service.verifyConfiguredProject(
      { id: 'account-1', name: 'Personal' },
      'existing-wiki',
    )).resolves.toMatchObject(project);
    await expect(service.connectConfiguredCustomDomain(
      { id: 'account-1', name: 'Personal' },
      'existing-wiki',
      'docs.example.com',
    )).resolves.toEqual({ status: 'pending' });
    expect(ensureCustomDomain.mock.calls[0]?.[0]).toMatchObject({
      project,
      hostname: 'docs.example.com',
    });
    expect(createProject).not.toHaveBeenCalled();
  });
});

function newSiteDraft(): SetupDraft {
  return {
    config: {
      version: 1,
      site: { name: 'My Wiki', homeLayout: 'sections', timezone: 'Asia/Shanghai' },
      contentRoots: [{ path: 'notes', publicRoot: '/notes' }],
      assets: { exclude: [] },
      features: { search: true, graph: true },
      cloudflare: { projectName: 'my-wiki' },
    },
    cloudflare: {
      account: { id: 'account-1', name: 'Personal' },
      action: 'create',
      projectName: 'my-wiki',
      domain: { kind: 'pages-dev' },
    },
  };
}

function recordingProjects(): CloudflarePagesProjectBoundary {
  return {
    findProject: vi.fn(async () => undefined),
    createProject: vi.fn(async () => ({
      id: 'project-1',
      name: 'my-wiki',
      accountId: 'account-1',
      pagesDevUrl: 'https://my-wiki.pages.dev',
      compatible: true,
    })),
    verifyProject: vi.fn(async (project: SetupProject) => project),
    ensureCustomDomain: vi.fn(async () => ({ status: 'pending' as const })),
  };
}
