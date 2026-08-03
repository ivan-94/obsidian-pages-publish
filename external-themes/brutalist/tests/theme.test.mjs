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

test('theme confines Quartz Explorer scrolling at the tablet breakpoint', async () => {
  const source = await readFile(join(root, 'src', 'theme.css'), 'utf8');
  assert.match(source, /@media \(max-width: 1100px\)[\s\S]*\.brutalist-editorial-index \.explorer\s*\{[^}]*max-height:[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/u);
});

test('theme cancels Explorer page scrolling without overriding hashes or user movement', async () => {
  const source = await readFile(join(root, 'src', 'client.js'), 'utf8');
  assert.match(source, /if \(location\.hash\) \{/u);
  assert.match(source, /target\.scrollIntoView\(\{ block: 'start', behavior: 'instant' \}\)/u);
  assert.match(source, /window\.scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/u);
  assert.match(source, /new MutationObserver\(\(\) => resetExplorerPageScroll\(\)\)/u);
  assert.match(source, /navigation\?\.type === 'navigate'/u);
});
