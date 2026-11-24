import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readSourceInfo } from '../../src/host/build-info.ts';
import { startConnectHost } from './connect-host.ts';

const [directory, mode] = process.argv.slice(2);
if (
  !directory ||
  (mode !== 'collision' && mode !== 'hang' && mode !== 'repeat-signal' && mode !== 'early-signal')
)
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
if (mode !== 'collision') listener.stop(true);
let stop: (() => Promise<void>) | undefined;
let stopping: Promise<void> | undefined;
let startup: ReturnType<typeof startConnectHost> | undefined;
const controller = new AbortController();
const cleanup = () => {
  stopping ??= (async () => {
    if (mode === 'early-signal') await startup?.catch(() => undefined);
    await stop?.();
    if (mode === 'collision') listener.stop(true);
    await writeFile(join(directory, `cleaned-${mode}`), 'clean');
  })();
  return stopping;
};
// Reap our supervisor before exiting: a container's init may not reap an orphaned child.
let terminating: Promise<void> | undefined;
let signals = 0;
process.on('SIGTERM', () => {
  signals += 1;
  controller.abort();
  terminating ??= cleanup().then(() => {
    writeFileSync(
      join(directory, `cleaned-${mode}`),
      mode === 'repeat-signal' ? String(signals) : 'signal',
    );
    process.exit(143);
  });
  if (mode === 'repeat-signal' && signals === 1) process.emit('SIGTERM');
  void terminating.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});
try {
  const operation = startConnectHost({
    home,
    buildDirectory: build,
    port,
    signal: controller.signal,
    onStartupResource: (resource) => {
      stop = resource;
    },
  });
  if (mode === 'early-signal') {
    startup = operation.then(
      () => {
        throw new Error('Startup unexpectedly completed after termination');
      },
      (error: unknown) => {
        if (error !== controller.signal.reason) throw error;
        writeFileSync(join(directory, 'startup-aborted'), 'aborted');
        throw error;
      },
    );
    process.emit('SIGTERM');
    await startup.catch(() => undefined);
    await new Promise<void>(() => {});
  } else if (mode === 'collision') {
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
    await writeFile(
      join(directory, mode === 'hang' ? 'ready.json' : 'ready-repeat-signal.json'),
      JSON.stringify({ port, supervisorPid: host.supervisorPid }),
    );
    if (mode === 'repeat-signal') {
      process.kill(process.pid, 'SIGTERM');
    }
    await new Promise<void>(() => {});
  }
} finally {
  await cleanup();
}
