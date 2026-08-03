import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('package is an install-script-free exact Quartz 5 theme', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.pagesPublishTheme.quartzVersion, '5.0.0');
  for (const script of ['preinstall', 'install', 'postinstall', 'prepack', 'prepare']) {
    assert.equal(manifest.scripts[script], undefined);
  }
});

test('options schema is closed and provides defaults for every required option', async () => {
  const schema = JSON.parse(await readFile(join(root, 'src', 'options.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  for (const name of schema.required) assert.notEqual(schema.properties[name].default, undefined);
});

test('theme uses distinct poster, editorial and minimal frames', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
  assert.match(source, /name: 'brutalist-poster'/u);
  assert.match(source, /name: 'brutalist-editorial'/u);
  assert.match(source, /name: 'brutalist-minimal'/u);
  assert.match(source, /BrutalistMasthead/u);
});
