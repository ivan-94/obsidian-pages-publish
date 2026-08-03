import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installLockedNpmProject } from '../src/runtime/npm-installer';

describe('locked npm installer', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('installs production dependencies from the verified lockfile with npm ci', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'pages-quartz-npm-'));
    directories.push(sourceDirectory);
    const lockfile = '{"lockfileVersion":3}\n';
    await writeFile(join(sourceDirectory, 'package-lock.json'), lockfile, 'utf8');
    await writeFile(
      join(sourceDirectory, 'fixture-npm.mjs'),
      [
        "import { writeFile } from 'node:fs/promises'",
        "import { join } from 'node:path'",
        "const expected = ['ci', '--include=dev', '--no-audit', '--no-fund']",
        'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(9)',
        "if (process.env.npm_config_registry !== 'https://registry.npmjs.org/') process.exit(10)",
        "if (process.env.npm_config_replace_registry_host !== 'never') process.exit(11)",
        "if (!process.env.npm_config_userconfig?.endsWith('.pages-publish-user-npmrc')) process.exit(12)",
        "if (!process.env.npm_config_globalconfig?.endsWith('.pages-publish-global-npmrc')) process.exit(13)",
        "if (!process.env.PATH?.endsWith(':/usr/bin:/bin')) process.exit(14)",
        "await writeFile(join(process.cwd(), 'npm-ci-ran'), 'verified', 'utf8')",
      ].join('\n'),
      'utf8',
    );

    await installLockedNpmProject({
      sourceDirectory,
      nodeExecutable: process.execPath,
      npmCliPath: join(sourceDirectory, 'fixture-npm.mjs'),
      cacheDirectory: join(sourceDirectory, '.npm-cache'),
      lockfileSha256: sha256(lockfile),
    });

    await expect(readFile(join(sourceDirectory, 'npm-ci-ran'), 'utf8')).resolves.toBe(
      'verified',
    );
  });

  it('does not start npm when the package lock checksum is not verified', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'pages-quartz-npm-'));
    directories.push(sourceDirectory);
    await writeFile(
      join(sourceDirectory, 'package-lock.json'),
      '{"lockfileVersion":3}\n',
      'utf8',
    );
    await writeFile(
      join(sourceDirectory, 'fixture-npm.mjs'),
      [
        "import { writeFile } from 'node:fs/promises'",
        "import { join } from 'node:path'",
        "await writeFile(join(process.cwd(), 'npm-ci-ran'), 'unsafe', 'utf8')",
      ].join('\n'),
      'utf8',
    );

    await expect(
      installLockedNpmProject({
        sourceDirectory,
        nodeExecutable: process.execPath,
        npmCliPath: join(sourceDirectory, 'fixture-npm.mjs'),
        cacheDirectory: join(sourceDirectory, '.npm-cache'),
        lockfileSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('package lock checksum');
    await expect(access(join(sourceDirectory, 'npm-ci-ran'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
