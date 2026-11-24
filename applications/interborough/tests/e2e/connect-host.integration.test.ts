import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSourceInfo } from '../../src/host/build-info.ts';
import { startConnectHost } from './connect-host.ts';

test('reports an occupied connect port as a bind collision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connect-port-'));
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    const build = join(directory, 'build');
    const home = join(directory, 'home');
    await mkdir(build);
    await mkdir(home);
    await writeFile(join(build, 'index.html'), '<html></html>');
    await writeFile(
      join(build, 'build-info.json'),
      JSON.stringify(readSourceInfo(join(import.meta.dir, '../..'))),
    );
    await expect(
      startConnectHost({ home, buildDirectory: build, port: listener.port }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  } finally {
    listener.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
