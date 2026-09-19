import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createFixtureServer } from '../src/server.ts';
import { buildFixtures } from './build.ts';
import { FIXTURE_PORT } from './fixture-port.ts';

const root = resolve(import.meta.dirname, '..');
const repository = resolve(root, '../..');
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { preview: { type: 'boolean' }, port: { type: 'string' } },
  strict: true,
});
const preview = values.preview ?? false;
const port = Number(values.port ?? FIXTURE_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid fixture port.');
const outputDirectory = resolve(root, 'build');
if (!preview) await buildFixtures(true);
let build: Promise<void> = Promise.resolve();
const server = createFixtureServer({
  port,
  outputDirectory,
  manifestPath: resolve(preview ? outputDirectory : root, '.playwright', 'manifest.json'),
  development: !preview,
  waitForBuild: () => build,
});
console.log(`fixture host listening on ${server.url}`);
if (!preview) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchRoots = [
    resolve(root, 'src'),
    resolve(root, 'fixtures'),
    ...['cinder', 'chat', 'editor'].map((name) => resolve(repository, 'components', name, 'src')),
    ...['markdown', 'conversationalist'].map((name) =>
      resolve(repository, 'packages', name, 'src'),
    ),
  ];
  const scheduleBuild = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      // Queue behind the previous build, including a failed build, and expose failures to requests.
      build = build.then(
        () => buildFixtures(true),
        () => buildFixtures(true),
      );
      void build.catch((error: unknown) => console.error('[fixture host] rebuild failed', error));
    }, 100);
  };
  for (const watchRoot of watchRoots) {
    watch(watchRoot, { recursive: true }, scheduleBuild);
  }
  // Watch the directory so editor saves that replace the HTML file keep being observed.
  watch(root, (_event, filename) => {
    if (filename === 'index.html') scheduleBuild();
  });
}
