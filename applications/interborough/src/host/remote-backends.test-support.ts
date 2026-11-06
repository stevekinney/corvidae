import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import {
  requireOpenedPostgresTestDatabase,
  type PostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import type { S3TestServer } from '@lostgradient/testing/s3-server';
import { dirname, join } from 'node:path';

/** The secret that signs approvals, for the remote hosts a test starts; every host must share it. */
export const TEST_APPROVAL_SECRET = 'remote-test-approval-secret-0123456789abcdef';

/** The secret that signs the demo plugin's approvals, for a remote host that enables it; every host must share it. */
export const TEST_DEMO_APPROVAL_SECRET = 'remote-test-demo-approval-secret-0123456789ab';

/** The key secret answers are sealed with (base64url of 32 bytes), for the remote hosts a test starts. */
export const TEST_ANSWER_ENCRYPTION_KEY = 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw';

/** The shared HMAC secret for durable child-run delegation grants in remote hosts. */
export const TEST_DELEGATION_SECRET = 'remote-test-delegation-secret-0123456789abcdef';

/**
 * A database no earlier run touched, on the server `database` names: a supplied server is shared
 * between runs, so a suite makes its own. `password` is put in the returned URL, which a trusting
 * test server ignores, so a test can check that no credential reaches what a host reports.
 */
export async function createFreshDatabaseUrl(
  database: PostgresTestDatabase | null,
  password = '',
): Promise<string> {
  const base = requireOpenedPostgresTestDatabase(database);
  const name = `interborough_${crypto.randomUUID().replaceAll('-', '')}`;
  const administrator = new Bun.SQL(base.url);
  try {
    await administrator.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await administrator.close();
  }
  const url = new URL(base.url);
  url.pathname = `/${name}`;
  if (password !== '') url.password = password;
  return url.toString();
}

/** The environment of a remote host: the database, the bucket under `prefix`, and the approval secret. */
export function remoteEnvironment(
  databaseUrl: string,
  server: S3TestServer,
  prefix: string,
): Record<string, string> {
  const client = server.clientOptions();
  return {
    INTERBOROUGH_DATABASE_URL: databaseUrl,
    INTERBOROUGH_BUCKET: client.bucket,
    INTERBOROUGH_BUCKET_PREFIX: prefix,
    S3_ENDPOINT: client.endpoint,
    S3_REGION: client.region,
    S3_ACCESS_KEY_ID: client.accessKeyId,
    S3_SECRET_ACCESS_KEY: client.secretAccessKey,
    INTERBOROUGH_SECRET_APPROVAL_SECRET: TEST_APPROVAL_SECRET,
    INTERBOROUGH_SECRET_DEMO_APPROVAL_SECRET: TEST_DEMO_APPROVAL_SECRET,
    INTERBOROUGH_SECRET_ANSWER_ENCRYPTION_KEY: TEST_ANSWER_ENCRYPTION_KEY,
    INTERBOROUGH_SECRET_DELEGATION_SECRET: TEST_DELEGATION_SECRET,
  };
}

/** Forward S3 traffic and replace one successful configuration write response after it commits. */
export function createLostAcknowledgementProxy(upstream: S3TestServer) {
  let armed = false;
  let lost = 0;
  let writes = 0;
  let afterCommit: (() => Promise<void>) | undefined;
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'PUT' && url.pathname.endsWith('/configuration.json')) writes += 1;
      const headers = new Headers(request.headers);
      headers.delete('host');
      const init: RequestInit = { method: request.method, headers };
      if (request.method !== 'GET' && request.method !== 'HEAD')
        init.body = await request.arrayBuffer();
      const response = await fetch(`${upstream.endpoint}${url.pathname}${url.search}`, init);
      if (
        armed &&
        request.method === 'PUT' &&
        url.pathname.endsWith('/configuration.json') &&
        response.ok
      ) {
        armed = false;
        lost += 1;
        await response.body?.cancel();
        await afterCommit?.();
        return new Response('acknowledgement unavailable', { status: 503 });
      }
      return response;
    },
  });
  return {
    endpoint: `http://127.0.0.1:${proxy.port}`,
    arm: (callback?: () => Promise<void>) => {
      armed = true;
      afterCommit = callback;
    },
    lost: () => lost,
    writes: () => writes,
    stop: () => proxy.stop(true),
  };
}

/** Build the replacement as a standalone artifact so it executes from its own read-only tree. */
export async function compileRemoteReplacement(application: string): Promise<string> {
  const executable = join(application, 'replacement');
  const child = spawnWithHangGuard(
    [
      process.execPath,
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--outfile',
      executable,
      join(import.meta.dir, 'remote-replacement-caller.test-support.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Remote replacement compilation failed: ${stdout}\n${stderr}`);
  return executable;
}

/** Run the compiled replacement with its own process environment and temporary directory. */
export async function runRemoteReplacement(
  executable: string,
  environment: Record<string, string>,
): Promise<void> {
  const child = spawnWithHangGuard([executable], {
    cwd: dirname(executable),
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Remote replacement failed: ${stdout}\n${stderr}`);
}
