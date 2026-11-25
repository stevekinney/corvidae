import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { runSupervisor } from './supervisor.ts';

export async function publishSupervisorReadiness(
  path: string,
  url: string,
  write: (path: string, value: string) => Promise<unknown> = Bun.write,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await write(temporary, url);
  await rename(temporary, path);
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) {
    const ready = processEnvironment()['CORVIDAE_REMOTE_READY'];
    if (ready === undefined) throw new Error('The remote child needs a ready file.');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: Number(processEnvironment()['INTERBOROUGH_PORT']),
      fetch: () => new Response('remote'),
    });
    await publishSupervisorReadiness(ready, server.url.href);
    await new Promise(() => {});
  } else {
    process.chdir(root);
    const remote = process.argv[3] === 'remote';
    const mode = process.argv[3] === 'serve' ? 'serve' : 'dev';
    process.env['INTERBOROUGH_HOME'] = join(
      root,
      process.argv[4] ?? (mode === 'serve' ? 'home-serve' : 'home-a'),
    );
    process.env['INTERBOROUGH_PORT'] = '0';
    if (remote) {
      process.env['INTERBOROUGH_HOME'] = '';
      process.env['INTERBOROUGH_PORT'] = process.argv[4] ?? '0';
      process.env['INTERBOROUGH_DATABASE_URL'] = 'postgres://localhost/test';
      process.env['INTERBOROUGH_BUCKET'] = 'test-bucket';
      process.env['S3_ENDPOINT'] = 'http://localhost:9000';
      process.env['S3_REGION'] = 'us-east-1';
      process.env['S3_ACCESS_KEY_ID'] = 'access';
      process.env['S3_SECRET_ACCESS_KEY'] = 'secret';
      process.env['CORVIDAE_REMOTE_READY'] = join(root, `remote-${process.argv[4] ?? '0'}`);
    }
    process.env['INTERBOROUGH_BUILD_DIRECTORY'] = join(root, 'build');
    process.exitCode = await runSupervisor(
      [
        mode,
        '--entry',
        join(import.meta.dir, remote ? 'supervisor-owned.test-support.ts' : 'serve.ts'),
      ],
      undefined,
      {
        directory: root,
        read: () => ({
          topLevel: root,
          gitDirectory: join(root, '.git', 'worktrees', 'fixture'),
          commonDirectory: join(root, '.git'),
        }),
      },
    );
  }
}
