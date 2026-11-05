import { afterEach, describe, expect, test } from 'bun:test';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';

import type { Bungalow } from './bungalow.ts';
import { openAtRoot, openBungalow } from './bungalow.ts';
import type { ConfigurationSnapshot, ConfigurationWriteResult } from './configuration.ts';
import { TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';

import { useS3Proxy } from './s3-proxy.test-support.ts';

const temporaryDirectory = useTemporaryDirectories();

describe('local configuration revisions', () => {
  test('requires a precondition in the type contract and returns promises', async () => {
    using home = openAtRoot(TEST_NAME, temporaryDirectory());
    const read: Promise<ConfigurationSnapshot> = home.readConfiguration();
    expect(read).toBeInstanceOf(Promise);
    expect(await read).toEqual({ text: undefined, revision: null });
    // @ts-expect-error An unconditional configuration write is not a callable contract.
    const missingPrecondition: Parameters<Bungalow['writeConfiguration']> = ['{}'];
    expect(missingPrecondition).toHaveLength(1);
    const write: Promise<ConfigurationWriteResult> = home.writeConfiguration('{}', {
      expectedRevision: null,
    });
    expect(write).toBeInstanceOf(Promise);
    expect(await write).toEqual({ outcome: 'committed' });
  });

  test('requires explicit creation and refuses stale writes without changing the bytes', async () => {
    using home = openAtRoot(TEST_NAME, temporaryDirectory());
    expect(home.configurationWriteCapability).toBe('writable');
    const absent = await home.readConfiguration();
    expect(absent).toEqual({ text: undefined, revision: null });
    expect(await home.writeConfiguration('{"one":1}\n', { expectedRevision: null })).toEqual({
      outcome: 'committed',
    });
    const first = await home.readConfiguration();
    expect(first.text).toBe('{"one":1}\n');
    expect(typeof first.revision).toBe('string');
    expect(await home.writeConfiguration('overwrite', { expectedRevision: null })).toEqual({
      outcome: 'conflict',
    });
    expect(
      await home.writeConfiguration('{"two":2}', { expectedRevision: first.revision }),
    ).toEqual({ outcome: 'committed' });
    expect(await home.writeConfiguration('stale', { expectedRevision: first.revision })).toEqual({
      outcome: 'conflict',
    });
    const configurationSnapshot1 = await home.readConfiguration();
    expect(configurationSnapshot1.text).toBe('{"two":2}');
  });

  test('reports a replacement followed by a lost local acknowledgement as unknown', async () => {
    using home = openAtRoot(TEST_NAME, temporaryDirectory(), {
      renameConfiguration: (from, to) => {
        renameSync(from, to);
        throw new Error('acknowledgement lost');
      },
    });
    const result = await home.writeConfiguration('committed-bytes', { expectedRevision: null });
    expect(result.outcome).toBe('unknown');
    if (result.outcome !== 'unknown') throw new Error('expected an uncertain acknowledgement');
    expect(result.current?.text).toBe('committed-bytes');
    const standing = await home.readConfiguration();
    expect(standing.text).toBe('committed-bytes');
  });

  test('sees hand edits and deletion before a conditional replacement', async () => {
    using home = openAtRoot(TEST_NAME, temporaryDirectory());
    expect(await home.writeConfiguration('first', { expectedRevision: null })).toEqual({
      outcome: 'committed',
    });
    const first = await home.readConfiguration();
    writeFileSync(home.configurationLocation, 'hand edited');
    expect(await home.writeConfiguration('stale', { expectedRevision: first.revision })).toEqual({
      outcome: 'conflict',
    });
    const edited = await home.readConfiguration();
    expect(edited.text).toBe('hand edited');
    expect(edited.revision).not.toBe(first.revision);
    unlinkSync(home.configurationLocation);
    expect(await home.writeConfiguration('deleted', { expectedRevision: edited.revision })).toEqual(
      { outcome: 'conflict' },
    );
    expect(await home.readConfiguration()).toEqual({ text: undefined, revision: null });
  });
});

const servers: S3TestServer[] = [];
const startProxy = useS3Proxy();
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

function remoteServer() {
  const server = createS3TestServer({ bucket: 'configuration-tests' });
  servers.push(server);
  return server;
}

function remoteHome(endpoint: string, prefix = 'one', writableConfiguration = true) {
  return openBungalow({
    name: TEST_NAME,
    writableConfiguration,
    databaseWorkspaceClaim: async () => {},
    environment: {
      NODE_ENV: 'test',
      BUNGALOW_TEST_DATABASE_URL: 'postgres://user:password@127.0.0.1:5432/test',
      BUNGALOW_TEST_BUCKET: 'configuration-tests',
      BUNGALOW_TEST_BUCKET_PREFIX: prefix,
      S3_ENDPOINT: endpoint,
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
    },
  });
}

describe('remote configuration revisions', () => {
  test('two handles have one winner for creation and replacement, with isolated prefixes', async () => {
    const server = remoteServer();
    using first = await remoteHome(server.endpoint);
    using second = await remoteHome(server.endpoint);
    using other = await remoteHome(server.endpoint, 'other');
    expect(await other.writeConfiguration('sentinel-other', { expectedRevision: null })).toEqual({
      outcome: 'committed',
    });
    const creations = await Promise.all([
      first.writeConfiguration('first', { expectedRevision: null }),
      second.writeConfiguration('second', { expectedRevision: null }),
    ]);
    expect(creations.map(({ outcome }) => outcome).toSorted()).toEqual(['committed', 'conflict']);
    const snapshot = await first.readConfiguration();
    expect(await second.readConfiguration()).toEqual(snapshot);
    const replacements = await Promise.all([
      first.writeConfiguration('replacement-first', { expectedRevision: snapshot.revision }),
      second.writeConfiguration('replacement-second', { expectedRevision: snapshot.revision }),
    ]);
    expect(replacements.map(({ outcome }) => outcome).toSorted()).toEqual([
      'committed',
      'conflict',
    ]);
    const configurationSnapshot2 = await first.readConfiguration();
    expect(configurationSnapshot2.text).toBe(
      replacements[0]?.outcome === 'committed' ? 'replacement-first' : 'replacement-second',
    );
    const configurationSnapshot3 = await other.readConfiguration();
    expect(configurationSnapshot3.text).toBe('sentinel-other');
  });

  test('a deleted revision cannot be recreated by a stale replacement', async () => {
    const server = remoteServer();
    const proxy = startProxy(server);
    using home = await remoteHome(proxy.endpoint);
    expect(await home.writeConfiguration('first', { expectedRevision: null })).toEqual({
      outcome: 'committed',
    });
    const snapshot = await home.readConfiguration();
    proxy.intercept(async ({ method, key }) => {
      if (method === 'PUT' && key === 'one/configuration.json') {
        const deleted = await fetch(`${server.endpoint}/${server.bucket}/${key}`, {
          method: 'DELETE',
        });
        expect(deleted.status).toBe(204);
      }
      return undefined;
    });
    expect(await home.writeConfiguration('stale', { expectedRevision: snapshot.revision })).toEqual(
      { outcome: 'conflict' },
    );
    expect(await home.readConfiguration()).toEqual({ text: undefined, revision: null });
  });

  test('read-only policy is separate from remote placement and sends no write', async () => {
    const proxy = startProxy(remoteServer());
    using home = await remoteHome(proxy.endpoint, 'one', false);
    expect(home.configurationWriteCapability).toBe('read-only');
    const writes = proxy.requests.filter(({ method }) => method === 'PUT').length;
    expect(await home.writeConfiguration('no', { expectedRevision: null })).toEqual({
      outcome: 'read-only',
    });
    expect(proxy.requests.filter(({ method }) => method === 'PUT')).toHaveLength(writes);
  });

  test.each([
    { status: 403, outcome: 'unavailable' },
    { status: 501, outcome: 'unsupported' },
  ])(
    'distinguishes a refused operation without exposing its response body',
    async ({ status, outcome }) => {
      const proxy = startProxy(remoteServer());
      using home = await remoteHome(proxy.endpoint);
      proxy.intercept(({ method, key }) =>
        method === 'PUT' && key === 'one/configuration.json'
          ? new Response('sentinel-signed-url-and-credentials', { status })
          : undefined,
      );
      expect(await home.writeConfiguration('private-document', { expectedRevision: null })).toEqual(
        { outcome },
      );
    },
  );

  test('retains an unknown outcome when reconciliation is unavailable', async () => {
    const proxy = startProxy(remoteServer());
    using home = await remoteHome(proxy.endpoint);
    proxy.intercept(({ key }) =>
      key === 'one/configuration.json' ? new Response('unavailable', { status: 503 }) : undefined,
    );
    expect(await home.writeConfiguration('candidate', { expectedRevision: null })).toEqual({
      outcome: 'unknown',
    });
    const attempts = proxy.requests.filter(
      ({ key, method }) => key === 'one/configuration.json' && method === 'PUT',
    );
    expect(attempts).toHaveLength(1);
  });

  test.each([false, true])(
    'a committed write with a lost response is never replayed or rolled back (competitor=%s)',
    async (competitor) => {
      const server = remoteServer();
      const proxy = startProxy(server);
      using home = await remoteHome(proxy.endpoint);
      let writes = 0;
      proxy.intercept(({ method, key }) => {
        if (method !== 'PUT' || key !== 'one/configuration.json') return undefined;
        writes += 1;
        server.put(key, 'candidate');
        if (competitor) server.put(key, 'later-writer');
        return new Response('response unavailable', { status: 500 });
      });
      const result = await home.writeConfiguration('candidate', { expectedRevision: null });
      expect(result.outcome).toBe('unknown');
      if (result.outcome !== 'unknown') throw new Error('expected an uncertain commit');
      expect(result.current?.text).toBe(competitor ? 'later-writer' : 'candidate');
      expect(writes).toBe(1);
      const configurationSnapshot4 = await home.readConfiguration();
      expect(configurationSnapshot4.text).toBe(competitor ? 'later-writer' : 'candidate');
    },
  );
});
