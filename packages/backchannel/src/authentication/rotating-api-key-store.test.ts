import { describe, expect, it, spyOn } from 'bun:test';
import { TEST_SCOPE_VOCABULARY } from '../scope-vocabulary.test-support.ts';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createAuthenticator } from './index.ts';
import { createRotatingApiKeyStore, type RotatingApiKeyStore } from './rotating-api-key-store.ts';

function requestWithKey(key: string): Request {
  return new Request('http://localhost/v1/workflows', {
    method: 'GET',
    headers: { 'X-API-Key': key },
  });
}

describe('createRotatingApiKeyStore', () => {
  it('resolves a registered key to a principal with its scopes', async () => {
    const store = createRotatingApiKeyStore();
    await store.add('key-1', { subject: 'svc', scopes: ['workflows:read'] });

    const principal = await store.resolve('key-1');
    expect(principal).not.toBeNull();
    expect(principal!.method).toBe('api-key');
    expect(principal!.subject).toBe('svc');
    expect(principal!.hasScope('workflows:read')).toBe(true);
  });

  it('returns null for an unknown key', async () => {
    const store = createRotatingApiKeyStore();
    expect(await store.resolve('nope')).toBeNull();
  });

  it('returns null after a key is revoked', async () => {
    const store = createRotatingApiKeyStore();
    await store.add('key-1', { subject: 'svc' });
    expect(await store.revoke('key-1')).toBe(true);
    expect(await store.resolve('key-1')).toBeNull();
    expect(await store.revoke('key-1')).toBe(false);
  });

  it('rejects keys past their expiry timestamp', async () => {
    let clock = 0;
    const store = createRotatingApiKeyStore(() => clock);
    await store.add('expiring', { subject: 'svc', expiresAt: 1_000 });

    expect(await store.resolve('expiring')).not.toBeNull();
    clock = 1_000;
    expect(await store.resolve('expiring')).toBeNull();
    expect(await store.has('expiring')).toBe(false);
  });

  it('reports a registered, unexpired key as present', async () => {
    let clock = 0;
    const store = createRotatingApiKeyStore(() => clock);
    await store.add('live', { subject: 'svc', expiresAt: 1_000 });
    await store.add('forever', { subject: 'svc' });

    expect(await store.has('live')).toBe(true);
    expect(await store.has('forever')).toBe(true);
    expect(await store.has('unregistered')).toBe(false);
    clock = 999;
    expect(await store.has('live')).toBe(true);
    expect(store.size).toBe(2);
  });

  it('rejects empty keys', () => {
    const store = createRotatingApiKeyStore();
    expect(() => store.add('', { subject: 'svc' })).toThrow();
  });

  it('replaces a registered key without retaining stale registration data', async () => {
    const store = createRotatingApiKeyStore();
    await store.add('key-1', { subject: 'old-service', scopes: ['workflows:read'] });
    await store.add('key-1', { subject: 'new-service', scopes: ['workflows:write'] });

    const principal = await store.resolve('key-1');
    expect(principal?.subject).toBe('new-service');
    expect(principal?.hasScope('workflows:read')).toBe(false);
    expect(principal?.hasScope('workflows:write')).toBe(true);
  });

  it('two overlapping valid keys both authenticate during a rotation window', async () => {
    const store = createRotatingApiKeyStore();
    // Introduce the new key while the old one is still valid.
    await store.add('key-old', { subject: 'svc', scopes: ['workflows:read'] });
    await store.add('key-new', { subject: 'svc', scopes: ['workflows:read'] });

    const auth = await createAuthenticator(
      { resolveApiKeyPrincipal: store.resolve },
      { scopeVocabulary: TEST_SCOPE_VOCABULARY },
    );

    const oldResult = await auth(requestWithKey('key-old'));
    const newResult = await auth(requestWithKey('key-new'));
    expect(oldResult.authenticated).toBe(true);
    expect(newResult.authenticated).toBe(true);

    // Complete the rotation: revoke the outgoing key. The new key keeps working;
    // the old key is now rejected — no restart required.
    await store.revoke('key-old');
    const afterRotationOld = await auth(requestWithKey('key-old'));
    const afterRotationNew = await auth(requestWithKey('key-new'));
    expect(afterRotationOld.authenticated).toBe(false);
    expect(afterRotationNew.authenticated).toBe(true);
  });

  it('reports its size', async () => {
    const store = createRotatingApiKeyStore();
    expect(store.size).toBe(0);
    await store.add('a', { subject: 's' });
    await store.add('b', { subject: 's' });
    expect(store.size).toBe(2);
    await store.revoke('a');
    expect(store.size).toBe(1);
  });

  it('snapshots the registration when add is called, not when it runs', async () => {
    const store = createRotatingApiKeyStore();
    const scopes: ('workflows:read' | 'workflows:write')[] = ['workflows:read'];
    const pending = store.add('key-1', { subject: 'svc', scopes });
    scopes.push('workflows:write');
    await pending;

    const principal = await store.resolve('key-1');
    expect(principal?.hasScope('workflows:read')).toBe(true);
    expect(principal?.hasScope('workflows:write')).toBe(false);
  });
});

type CallOutcome = {
  readonly calls: ReadonlyArray<unknown>;
  readonly store: RotatingApiKeyStore;
};

/**
 * Each row issues its calls without awaiting any of them, then states what the
 * store must hold once they have all settled: as though every call had run to
 * completion before the next began.
 */
const serializedRows: ReadonlyArray<{
  readonly name: string;
  readonly issue: (store: RotatingApiKeyStore) => ReadonlyArray<unknown>;
  readonly verify: (outcome: CallOutcome) => Promise<void>;
}> = [
  {
    name: 'add(k) then revoke(k): revoke resolves true, and the key is unknown',
    issue: (store) => [store.add('k', { subject: 'a' }), store.revoke('k')],
    verify: async ({ calls, store }) => {
      expect(await calls[1]).toBe(true);
      expect(await store.has('k')).toBe(false);
      expect(await store.resolve('k')).toBeNull();
      expect(store.size).toBe(0);
    },
  },
  {
    name: 'add(k, a) then add(k, b): the key resolves to b, and the size is 1',
    issue: (store) => [store.add('k', { subject: 'a' }), store.add('k', { subject: 'b' })],
    verify: async ({ store }) => {
      const principal = await store.resolve('k');
      expect(principal?.subject).toBe('b');
      expect(store.size).toBe(1);
    },
  },
  {
    name: 'revoke(k) then add(k): the key is known',
    issue: (store) => [store.revoke('k'), store.add('k', { subject: 'a' })],
    verify: async ({ calls, store }) => {
      expect(await calls[0]).toBe(false);
      expect(await store.has('k')).toBe(true);
    },
  },
  {
    name: 'add(k) then has(k): has resolves true',
    issue: (store) => [store.add('k', { subject: 'a' }), store.has('k')],
    verify: async ({ calls }) => {
      expect(await calls[1]).toBe(true);
    },
  },
  {
    name: 'add(k) then resolve(k): resolve sees the key',
    issue: (store) => [store.add('k', { subject: 'a' }), store.resolve('k')],
    verify: async ({ calls }) => {
      expect(((await calls[1]) as { subject: string } | null)?.subject).toBe('a');
    },
  },
  {
    name: 'add(k) then revoke(k) then add(k, b): the last call wins',
    issue: (store) => [
      store.add('k', { subject: 'a' }),
      store.revoke('k'),
      store.add('k', { subject: 'b' }),
    ],
    verify: async ({ calls, store }) => {
      expect(await calls[1]).toBe(true);
      const principal = await store.resolve('k');
      expect(principal?.subject).toBe('b');
      expect(store.size).toBe(1);
    },
  },
];

describe('createRotatingApiKeyStore call serialization', () => {
  for (const { name, issue, verify } of serializedRows) {
    it(name, async () => {
      const store = createRotatingApiKeyStore();
      const calls = issue(store);

      expect(calls.every((call) => call instanceof Promise)).toBe(true);
      await Promise.all(calls);
      await verify({ calls, store });
    });
  }

  it('counts only completed calls in size while an add is pending', async () => {
    const store = createRotatingApiKeyStore();
    const first = store.add('a', { subject: 's' });
    const second = store.add('b', { subject: 's' });
    expect(store.size).toBe(0);

    await first;
    expect(store.size).toBe(1);
    await second;
    expect(store.size).toBe(2);

    const revoked = store.revoke('a');
    expect(store.size).toBe(2);
    await revoked;
    expect(store.size).toBe(1);
  });

  it('never admits a revoked key to a resolve issued after the revoke', async () => {
    const store = createRotatingApiKeyStore();
    await store.add('k', { subject: 's' });

    const revoked = store.revoke('k');
    const resolved = store.resolve('k');

    expect(await revoked).toBe(true);
    expect(await resolved).toBeNull();
  });
});

describe('createRotatingApiKeyStore after a failed digest', () => {
  it('settles the failing call with the error and still runs the next one', async () => {
    const store = createRotatingApiKeyStore();
    const spy = spyOn(crypto.subtle, 'digest');
    try {
      spy.mockRejectedValueOnce(new Error('digest failed'));

      const failing = store.add('a', { subject: 's' });
      const following = store.add('b', { subject: 's' });
      const laterResolve = store.resolve('b');

      expect(await throwingRejectionOf(failing)).toThrow('digest failed');
      await following;
      expect(await store.has('a')).toBe(false);
      expect(await store.has('b')).toBe(true);
      const principal = await laterResolve;
      expect(principal?.subject).toBe('s');
      expect(store.size).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
