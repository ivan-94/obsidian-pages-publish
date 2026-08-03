import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPublicationEnvironmentDiskCapacity,
  assertPublicationEnvironmentWithinBudget,
  directoryBytes,
} from '../src/runtime/environment-disk-budget';

describe('publication environment disk budget', () => {
  it('rejects preparation when the required free-space threshold is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-environment-disk-'));

    await expect(
      assertPublicationEnvironmentDiskCapacity(root, Number.MAX_SAFE_INTEGER),
    ).rejects.toMatchObject({ code: 'publication-environment-disk-insufficient' });
  });

  it('counts nested environment file bytes and enforces the total budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pages-environment-size-'));
    await mkdir(join(root, 'engine'), { recursive: true });
    await writeFile(join(root, 'engine', 'one.bin'), Buffer.alloc(7));
    await writeFile(join(root, 'engine', 'two.bin'), Buffer.alloc(11));

    await expect(directoryBytes(root)).resolves.toBe(18);
    await expect(assertPublicationEnvironmentWithinBudget(root, 17)).rejects.toMatchObject({
      code: 'publication-environment-disk-insufficient',
    });
    await expect(assertPublicationEnvironmentWithinBudget(root, 18)).resolves.toBeUndefined();
  });
});
