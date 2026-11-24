import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readSourceInfo } from '../../src/host/build-info.ts';
import { startConnectHost } from './connect-host.ts';

const [directory, mode] = process.argv.slice(2);
if (!directory || (mode !== 'collision' && mode !== 'hang'))
  throw new Error('Expected a directory and mode.');
const build = join(directory, `build-${mode}`);
const home = join(directory, `home-${mode}`);
await mkdir(build);
await mkdir(home);
await writeFile(join(build, 'index.html'), '<html></html>');
await writeFile(
  join(build, 'build-info.json'),
  JSON.stringify(readSourceInfo(join(import.meta.dir, '../..'))),
);
const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
const port = listener.port;
if (mode === 'hang') listener.stop(true);
let stop: (() => Promise<void>) | undefined;
let stopping: Promise<void> | undefined;
const cleanup = () => {
  stopping ??= (async () => {
    await stop?.();
    if (mode === 'collision') listener.stop(true);
    await writeFile(join(directory, `cleaned-${mode}`), 'clean');
  })();
  return stopping;
};
// The host-slots process group owns the supervisor and its child. Exit promptly so its
// process-group cleanup can reap both even if startup or shutdown never settles.
process.on('SIGTERM', () => {
  writeFileSync(join(directory, `cleaned-${mode}`), 'signal');
  process.exit(143);
});
try {
  const operation = startConnectHost({
    home,
    buildDirectory: build,
    port,
    onStartupResource: (resource) => {
      stop = resource;
    },
  });
  if (mode === 'collision') {
    const error = await rejectionOf(operation);
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EADDRINUSE'
    )
      throw new Error('Expected EADDRINUSE', { cause: error });
    await writeFile(join(directory, 'collision.json'), JSON.stringify({ port, code: error.code }));
  } else {
    const host = await operation;
    const instance = await readFile(join(home, 'instance.json'), 'utf8');
    const hostPid = (JSON.parse(instance) as { pid: number }).pid;
    const proc = async (pid: number) =>
      process.platform === 'linux' ? readFile(`/proc/${String(pid)}/stat`, 'utf8') : undefined;
    await writeFile(
      join(directory, 'ready.json'),
      JSON.stringify({
        port,
        supervisorPid: host.supervisorPid,
        hostPid,
        instance,
        supervisorStat: await proc(host.supervisorPid),
        hostStat: await proc(hostPid),
      }),
    );
    await new Promise<void>(() => {});
  }
} finally {
  await cleanup();
}
