/**
 * The audit record of a deleted storage key: which keys a request would delete, whether the engine
 * deleted them, and the host recording `storage.key.deleted` through its relay for the two ways
 * Health › Storage deletes (a plain DELETE, and a conditional batch).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { storageDeletionApplied, storageDeletionOf } from './storage-audit.ts';

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`http://127.0.0.1:1${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('which keys a request deletes', () => {
  test('a DELETE of a key, however it is encoded', async () => {
    const long = 'workflows/release-notes/'.repeat(100);
    expect(await storageDeletionOf(request('DELETE', '/v1/storage/chat%3Aone'))).toEqual({
      keys: ['chat:one'],
      conditional: false,
    });
    const encoded = await storageDeletionOf(
      request('DELETE', `/v1/storage/${encodeURIComponent(long)}`),
    );
    expect(encoded?.keys).toEqual([long]);
  });

  test('the delete operations of a conditional batch, and not its puts', async () => {
    const deletion = await storageDeletionOf(
      request('POST', '/v1/storage/-/conditional-batch', {
        conditions: [],
        operations: [
          { type: 'put', key: 'kept', value: 'AA==' },
          { type: 'delete', key: 'gone' },
        ],
      }),
    );
    expect(deletion).toEqual({ keys: ['gone'], conditional: true });
  });

  test('nothing for a read, a put, a batch with no delete, or a body that is not JSON', async () => {
    expect(await storageDeletionOf(request('GET', '/v1/storage/key'))).toBeUndefined();
    expect(await storageDeletionOf(request('PUT', '/v1/storage/key'))).toBeUndefined();
    expect(
      await storageDeletionOf(
        request('POST', '/v1/storage/-/conditional-batch', {
          conditions: [],
          operations: [{ type: 'put', key: 'a', value: 'AA==' }],
        }),
      ),
    ).toBeUndefined();
    const broken = new Request('http://127.0.0.1:1/v1/storage/-/conditional-batch', {
      method: 'POST',
      body: '{',
    });
    expect(await storageDeletionOf(broken)).toBeUndefined();
    expect(await storageDeletionOf(request('DELETE', '/v1/storage/%E0%A4%A'))).toBeUndefined();
  });

  test('the request can still be forwarded after it was read', async () => {
    const batch = request('POST', '/v1/storage/-/conditional-batch', {
      conditions: [],
      operations: [{ type: 'delete', key: 'gone' }],
    });
    await storageDeletionOf(batch);
    expect(await batch.json()).toMatchObject({ operations: [{ type: 'delete', key: 'gone' }] });
  });
});

describe('whether the engine deleted them', () => {
  test('a good answer to a DELETE, and an applied batch, but not a refusal or an unapplied batch', async () => {
    const plain = { keys: ['a'], conditional: false } as const;
    const batch = { keys: ['a'], conditional: true } as const;
    expect(await storageDeletionApplied(plain, new Response(null, { status: 204 }))).toBe(true);
    expect(await storageDeletionApplied(plain, new Response('no', { status: 403 }))).toBe(false);
    expect(await storageDeletionApplied(batch, Response.json({ applied: true }))).toBe(true);
    expect(await storageDeletionApplied(batch, Response.json({ applied: false }))).toBe(false);
    expect(await storageDeletionApplied(batch, new Response('not json'))).toBe(false);
  });
});

describe('the host records a deleted key', () => {
  const directories: string[] = [];
  const hosts: Host[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function start(): Promise<Host> {
    const home = await mkdtemp(join(tmpdir(), 'interborough-storage-audit-'));
    directories.push(home);
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(host);
    return host;
  }

  const send = (host: Host, method: string, path: string, body?: BodyInit): Promise<Response> =>
    fetch(new URL(path, host.url), {
      method,
      headers: { origin: host.url.origin },
      ...(body === undefined ? {} : { body }),
    });

  const deletions = async (host: Host) =>
    (await host.bureau.internals.auditTrail?.query({ type: 'storage.key.deleted' })) ?? [];

  test('a DELETE leaves one record naming the whole key, and a batch records each key it deleted', async () => {
    const host = await start();
    const key = `scratch/${'a'.repeat(2000)}`;
    const encodedKey = encodeURIComponent(key);
    const putFirst = await send(host, 'PUT', `/v1/storage/${encodedKey}`, 'x');
    const putSecond = await send(host, 'PUT', '/v1/storage/scratch%2Fsecond', 'y');
    const deleted = await send(host, 'DELETE', `/v1/storage/${encodedKey}`);
    expect([putFirst.ok, putSecond.ok, deleted.ok]).toEqual([true, true, true]);

    const first = await deletions(host);
    expect(first.map((record) => record.runId)).toEqual([`storage:${key}`]);
    expect(first[0]?.principal).toBe('anonymous:local');

    const batch = await send(
      host,
      'POST',
      '/v1/storage/-/conditional-batch',
      JSON.stringify({
        conditions: [{ key: 'scratch/second', expectedValue: btoa('y') }],
        operations: [{ type: 'delete', key: 'scratch/second' }],
      }),
    );
    expect(batch.ok).toBe(true);
    const after = await deletions(host);
    expect(after.map((record) => record.runId)).toContain('storage:scratch/second');
  });

  test('records nothing when the batch did not apply, or the request was a read', async () => {
    const host = await start();
    const put = await send(host, 'PUT', '/v1/storage/scratch%2Fone', 'x');
    expect(put.ok).toBe(true);
    const refused = await send(
      host,
      'POST',
      '/v1/storage/-/conditional-batch',
      JSON.stringify({
        conditions: [{ key: 'scratch/one', expectedValue: btoa('different') }],
        operations: [{ type: 'delete', key: 'scratch/one' }],
      }),
    );
    expect(await refused.json()).toEqual({ applied: false });
    await send(host, 'GET', '/v1/storage/scratch%2Fone');
    expect(await deletions(host)).toEqual([]);
  });
});
