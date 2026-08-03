import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await Promise.all([
  cp(join(root, 'src', 'index.js'), join(dist, 'index.js')),
  cp(join(root, 'src', 'theme.css'), join(dist, 'theme.css')),
  cp(join(root, 'src', 'client.js'), join(dist, 'client.js')),
  cp(join(root, 'src', 'options.schema.json'), join(dist, 'options.schema.json')),
  cp(join(root, 'assets', 'registration-mark.svg'), join(dist, 'assets', 'registration-mark.svg')),
]);
