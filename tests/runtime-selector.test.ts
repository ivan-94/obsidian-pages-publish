import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectEmbeddedPublicationRuntime } from '../src/runtime/runtime-selector';

describe('publication runtime selection', () => {
  it('prefers a compatible Obsidian Node distribution with locked-install npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-embedded-runtime-'));
    const nodeExecutable = join(root, 'bin', 'node');
    const npmCliPath = join(root, 'npm-cli.js');
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(nodeExecutable, 'node');
    await writeFile(npmCliPath, 'npm');
    const inspect = vi.fn(async () => '10.9.8\n');

    await expect(inspectEmbeddedPublicationRuntime({
      nodeExecutable,
      nodeVersion: '22.23.1',
      npmCliPath,
    }, inspect)).resolves.toMatchObject({
      source: 'obsidian',
      nodeVersion: '22.23.1',
      npmVersion: '10.9.8',
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each([
    ['20.19.0', '10.9.8'],
    ['22.23.1', '10.8.0'],
  ])('rejects incompatible embedded Node/npm %s / %s', async (nodeVersion, npmVersion) => {
    const root = await mkdtemp(join(tmpdir(), 'pages-embedded-runtime-'));
    const nodeExecutable = join(root, 'node');
    const npmCliPath = join(root, 'npm-cli.js');
    await writeFile(nodeExecutable, 'node');
    await writeFile(npmCliPath, 'npm');

    await expect(inspectEmbeddedPublicationRuntime({
      nodeExecutable,
      nodeVersion,
      npmCliPath,
    }, async () => npmVersion)).resolves.toBeUndefined();
  });
});
