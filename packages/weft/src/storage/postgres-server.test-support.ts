import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Start a disposable real PostgreSQL cluster for wire-protocol and contention tests. */
export async function createPostgresTestServer(): Promise<{
  port: number;
  url: string;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const initialize = Bun.which('initdb');
  const control = Bun.which('pg_ctl');
  if (!initialize || !control) {
    throw new Error('PostgreSQL integration tests require initdb and pg_ctl on PATH.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-postgres-'));
  const data = join(directory, 'data');
  const log = join(directory, 'postgres.log');
  let started = false;
  try {
    await runPostgresCommand([
      initialize,
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'corvidae_test',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
    const port = await availablePort();
    await runPostgresCommand([
      control,
      '-D',
      data,
      '-l',
      log,
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      '-w',
      'start',
    ]);
    started = true;
    return {
      port,
      url: `postgresql://corvidae_test@127.0.0.1:${port}/postgres`,
      async [Symbol.asyncDispose]() {
        await runPostgresCommand([control, '-D', data, '-m', 'fast', '-w', 'stop']);
        await rm(directory, { recursive: true });
      },
    };
  } catch (error) {
    if (started) await runPostgresCommand([control, '-D', data, '-m', 'fast', '-w', 'stop']);
    const detail = await readFile(log, 'utf8').catch(
      () => 'PostgreSQL did not create its server log.',
    );
    await rm(directory, { recursive: true });
    throw new Error(`Could not start disposable PostgreSQL: ${detail}`, { cause: error });
  }
}

async function runPostgresCommand(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`${command[0]} exited ${status}: ${output}\n${error}`);
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (address === null || typeof address === 'string') throw new Error('TCP listener has no port.');
  return address.port;
}
