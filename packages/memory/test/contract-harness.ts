import { beforeEach, describe, expect, it } from 'bun:test';
import { registerVectorSearchContractTests } from './contract-harness-vector-search';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { MemoryRecordVersionConflictError } from '../src/memory-record-storage';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from '../src/types';
import { registerDeleteContractTests } from './contract-harness-delete';

// Fixed instant used to stamp synthetic fixture records below — only a stable value is needed,
// never the real clock.
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Options for {@link runMemoryRecordStorageContract}.
 */
export interface RunMemoryRecordStorageContractOptions {
  /** Human-readable backend label, used in the `describe` block title. */
  label: string;
  /** Factory that returns a fresh, uninitialized backend for each test. */
  makeBackend: () => MemoryRecordStorage;
  /**
   * Optional scope decorator. Every scope the suite constructs is routed through
   * this function before it reaches the backend, and `makeRecord` derives each
   * record's `tenantId`/`namespace` from the decorated scope so stored records
   * land in the decorated read scope.
   *
   * Defaults to the identity function, which keeps the suite byte-identical to a
   * tenant-free run. A tenant-required backend (e.g. Cloudflare) supplies a
   * decorator that fills in a default `tenantId` for scopes that omit one:
   *
   * ```ts
   * scope: (base) => ({ ...base, tenantId: base.tenantId ?? 'default-tenant' })
   * ```
   *
   * The decorator MUST preserve an already-set `tenantId` so the
   * tenant-isolation assertions (which set `t1`/`t2` explicitly) keep their two
   * distinct tenants instead of collapsing onto one.
   */
  scope?: (base: MemoryRecordScope) => MemoryRecordScope;
}

/**
 * The single shared {@link MemoryRecordStorage} contract suite. Invoke it once
 * per backend so every backend clears byte-identical assertions:
 * put/get/getMany/list/count/searchByVector/update/delete/deleteNamespace, the
 * deterministic exact-search fixture, the shared delete invariant, and the
 * cross-backend pin that a directly `put()` non-active record is invisible to
 * every read.
 *
 * Backend-specific concerns (key-prefix isolation, physical-removal proof,
 * shared-storage disposal) live in the backend's own test file, not here.
 */
export function runMemoryRecordStorageContract(
  options: RunMemoryRecordStorageContractOptions,
): void {
  const decorateScope = options.scope ?? ((base: MemoryRecordScope) => base);

  /** Route a bare scope through the configured decorator. */
  function scopeFor(base: MemoryRecordScope): MemoryRecordScope {
    return decorateScope(base);
  }

  /**
   * Build a record whose scope matches what reads will use: the namespace and
   * any explicit `tenantId` are routed through the decorator so puts and reads
   * agree on a tenant-required backend.
   */
  function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
    const now = FIXED_NOW;
    const baseNamespace = overrides.namespace ?? 'alpha';
    const baseScope: MemoryRecordScope =
      overrides.tenantId === undefined
        ? { namespace: baseNamespace }
        : { tenantId: overrides.tenantId, namespace: baseNamespace };
    const decorated = decorateScope(baseScope);

    return {
      id,
      namespace: decorated.namespace,
      content: `content-${id}`,
      vector: new Float32Array([1, 0]),
      metadata: {},
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: 'active',
      ...overrides,
      ...(decorated.tenantId === undefined ? {} : { tenantId: decorated.tenantId }),
    };
  }

  const SCOPE = scopeFor({ namespace: 'alpha' });

  describe(`MemoryRecordStorage contract (${options.label})`, () => {
    let storage: MemoryRecordStorage;

    beforeEach(async () => {
      storage = options.makeBackend();
      await storage.init();
    });

    describe('put / get', () => {
      it('stores and retrieves a record within its scope', async () => {
        await storage.put(makeRecord('a'));
        const fetched = await storage.get('a', SCOPE);
        expect(fetched?.id).toBe('a');
        expect(fetched?.content).toBe('content-a');
        expect(fetched?.vector).toBeInstanceOf(Float32Array);
        expect(Array.from(fetched!.vector)).toEqual([1, 0]);
        expect(fetched?.status).toBe('active');
        expect(fetched?.version).toBe(1);
      });

      it('returns undefined for an unknown id', async () => {
        expect(await storage.get('missing', SCOPE)).toBeUndefined();
      });

      it('isolates records by namespace', async () => {
        await storage.put(makeRecord('a', { namespace: 'alpha' }));
        await storage.put(makeRecord('b', { namespace: 'beta' }));

        expect(await storage.get('a', scopeFor({ namespace: 'alpha' }))).toBeDefined();
        expect(await storage.get('a', scopeFor({ namespace: 'beta' }))).toBeUndefined();
        expect(await storage.count(scopeFor({ namespace: 'alpha' }))).toBe(1);
        expect(await storage.count(scopeFor({ namespace: 'beta' }))).toBe(1);
      });

      it('isolates records by tenant', async () => {
        await storage.put(makeRecord('a', { tenantId: 't1' }));
        await storage.put(makeRecord('a', { tenantId: 't2' }));

        const t1 = await storage.get('a', scopeFor({ tenantId: 't1', namespace: 'alpha' }));
        const t2 = await storage.get('a', scopeFor({ tenantId: 't2', namespace: 'alpha' }));
        expect(t1?.tenantId).toBe('t1');
        expect(t2?.tenantId).toBe('t2');
      });
    });

    describe('putOnce', () => {
      it('inserts only one live record for the same dedupe key', async () => {
        const first = makeRecord('first', {
          content: 'first content',
          metadata: { dedupeKey: 'run-1:0' },
        });
        const second = makeRecord('second', {
          content: 'second content',
          metadata: { dedupeKey: 'run-1:0' },
        });

        const [firstResult, secondResult] = await Promise.all([
          storage.putOnce!(first),
          storage.putOnce!(second),
        ]);

        const inserted = [firstResult, secondResult].filter((result) => result.inserted);
        expect(inserted).toHaveLength(1);
        expect(await storage.count(SCOPE)).toBe(1);

        const records = await storage.list(SCOPE);
        expect(records).toHaveLength(1);
        expect([first.id, second.id]).toContain(records[0]!.id);

        const duplicateResult = firstResult.inserted ? secondResult : firstResult;
        expect(duplicateResult.record.id).toBe(records[0]!.id);
        expect(duplicateResult.inserted).toBe(false);
        await Promise.resolve(
          expect(await storage.getByDedupeKey!(SCOPE, 'run-1:0')).toMatchObject({
            id: records[0]!.id,
          }),
        );
      });

      it('returns the existing record unchanged for a sequential duplicate dedupe key', async () => {
        const first = makeRecord('first', {
          content: 'first content',
          metadata: { dedupeKey: 'run-1:0' },
        });
        const second = makeRecord('second', {
          content: 'second content',
          metadata: { dedupeKey: 'run-1:0', attempted: true },
        });

        const firstResult = await storage.putOnce!(first);
        const secondResult = await storage.putOnce!(second);

        expect(firstResult.inserted).toBe(true);
        expect(secondResult.inserted).toBe(false);
        expect(secondResult.record.id).toBe(first.id);
        expect(secondResult.record.content).toBe(first.content);
        expect(secondResult.record.metadata).toEqual(first.metadata);
        expect(await storage.count(SCOPE)).toBe(1);
      });

      it('rejects a putOnce record without a non-empty dedupe key in metadata', async () => {
        await Promise.resolve(
          expect(await throwingRejectionOf(storage.putOnce!(makeRecord('missing-key')))).toThrow(
            /record\.metadata\.dedupeKey must be a non-empty string/,
          ),
        );
        await Promise.resolve(
          expect(
            await throwingRejectionOf(
              storage.putOnce!(makeRecord('empty-key', { metadata: { dedupeKey: '' } })),
            ),
          ).toThrow(/record\.metadata\.dedupeKey must be a non-empty string/),
        );
      });

      it('rejects a putOnce record that is not active', async () => {
        await Promise.resolve(
          expect(
            await throwingRejectionOf(
              storage.putOnce!(
                makeRecord('deleted-key', {
                  metadata: { dedupeKey: 'deleted-key' },
                  status: 'deleted',
                }),
              ),
            ),
          ).toThrow(/putOnce requires an active record/),
        );
      });

      it('allows the same dedupe key in a different namespace', async () => {
        await storage.putOnce!(
          makeRecord('alpha', { namespace: 'alpha', metadata: { dedupeKey: 'shared' } }),
        );
        await storage.putOnce!(
          makeRecord('beta', { namespace: 'beta', metadata: { dedupeKey: 'shared' } }),
        );

        expect(await storage.count(scopeFor({ namespace: 'alpha' }))).toBe(1);
        expect(await storage.count(scopeFor({ namespace: 'beta' }))).toBe(1);
      });

      it('allows reusing a dedupe key after deleting its record', async () => {
        const first = makeRecord('first', { metadata: { dedupeKey: 'deleted-key' } });
        const second = makeRecord('second', { metadata: { dedupeKey: 'deleted-key' } });

        await storage.putOnce!(first);
        expect(await storage.delete(first.id, SCOPE)).toBe(true);

        const result = await storage.putOnce!(second);
        expect(result.inserted).toBe(true);
        expect(result.record.id).toBe(second.id);
        expect(await storage.count(SCOPE)).toBe(1);
      });

      it('allows reusing a dedupe key after deleting the namespace', async () => {
        const first = makeRecord('first', { metadata: { dedupeKey: 'namespace-key' } });
        const second = makeRecord('second', { metadata: { dedupeKey: 'namespace-key' } });

        await storage.putOnce!(first);
        expect(await storage.deleteNamespace(SCOPE)).toBe(1);

        const result = await storage.putOnce!(second);
        expect(result.inserted).toBe(true);
        expect(result.record.id).toBe(second.id);
        expect(await storage.count(SCOPE)).toBe(1);
      });

      it('allows reusing a dedupe key after a put replacement changes the key', async () => {
        const original = makeRecord('same-id', { metadata: { dedupeKey: 'old-key' } });
        await storage.put(original);
        await storage.put(makeRecord('same-id', { metadata: { dedupeKey: 'new-key' } }));

        const result = await storage.putOnce!(
          makeRecord('new-id', { metadata: { dedupeKey: 'old-key' } }),
        );

        expect(result.inserted).toBe(true);
        expect(result.record.id).toBe('new-id');
        await Promise.resolve(
          expect(await storage.getByDedupeKey!(SCOPE, 'new-key')).toMatchObject({
            id: 'same-id',
          }),
        );
      });

      it('allows reusing a dedupe key after an update changes the key', async () => {
        await storage.put(makeRecord('same-id', { metadata: { dedupeKey: 'old-key' } }));
        await storage.update('same-id', SCOPE, { metadata: { dedupeKey: 'new-key' } });

        const result = await storage.putOnce!(
          makeRecord('new-id', { metadata: { dedupeKey: 'old-key' } }),
        );

        expect(result.inserted).toBe(true);
        expect(result.record.id).toBe('new-id');
        await Promise.resolve(
          expect(await storage.getByDedupeKey!(SCOPE, 'new-key')).toMatchObject({
            id: 'same-id',
          }),
        );
      });
    });

    describe('getMany', () => {
      it('returns only the present records, omitting missing ids', async () => {
        await storage.put(makeRecord('a'));
        await storage.put(makeRecord('b'));

        const records = await storage.getMany(['a', 'missing', 'b'], SCOPE);
        expect(records.map((r) => r.id).toSorted()).toEqual(['a', 'b']);
      });
    });

    describe('list', () => {
      it('returns records newest-first', async () => {
        await storage.put(makeRecord('old', { createdAt: 1000 }));
        await storage.put(makeRecord('new', { createdAt: 2000 }));

        const records = await storage.list(SCOPE);
        expect(records.map((r) => r.id)).toEqual(['new', 'old']);
      });

      it('honors limit and offset', async () => {
        await storage.put(makeRecord('a', { createdAt: 3000 }));
        await storage.put(makeRecord('b', { createdAt: 2000 }));
        await storage.put(makeRecord('c', { createdAt: 1000 }));

        const page = await storage.list(SCOPE, { limit: 1, offset: 1 });
        expect(page.map((r) => r.id)).toEqual(['b']);
      });
    });

    describe('count', () => {
      it('counts records in the scope', async () => {
        await storage.put(makeRecord('a'));
        await storage.put(makeRecord('b'));
        expect(await storage.count(SCOPE)).toBe(2);
      });
    });

    describe('update', () => {
      it('patches fields and bumps the version', async () => {
        await storage.put(makeRecord('a'));
        const updated = await storage.update('a', SCOPE, { content: 'patched' });

        expect(updated?.content).toBe('patched');
        expect(updated?.version).toBe(2);

        const reread = await storage.get('a', SCOPE);
        expect(reread?.content).toBe('patched');
        expect(reread?.version).toBe(2);
      });

      it('returns undefined when no record matches', async () => {
        expect(await storage.update('missing', SCOPE, { content: 'x' })).toBeUndefined();
        expect(
          await storage.update('missing', SCOPE, { content: 'x' }, { expectedVersion: 1 }),
        ).toBeUndefined();
      });

      it('applies a version-conditional update only at the expected version', async () => {
        await storage.put(makeRecord('a'));
        const updated = await storage.update(
          'a',
          SCOPE,
          { content: 'first' },
          { expectedVersion: 1 },
        );
        expect(updated?.version).toBe(2);

        const stale = storage.update('a', SCOPE, { content: 'stale' }, { expectedVersion: 1 });
        const conflict = await rejectionOf(stale);
        expect(conflict).toBeInstanceOf(MemoryRecordVersionConflictError);
        expect(conflict).toMatchObject({ code: 'version-conflict', recordIds: ['a'] });
        const reread = await storage.get('a', SCOPE);
        expect(reread?.content).toBe('first');
        expect(reread?.version).toBe(2);
      });
    });

    registerVectorSearchContractTests({ storage: () => storage, scope: SCOPE, makeRecord });

    registerDeleteContractTests({ makeBackend: options.makeBackend, scopeFor, makeRecord });
  });
}
