/**
 * COR-1764: what the host does with the remote variables that needs no database. Remote mode is
 * chosen by `INTERBOROUGH_DATABASE_URL` and `INTERBOROUGH_BUCKET` in the environment the host is
 * given, and an empty value counts as unset. The host with a database and two hosts at once are in
 * `remote-host.slow.test.ts` and `remote-overlap.slow.test.ts`.
 */
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];
const servers: S3TestServer[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function remoteVariables(server: S3TestServer): Record<string, string> {
  const client = server.clientOptions();
  return {
    INTERBOROUGH_DATABASE_URL: 'postgresql://user:never-shown@127.0.0.1:1/unreachable',
    INTERBOROUGH_BUCKET: client.bucket,
    S3_ENDPOINT: client.endpoint,
    S3_REGION: client.region,
    S3_ACCESS_KEY_ID: client.accessKeyId,
    S3_SECRET_ACCESS_KEY: client.secretAccessKey,
  };
}

/** A free port: bound and released, so a listener that started on it would hold it. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error('The probe listener has no port.');
  return port;
}

describe('remote mode needs the approval secret', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
  ])(
    'stops a host whose INTERBOROUGH_SECRET_APPROVAL_SECRET is %s, before any listener',
    async (_name, value) => {
      const server = createS3TestServer();
      servers.push(server);
      const port = await freePort();
      const environment: Record<string, string> = { ...remoteVariables(server) };
      if (value !== undefined) environment['INTERBOROUGH_SECRET_APPROVAL_SECRET'] = value;

      const failure = await startHost({ environment, port }).then(
        (host) => {
          hosts.push(host);
          return undefined;
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('INTERBOROUGH_SECRET_APPROVAL_SECRET');
      // Nothing a credential could appear in: not the database URL, not an S3 key.
      expect(message).not.toContain('never-shown');
      expect(message).not.toContain(server.clientOptions().secretAccessKey);
      // No listener started: the port the host would have taken is still free.
      const listener = Bun.serve({ port, fetch: () => new Response() });
      await listener.stop(true);
    },
  );
});

describe('local mode', () => {
  test.each([
    ['unset', {}],
    ['empty', { INTERBOROUGH_DATABASE_URL: '', INTERBOROUGH_BUCKET: '' }],
  ])('is the mode when the remote variables are %s', async (_name, remote) => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-remote-off-'));
    directories.push(home);
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home, ...remote },
      port: 0,
    });
    hosts.push(host);

    expect(host.database).toEqual({ kind: 'sqlite', path: join(home, 'database.sqlite') });
    const response = await fetch(new URL('/host/paths', host.url));
    const paths = (await response.json()) as {
      mode: string;
      agentDirectory: string;
    };
    expect(paths.mode).toBe('local');
    expect(paths.agentDirectory).toBe(join(home, 'agents'));
    const snapshot = await host.bureau.settings.get();
    expect(snapshot.keys['durableOwnership.ownership']?.locked).toBe(false);
  });
});

describe('the bucket the host is pointed at', () => {
  test('fences a delete on a stale ETag, which the README relies on', async () => {
    // COR-1764 carry-over from COR-1762: Bureau's object sources send `If-Match` on a delete, and
    // whether a store honors it differs (AWS honors it only for directory buckets). This is the
    // store the overlap test targets, so the behavior is probed here rather than assumed.
    const server = createS3TestServer();
    servers.push(server);
    const client = new Bun.S3Client(server.clientOptions());
    server.put('probe/object.md', 'one');
    const staleDelete = await fetch(client.presign('probe/object.md', { method: 'DELETE' }), {
      method: 'DELETE',
      headers: { 'If-Match': '"not-the-etag"' },
    });
    expect(staleDelete.status).toBe(412);
    expect(server.objects().has('probe/object.md')).toBe(true);
    const currentTag = server.put('probe/object.md', 'one');
    const matchedDelete = await fetch(client.presign('probe/object.md', { method: 'DELETE' }), {
      method: 'DELETE',
      headers: { 'If-Match': currentTag },
    });
    expect(matchedDelete.status).toBe(204);
    expect(server.objects().has('probe/object.md')).toBe(false);
  });
});

describe('a malformed database URL', () => {
  test('stops the host without quoting the URL, which holds the password', async () => {
    const server = createS3TestServer();
    servers.push(server);
    const environment = {
      ...remoteVariables(server),
      INTERBOROUGH_DATABASE_URL: 'not a url with password hunter2-never-shown',
      INTERBOROUGH_SECRET_APPROVAL_SECRET: 'approval-secret-for-the-test-0123456789',
    };

    const failure = await startHost({ environment, port: 0 }).then(
      (host) => {
        hosts.push(host);
        return undefined;
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('hunter2');
    expect(JSON.stringify(failure)).not.toContain('hunter2');
    expect(JSON.stringify((failure as Error).cause ?? null)).not.toContain('hunter2');
  });
});
