import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { PostgresStorage } from '@lostgradient/storage-postgres';
import { openPostgresTestDatabase } from '@lostgradient/testing/postgres-server';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterAll, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeys } from './api-keys.ts';

const database = await openPostgresTestDatabase();
afterAll(async () => {
  await database?.[Symbol.asyncDispose]();
});
const target = { workspaceId: 'A', subject: 'warehouse' };
const input = { ...target, label: 'Warehouse', scopes: ['inventory.equipment:read'] };
let active = true;
const policy = {
  authorizeManagement: async (
    actor: string,
    request: { workspaceId: string; scopes: readonly string[] },
  ) =>
    actor === 'manager-A' &&
    request.workspaceId === 'A' &&
    request.scopes.every((scope) => scope === 'inventory.equipment:read'),
  resolveAuthority: async ({ workspaceId, subject }: typeof target) =>
    active ? { workspaceId, subject, scopes: ['inventory.equipment:read'] } : null,
};

it('rejects a backend lacking conditional batches before writing', async () => {
  using storage = new MemoryStorage();
  const unsupported: Storage = {
    capabilities: () => ({ ...storage.capabilities(), conditionalBatch: false }),
    get: (...args) => storage.get(...args),
    put: (...args) => storage.put(...args),
    delete: (...args) => storage.delete(...args),
    scan: (...args) => storage.scan(...args),
    batch: (...args) => storage.batch(...args),
    [Symbol.dispose]: () => {},
  };
  expect(() => createApiKeys({ storage: unsupported, ...policy })).toThrow(
    'Atomic conditional storage is required',
  );
  expect(await Array.fromAsync(storage.scan('api-keys:'))).toEqual([]);
});

it('persists the successor across SQLite close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-keys-'));
  try {
    const path = join(directory, 'keys.sqlite');
    let storage = new BunSQLiteStorage(path);
    let keys = createApiKeys({ storage, ...policy, now: () => 10 });
    const first = await keys.issue('manager-A', input);
    const second = await keys.rotate('manager-A', { ...target, id: first.id, retiresAt: 20 });
    expect(await keys.verify(second.secret)).toMatchObject(target);
    storage[Symbol.dispose]();
    storage = new BunSQLiteStorage(path);
    keys = createApiKeys({ storage, ...policy, now: () => 10 });
    expect(await keys.verify(second.secret)).toMatchObject(target);
    storage[Symbol.dispose]();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('shares committed revocations and current membership across PostgreSQL hosts', async () => {
  if (!database) throw new Error('PostgreSQL is required for the API-key storage proof');
  const table = `api_key_${crypto.randomUUID().replaceAll('-', '')}`;
  await using firstStorage = new PostgresStorage({ url: database.url, table });
  await using secondStorage = new PostgresStorage({ url: database.url, table });
  let clock = 10;
  const first = createApiKeys({ storage: firstStorage, ...policy, now: () => clock });
  const second = createApiKeys({ storage: secondStorage, ...policy, now: () => clock });
  const issued = await first.issue('manager-A', input);
  const stored = await firstStorage.get(`api-keys:record:${issued.id}`);
  expect(new TextDecoder().decode(stored!)).not.toContain(issued.secret);
  const snapshot = async () => {
    const entries: [string, number[]][] = [];
    for await (const [key, value] of firstStorage.scan('api-keys:'))
      entries.push([key, [...value]]);
    return JSON.stringify(entries);
  };
  const before = await snapshot();
  for (const actor of ['non-manager', 'manager-B']) {
    expect(await throwingRejectionOf(first.list(actor, target))).toThrow();
    expect(await throwingRejectionOf(first.issue(actor, input))).toThrow();
    expect(
      await throwingRejectionOf(first.rotate(actor, { ...target, id: issued.id, retiresAt: 20 })),
    ).toThrow();
    expect(await throwingRejectionOf(first.revoke(actor, { ...target, id: issued.id }))).toThrow();
    expect(await snapshot()).toBe(before);
  }
  expect(
    await throwingRejectionOf(
      first.issue('manager-A', { ...input, scopes: ['inventory.equipment:write'] }),
    ),
  ).toThrow();
  expect(await snapshot()).toBe(before);
  expect(await second.verify(issued.secret)).toEqual({
    ...target,
    id: issued.id,
    scopes: input.scopes,
  });
  expect(JSON.stringify(await first.list('manager-A', target))).not.toContain(issued.secret);
  const replacement = await first.rotate('manager-A', { ...target, id: issued.id, retiresAt: 20 });
  clock = 19;
  expect(await second.verify(issued.secret)).toMatchObject(target);
  expect(await second.verify(replacement.secret)).toMatchObject(target);
  clock = 20;
  expect(await second.verify(issued.secret)).toBeNull();
  await first.revoke('manager-A', { ...target, id: replacement.id });
  expect(await first.verify(replacement.secret)).toBeNull();
  expect(await second.verify(replacement.secret)).toBeNull();
  for (const host of [first, second]) {
    const visible = await host.list('manager-A', target);
    expect(visible.find((item) => item.id === replacement.id)?.revokedAt).toBe(20);
    expect(JSON.stringify(visible)).not.toContain(replacement.secret);
    expect(JSON.stringify(visible)).not.toContain('verifier');
  }
  const other = await first.issue('manager-A', input);
  active = false;
  expect(await second.verify(other.secret)).toBeNull();
  active = true;
  const listed = await second.list('manager-A', target);
  expect(JSON.stringify(listed)).not.toContain(other.secret);
  expect(JSON.stringify(listed)).not.toContain('verifier');
  for (const item of listed)
    expect(await firstStorage.get(`api-keys:record:${item.id}`)).not.toBeNull();
});

it('rejects a stale rotation after another host revokes the key', async () => {
  if (!database) throw new Error('PostgreSQL is required for the API-key storage proof');
  const table = `api_key_${crypto.randomUUID().replaceAll('-', '')}`;
  await using firstStorage = new PostgresStorage({ url: database.url, table });
  await using secondStorage = new PostgresStorage({ url: database.url, table });
  const other = createApiKeys({ storage: secondStorage, ...policy, now: () => 10 });
  const issued = await other.issue('manager-A', input);
  let release!: () => void;
  let observed!: () => void;
  const paused = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: Storage = {
    capabilities: () => firstStorage.capabilities(),
    get: async (key) => {
      const value = await firstStorage.get(key);
      if (key === `api-keys:record:${issued.id}`) {
        observed();
        await barrier;
      }
      return value;
    },
    put: (...args) => firstStorage.put(...args),
    delete: (...args) => firstStorage.delete(...args),
    scan: (...args) => firstStorage.scan(...args),
    batch: (...args) => firstStorage.batch(...args),
    conditionalBatch: (...args) => firstStorage.conditionalBatch(...args),
    [Symbol.dispose]: () => {},
  };
  const stale = createApiKeys({ storage: wrapped, ...policy, now: () => 10 });
  const rotating = stale.rotate('manager-A', { ...target, id: issued.id, retiresAt: 20 });
  await paused;
  await other.revoke('manager-A', { ...target, id: issued.id });
  release();
  expect(await throwingRejectionOf(rotating)).toThrow('Credential changed');
  expect(await other.verify(issued.secret)).toBeNull();
  const listed = await other.list('manager-A', target);
  expect(listed).toHaveLength(1);
  expect(await secondStorage.get(`api-keys:record:${listed[0].id}`)).not.toBeNull();
});
