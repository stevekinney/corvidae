/**
 * COR-1939 — hook CRUD, validation, the signing secret (sealed, write-only, never in plaintext
 * anywhere), and the host's lock on secret writes.
 */
import { generateEncryptionKey, type EncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import type { BureauDiagnostic } from '../types.ts';
import { HOOK_SECRET_KEY_PREFIX } from './hook-store.ts';
import { HookError, type HookSecretStore } from './hook-types.ts';
import {
  createReceiver,
  fireRunEvents,
  newEncryptionKey,
  openHooksBureau,
  type OpenedHooksBureau,
  SIGNING_SECRET,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const opened: OpenedHooksBureau[] = [];
afterEach(async () => {
  for (const bureau of opened.splice(0)) await bureau.dispose();
});

const HOOK = {
  url: 'https://receiver.example/hook?token=abc123',
  events: ['run.registered'],
  signingSecret: SIGNING_SECRET,
  principal: 'api-key:alice',
} as const;

async function open(options: Partial<Parameters<typeof openHooksBureau>[0]> = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const receiver = createReceiver();
  const bureau = await openHooksBureau({ storage, fetch: receiver.fetch, key, ...options });
  opened.push(bureau);
  return { ...bureau, storage, receiver };
}

async function refusal(work: Promise<unknown>): Promise<HookError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HookError) return error;
    throw error;
  }
  throw new Error('expected a HookError');
}

describe('hook records', () => {
  it('creates, reads, lists, updates and deletes a hook, owned by its principal', async () => {
    const { bureau } = await open();
    const hooks = bureau.hooks!;
    const created = await hooks.create({ ...HOOK, name: 'Settled runs' });

    expect(created).toMatchObject({
      owner: 'api-key:alice',
      name: 'Settled runs',
      url: HOOK.url,
      events: ['run.registered'],
      enabled: true,
      revision: 1,
    });
    expect(Object.keys(created)).not.toContain('signingSecret');
    expect(await hooks.get(created.id)).toEqual(created);
    expect(await hooks.list()).toEqual([created]);
    expect(await hooks.list({ owner: 'api-key:bob' })).toEqual([]);

    const updated = await hooks.update(created.id, {
      url: 'https://receiver.example/other',
      events: ['run.settled', 'run.registered', 'run.settled'],
      name: null,
      enabled: false,
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({
      url: 'https://receiver.example/other',
      events: ['run.settled', 'run.registered'],
      enabled: false,
      revision: 2,
      owner: 'api-key:alice',
    });
    expect(Object.keys(updated!)).not.toContain('name');

    expect(await hooks.delete(created.id)).toBe(true);
    expect(await hooks.get(created.id)).toBeUndefined();
    expect(await hooks.delete(created.id)).toBe(false);
    expect(await hooks.update(created.id, { enabled: true })).toBeUndefined();
  });

  it('owns a hook created with no principal as the local owner, and refuses a reserved principal', async () => {
    const { bureau } = await open();
    const { principal: _principal, ...local } = HOOK;
    const created = await bureau.hooks!.create(local);
    expect(created.owner).toBe('anonymous:local');
    const reserved = await refusal(
      bureau.hooks!.create({ ...HOOK, principal: 'system:scheduler' }),
    );
    expect(reserved.code).toBe('invalid');
  });

  it('refuses a stale revision with the revision now current', async () => {
    const { bureau } = await open();
    const hook = await bureau.hooks!.create(HOOK);
    await bureau.hooks!.update(hook.id, { enabled: false });
    const error = await refusal(
      bureau.hooks!.update(hook.id, { enabled: true, expectedRevision: 1 }),
    );
    expect(error).toMatchObject({ code: 'stale-revision', currentRevision: 2 });
  });

  it.each([
    ['a URL with credentials', { url: 'https://u:p@example.com/' }, 'url'],
    ['a metadata address', { url: 'http://169.254.169.254/' }, 'url'],
    ['a non-http URL', { url: 'ftp://example.com/' }, 'url'],
    ['no events', { events: [] }, 'events'],
    ['an unpublished kind', { events: ['hook.test'] }, 'events'],
    ['an unknown kind', { events: ['nope'] }, 'events'],
    ['a short secret', { signingSecret: 'short' }, 'signingSecret'],
    ['a long secret', { signingSecret: 'x'.repeat(257) }, 'signingSecret'],
    ['an empty name', { name: '' }, 'name'],
  ])('refuses %s', async (_label, patch, field) => {
    const { bureau } = await open();
    const error = await refusal(bureau.hooks!.create({ ...HOOK, ...patch }));
    expect(error.code).toBe('invalid');
    expect(error.issues.map((issue) => issue.path[0])).toEqual([field]);
    expect(await bureau.hooks!.list()).toEqual([]);
  });

  it('refuses a private-network URL when the deployment says so, and still allows loopback by default', async () => {
    const strict = await open({ hooks: { urlPolicy: { allowPrivateNetworks: false } } });
    const refused = await refusal(
      strict.bureau.hooks!.create({ ...HOOK, url: 'http://localhost:3000/h' }),
    );
    expect(refused.code).toBe('invalid');
    const lenient = await open();
    const allowed = await lenient.bureau.hooks!.create({ ...HOOK, url: 'http://localhost:3000/h' });
    expect(allowed.url).toBe('http://localhost:3000/h');
  });

  it('refuses hooks on a Bureau with no storage to keep them in', async () => {
    const { createBureau } = await import('../create-bureau.ts');
    const error = await rejectionOf(createBureau({ hooks: {} }));
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED', subject: 'persistence' });
  });
});

describe('the signing secret', () => {
  it('is never in plaintext in storage, records, diagnostics, console output, audit, or any response', async () => {
    const diagnostics: BureauDiagnostic[] = [];
    const logs = [
      spyOn(console, 'log').mockImplementation(() => undefined),
      spyOn(console, 'error').mockImplementation(() => undefined),
      spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    try {
      const { bureau, storage, receiver } = await open({
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        maxAttempts: 2,
      });
      const hooks = bureau.hooks!;
      const responses: unknown[] = [];
      const hook = await hooks.create(HOOK);
      responses.push(hook);
      responses.push(await hooks.update(hook.id, { name: 'renamed' }));
      responses.push(await hooks.get(hook.id), await hooks.list());
      responses.push(await hooks.test(hook.id));
      await fireRunEvents(bureau);
      await waitForSettledDeliveries(bureau, hook.id, 2);
      responses.push(await hooks.deliveries(hook.id));
      // A secret the receiver echoes back is scrubbed from the excerpt.
      const echoing = createReceiver(
        (call) =>
          new Response(`you sent ${call.headers.get('X-Hook-Id')} ${SIGNING_SECRET}`, {
            status: 500,
          }),
      );
      const echo = await open({ fetch: echoing.fetch, maxAttempts: 1 });
      const echoHook = await echo.bureau.hooks!.create(HOOK);
      responses.push(await echo.bureau.hooks!.test(echoHook.id));
      // And a network error that names it.
      const failing = createReceiver(() => {
        throw new Error(`connect failed for ${SIGNING_SECRET}`);
      });
      const failed = await open({ fetch: failing.fetch, maxAttempts: 1 });
      const failedHook = await failed.bureau.hooks!.create(HOOK);
      responses.push(await failed.bureau.hooks!.test(failedHook.id));
      const auditOfHook = await bureau.audit.query({ runId: `hook:${hook.id}` });
      const auditOfEcho = await echo.bureau.audit.query({ runId: `hook:${echoHook.id}` });
      responses.push(auditOfHook.records, auditOfEcho.records);

      expect(receiver.calls.length).toBeGreaterThan(0);
      const everyStoredValue: string[] = [];
      for (const store of [storage, echo.storage, failed.storage]) {
        const kv = textValueStore(store, { disposeUnderlyingStorage: false });
        for (const storedKey of await kv.list('')) {
          // Every key, whatever it holds: the bytes are read raw, because some are not text.
          const bytes = await store.get(storedKey);
          everyStoredValue.push(
            storedKey,
            bytes === null ? '' : Buffer.from(bytes).toString('latin1'),
            bytes === null ? '' : new TextDecoder('utf-8', { fatal: false }).decode(bytes),
          );
        }
      }
      expect(everyStoredValue.length).toBeGreaterThan(0);
      const everywhere = [
        ...everyStoredValue,
        JSON.stringify(responses),
        JSON.stringify(diagnostics.map((d) => ({ ...d, cause: String(d.cause) }))),
        JSON.stringify(logs.flatMap((spy) => spy.mock.calls)),
      ].join('\n');
      expect(everywhere).not.toContain(SIGNING_SECRET);
      expect(JSON.stringify(responses)).toContain('[redacted]');
    } finally {
      for (const spy of logs) spy.mockRestore();
    }
  });

  it('is stored sealed under the hook, and a ciphertext copied to another hook does not open', async () => {
    const { bureau, storage, receiver } = await open();
    const first = await bureau.hooks!.create(HOOK);
    const second = await bureau.hooks!.create({
      ...HOOK,
      signingSecret: 'another-secret-value-123456',
    });
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const sealed = await kv.get(`${HOOK_SECRET_KEY_PREFIX}${first.id}`);
    expect(JSON.parse(sealed!)).toMatchObject({ keyId: key.keyId });
    await kv.set(`${HOOK_SECRET_KEY_PREFIX}${second.id}`, sealed!);

    const delivery = await bureau.hooks!.test(second.id);

    expect(delivery!.status).toBe('failed-secret');
    expect(receiver.calls).toHaveLength(0);
  });

  it('fails a delivery as failed-secret, without a request, when the key that sealed it is no longer held', async () => {
    const storage = new MemoryStorage();
    const { bureau: before } = await open({ storage });
    const hook = await before.hooks!.create(HOOK);
    await opened.pop()!.dispose();

    const receiver = createReceiver();
    const other = await generateEncryptionKey();
    const reopened = await openHooksBureau({ storage, fetch: receiver.fetch, key: other });
    opened.push(reopened);
    const delivery = await reopened.bureau.hooks!.test(hook.id);

    expect(delivery!.status).toBe('failed-secret');
    expect(receiver.calls).toHaveLength(0);
  });

  it('is refused for write when the Bureau has no encryption key, and other writes still work', async () => {
    const { bureau } = await open({ withoutKey: true });
    const refused = await refusal(bureau.hooks!.create(HOOK));
    expect(refused.code).toBe('no-encryption');
    expect(await bureau.hooks!.list()).toEqual([]);
  });

  it('is replaced by an update, and signs the next delivery', async () => {
    const { bureau, receiver } = await open();
    const hook = await bureau.hooks!.create(HOOK);
    await bureau.hooks!.update(hook.id, { signingSecret: 'a-replacement-secret-abcdef' });
    await bureau.hooks!.test(hook.id);
    const { verifyHookSignature } = await import('./hook-signature.ts');
    const call = receiver.calls[0]!;
    const verify = (secret: string) =>
      verifyHookSignature({
        secret,
        header: call.headers.get('X-Signature')!,
        body: call.body,
        now: Date.now() + 0,
        toleranceSeconds: Number.MAX_SAFE_INTEGER,
      });
    expect(verify('a-replacement-secret-abcdef')).toEqual({ ok: true });
    expect(verify(SIGNING_SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('a host that locks secret writes (remote mode)', () => {
  function lockedSecrets(reason: 'deployment' | 'shared-storage'): HookSecretStore & {
    writes: number;
  } {
    const held = new Map<string, Awaited<ReturnType<HookSecretStore['get']>>>();
    const store = {
      writes: 0,
      writeLock: () => reason,
      get: async (id: string) => held.get(id),
      set: async (id: string, encrypted: Parameters<HookSecretStore['set']>[1]) => {
        store.writes += 1;
        held.set(id, encrypted);
      },
      delete: async (id: string) => {
        held.delete(id);
      },
    };
    return store;
  }

  it('refuses a create or an update that writes a secret with reason deployment, and writes nothing', async () => {
    const secrets = lockedSecrets('deployment');
    const { bureau } = await open({ hooks: { secrets } });

    const refused = await refusal(bureau.hooks!.create(HOOK));
    expect(refused).toMatchObject({ code: 'locked', lockReason: 'deployment' });
    expect(secrets.writes).toBe(0);
    expect(await bureau.hooks!.list()).toEqual([]);
  });

  it('still lets a hook be changed, tested and deleted when no secret is written', async () => {
    let lock: 'deployment' | undefined;
    const held = new Map<string, Awaited<ReturnType<HookSecretStore['get']>>>();
    const secrets: HookSecretStore = {
      writeLock: () => lock,
      get: async (id) => held.get(id),
      set: async (id, encrypted) => void held.set(id, encrypted),
      delete: async (id) => void held.delete(id),
    };
    const { bureau, receiver } = await open({ hooks: { secrets } });
    const hook = await bureau.hooks!.create(HOOK);
    lock = 'deployment';

    const renamed = await bureau.hooks!.update(hook.id, { name: 'renamed', enabled: false });
    expect(renamed).toMatchObject({ name: 'renamed', enabled: false });
    expect(
      await refusal(bureau.hooks!.update(hook.id, { signingSecret: 'x'.repeat(20) })),
    ).toMatchObject({
      code: 'locked',
      lockReason: 'deployment',
    });
    expect((await bureau.hooks!.test(hook.id))!.status).toBe('delivered');
    expect(receiver.calls).toHaveLength(1);
    expect(await bureau.hooks!.delete(hook.id)).toBe(true);
  });

  it('uses the port the host injected, which holds ciphertext only', async () => {
    const held = new Map<string, unknown>();
    const secrets: HookSecretStore = {
      get: async (id) => held.get(id) as Awaited<ReturnType<HookSecretStore['get']>>,
      set: async (id, encrypted) => void held.set(id, encrypted),
      delete: async (id) => void held.delete(id),
    };
    const { bureau, receiver, storage } = await open({ hooks: { secrets } });
    const hook = await bureau.hooks!.create(HOOK);

    expect(JSON.stringify([...held.values()])).not.toContain(SIGNING_SECRET);
    expect(held.has(hook.id)).toBe(true);
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    expect(await kv.list(HOOK_SECRET_KEY_PREFIX)).toEqual([]);
    expect((await bureau.hooks!.test(hook.id))!.status).toBe('delivered');
    expect(receiver.calls).toHaveLength(1);
    await bureau.hooks!.delete(hook.id);
    expect(held.size).toBe(0);
  });
});
