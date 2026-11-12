/**
 * A development entry whose source watch starts late, for `supervisor.slow.test.ts`. It runs the
 * real `dev.ts`, but the watcher's read of the build's recorded inputs waits until a file named
 * `release-the-inputs-read` appears beside the build directory. That holds `dev.ts` between the
 * host listening and the watchers existing, on any host, so a restart request can land there.
 */

import { plugin } from 'bun';
import { dirname, join } from 'node:path';

import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';

const release = join(
  dirname(resolveBuildDirectory(processEnvironment())),
  'release-the-inputs-read',
);

const READ_IMPORT = "import { readFile } from 'node:fs/promises';";

plugin({
  name: 'hold-the-inputs-read',
  setup(build) {
    build.onLoad({ filter: /source-watcher\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      if (!source.includes(READ_IMPORT))
        throw new Error('The source watcher no longer reads files.');
      const held = [
        `import { readFile as readNow } from 'node:fs/promises';`,
        `const readFile = async (...input) => {`,
        `  console.info('Holding the inputs read');`,
        `  while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);`,
        `  return readNow(...input);`,
        `};`,
        ``,
      ].join('\n');
      return { loader: 'ts', contents: held + source.replace(READ_IMPORT, '') };
    });
  },
});

await import('./dev.ts');
