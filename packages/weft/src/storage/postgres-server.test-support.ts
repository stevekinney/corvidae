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

/**
 * Build the child environment for `initdb` and `pg_ctl`.
 *
 * PostgreSQL 18 aborts startup with `postmaster became multithreaded during startup`
 * whenever the postmaster gains a thread before it forks, and on macOS the locale
 * lookup does exactly that when `LC_ALL` is unset. Pinning `LC_ALL` to `C` keeps the
 * postmaster single-threaded and matches the `initdb --no-locale` cluster this harness
 * already creates.
 *
 * `Bun.spawn` replaces the child environment rather than merging it, so the ambient
 * environment is forwarded: `initdb` and `pg_ctl` locate the `postgres` binary through
 * `PATH`, and `HOME` and `TMPDIR` carry the rest of their per-user state. Every `PG*`
 * variable is dropped instead: the cluster names its data directory, host, port, socket
 * directory, and superuser as explicit flags, so an ambient `PGDATA`, `PGHOST`,
 * `PGPORT`, `PGUSER`, or `PGPASSWORD` could only redirect the disposable cluster or the
 * `pg_ctl -w` readiness probe at a developer's own server.
 */
export function postgresCommandEnvironment(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Record<string, string | undefined> {
  const childEnvironment: Record<string, string | undefined> = { ...environment, LC_ALL: 'C' };
  for (const name of Object.keys(childEnvironment)) {
    if (name.startsWith('PG')) delete childEnvironment[name];
  }
  return childEnvironment;
}

async function runPostgresCommand(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: postgresCommandEnvironment(),
  });
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
