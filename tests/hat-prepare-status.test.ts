import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(executeFile);
const directories: string[] = [];
const prepareScript = join(
  process.cwd(),
  'hats/20260801-s17-release-candidate/prepare.sh',
);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('S17 HAT prepare status', () => {
  it('reports prepared only when the marked test Vault and candidate package match the HAT baseline', async () => {
    const root = await temporaryDirectory();
    const vault = join(root, 'test-vault');
    const candidate = join(root, 'candidate');
    const expectedManifest = await sourceManifest();
    await writeTestVault(vault);
    await mkdir(candidate, { recursive: true });
    await Promise.all([
      writeFile(join(candidate, 'main.js'), 'compiled plugin\n', 'utf8'),
      writeFile(join(candidate, 'manifest.json'), `${JSON.stringify(expectedManifest)}\n`, 'utf8'),
      writeFile(join(candidate, 'styles.css'), '.pages-publish {}\n', 'utf8'),
    ]);

    const { stdout } = await execFile('bash', [prepareScript, 'info'], {
      env: hatEnvironment(vault, candidate),
    });

    expect(stdout).toContain('status=prepared');
  });

  it('rejects an external test Vault unless the caller explicitly opts in', async () => {
    const root = await temporaryDirectory();
    const vault = join(root, 'test-vault');
    await writeTestVault(vault);

    const result = await runExpectingFailure('bash', [prepareScript, 'info'], {
      env: {
        ...process.env,
        PAGES_PUBLISH_HAT_TEST_VAULT: vault,
      },
    });

    expect(result.code).toBe(64);
    expect(result.stderr).toContain('PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT=1');
    expect(result.stdout).not.toContain('HAT_PREPARE_SUMMARY');
  });

  it('uses an absolute guide path when invoked outside the repository', async () => {
    const root = await temporaryDirectory();
    const vault = join(root, 'test-vault');
    const candidate = join(root, 'candidate');
    const expectedManifest = await sourceManifest();
    await writeTestVault(vault);
    await mkdir(candidate, { recursive: true });
    await Promise.all([
      writeFile(join(candidate, 'main.js'), 'compiled plugin\n', 'utf8'),
      writeFile(join(candidate, 'manifest.json'), `${JSON.stringify(expectedManifest)}\n`, 'utf8'),
      writeFile(join(candidate, 'styles.css'), '.pages-publish {}\n', 'utf8'),
    ]);

    const { stdout } = await execFile('bash', [prepareScript, 'info'], {
      cwd: root,
      env: hatEnvironment(vault, candidate),
    });

    expect(stdout).toContain(`guide=${join(process.cwd(), 'hats/20260801-s17-release-candidate/guide.md')}`);
  });

  it('reports not-run when the staged manifest does not match the source plugin', async () => {
    const root = await temporaryDirectory();
    const vault = join(root, 'test-vault');
    const candidate = join(root, 'candidate');
    await writeTestVault(vault);
    await mkdir(candidate, { recursive: true });
    await Promise.all([
      writeFile(join(candidate, 'main.js'), 'compiled plugin\n', 'utf8'),
      writeFile(join(candidate, 'manifest.json'), '{"id":"other-plugin"}\n', 'utf8'),
      writeFile(join(candidate, 'styles.css'), '.pages-publish {}\n', 'utf8'),
    ]);

    const { stdout } = await execFile('bash', [prepareScript, 'info'], {
      env: hatEnvironment(vault, candidate),
    });

    expect(stdout).toContain('status=not-run');
  });

  it('emits a not-run summary when packaging fails before any Vault write', async () => {
    const root = await temporaryDirectory();
    const fakeBin = join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const fakeNpm = join(fakeBin, 'npm');
    await writeFile(fakeNpm, '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    await execFile('chmod', ['+x', fakeNpm]);

    const result = await runExpectingFailure('bash', [prepareScript, 'prepare'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('status=not-run');
  });

  it('emits a not-run summary when an explicitly selected Vault lacks the HAT marker', async () => {
    const root = await temporaryDirectory();
    const vault = join(root, 'unrecognised-vault');
    await mkdir(vault, { recursive: true });

    const result = await runExpectingFailure('bash', [prepareScript, 'prepare'], {
      env: {
        ...process.env,
        PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT: '1',
        PAGES_PUBLISH_HAT_TEST_VAULT: vault,
      },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('status=not-run');
    expect(result.stderr).toContain('Refusing to initialise an unrecognised test Vault');
  }, 10_000);
});

function hatEnvironment(vault: string, candidate: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAGES_PUBLISH_HAT_ALLOW_EXTERNAL_TEST_VAULT: '1',
    PAGES_PUBLISH_HAT_TEST_VAULT: vault,
    PAGES_PUBLISH_HAT_CANDIDATE_DIRECTORY: candidate,
  };
}

async function writeTestVault(vault: string): Promise<void> {
  const configDirectory = `.${'obsidian'}`;
  await mkdir(join(vault, configDirectory), { recursive: true });
  await mkdir(join(vault, 'notes'), { recursive: true });
  await Promise.all([
    writeFile(join(vault, '.pages-publish-s17-test-vault'), '', 'utf8'),
    writeFile(join(vault, configDirectory, 'app.json'), '{}\n', 'utf8'),
    writeFile(join(vault, 'notes/public.md'), '# public\n', 'utf8'),
    writeFile(join(vault, 'notes/unlisted.md'), '# unlisted\n', 'utf8'),
    writeFile(join(vault, 'notes/private.md'), '# private\n', 'utf8'),
  ]);
}

async function sourceManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(process.cwd(), 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

async function runExpectingFailure(
  command: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    await execFile(command, args, options);
    throw new Error('Expected command to fail');
  } catch (error: unknown) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? null,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pages-publish-hat-prepare-'));
  directories.push(directory);
  return directory;
}
