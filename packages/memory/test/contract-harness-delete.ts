import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryRecordVersionConflictError } from '../src/memory-record-storage';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from '../src/types';

export function registerDeleteContractTests(options: {
  makeBackend: () => MemoryRecordStorage;
  scopeFor: (scope: MemoryRecordScope) => MemoryRecordScope;
  makeRecord: (id: string, overrides?: Partial<MemoryRecord>) => MemoryRecord;
}): void {
  const { makeBackend, scopeFor, makeRecord } = options;
  const SCOPE = scopeFor({ namespace: 'alpha' });
  let storage: MemoryRecordStorage;
  beforeEach(async () => {
    storage = makeBackend();
    await storage.init();
  });
  describe('delete invariant (shared across backends)', () => {
    it('returns true when it removed a record, false when absent', async () => {
      await storage.put(makeRecord('a'));
      expect(await storage.delete('a', SCOPE)).toBe(true);
      expect(await storage.delete('a', SCOPE)).toBe(false);
      expect(await storage.delete('never-existed', SCOPE)).toBe(false);
    });

    it('makes a deleted record vanish from every read', async () => {
      await storage.put(makeRecord('a', { vector: new Float32Array([1, 0]) }));
      await storage.put(makeRecord('b', { vector: new Float32Array([1, 0]) }));

      expect(await storage.delete('a', SCOPE)).toBe(true);

      expect(await storage.get('a', SCOPE)).toBeUndefined();
      const fetched = await storage.getMany(['a', 'b'], SCOPE);
      expect(fetched.map((r) => r.id)).toEqual(['b']);
      const listed = await storage.list(SCOPE);
      expect(listed.map((r) => r.id)).toEqual(['b']);
      expect(await storage.count(SCOPE)).toBe(1);
      const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
      expect(hits.map((hit) => hit.id)).toEqual(['b']);
    });

    it('cannot be updated after deletion', async () => {
      await storage.put(makeRecord('a'));
      await storage.delete('a', SCOPE);
      expect(await storage.update('a', SCOPE, { content: 'zombie' })).toBeUndefined();
    });

    it('treats a directly put() non-active record as invisible to every read', async () => {
      // The contract permits passing any MemoryRecord to put(); a record whose
      // status is already 'deleted' must never surface from a read, and count()
      // must agree with get/list/search. This pins both backends to the SAME
      // answer on this input so neither can silently diverge — count() in
      // particular must not fall back to a raw key-count that ignores status.
      await storage.put(makeRecord('ghost', { status: 'deleted' }));
      await storage.put(makeRecord('live', { status: 'active' }));

      expect(await storage.get('ghost', SCOPE)).toBeUndefined();
      const fetched = await storage.getMany(['ghost', 'live'], SCOPE);
      expect(fetched.map((r) => r.id)).toEqual(['live']);
      const listed = await storage.list(SCOPE);
      expect(listed.map((r) => r.id)).toEqual(['live']);
      expect(await storage.count(SCOPE)).toBe(1);
      const hits = await storage.searchByVector([1, 0], SCOPE, { limit: 10 });
      expect(hits.map((hit) => hit.id)).toEqual(['live']);
    });
  });

  describe('deleteNamespace', () => {
    it('clears only the targeted scope and returns the count removed', async () => {
      await storage.put(makeRecord('a', { namespace: 'alpha' }));
      await storage.put(makeRecord('b', { namespace: 'alpha' }));
      await storage.put(makeRecord('c', { namespace: 'beta' }));

      const removed = await storage.deleteNamespace(scopeFor({ namespace: 'alpha' }));
      expect(removed).toBe(2);

      expect(await storage.count(scopeFor({ namespace: 'alpha' }))).toBe(0);
      expect(await storage.list(scopeFor({ namespace: 'alpha' }))).toEqual([]);
      expect(await storage.count(scopeFor({ namespace: 'beta' }))).toBe(1);
    });

    it('returns 0 when the scope is already empty', async () => {
      expect(await storage.deleteNamespace(scopeFor({ namespace: 'empty' }))).toBe(0);
    });
  });

  describe('deleteMany (atomic multi-record deletion)', () => {
    it('removes every listed record across scopes and reports how many were live', async () => {
      const beta = scopeFor({ namespace: 'beta' });
      const otherTenant = scopeFor({ tenantId: 't2', namespace: 'alpha' });
      await storage.put(makeRecord('a'));
      await storage.put(makeRecord('b'));
      await storage.put(makeRecord('c', { namespace: 'beta' }));
      await storage.put(makeRecord('d', { tenantId: 't2', namespace: 'alpha' }));

      const removed = await storage.deleteMany!([
        { id: 'a', scope: SCOPE },
        { id: 'c', scope: beta },
        { id: 'd', scope: otherTenant },
        { id: 'never-existed', scope: SCOPE },
      ]);

      expect(removed).toBe(3);
      const remaining = await storage.list(SCOPE);
      expect(remaining.map((record) => record.id)).toEqual(['b']);
      expect(await storage.count(beta)).toBe(0);
      expect(await storage.count(otherTenant)).toBe(0);
    });

    it('is idempotent: repeating a completed deletion removes nothing further', async () => {
      await storage.put(makeRecord('a'));
      expect(await storage.deleteMany!([{ id: 'a', scope: SCOPE }])).toBe(1);
      expect(await storage.deleteMany!([{ id: 'a', scope: SCOPE }])).toBe(0);
      expect(await storage.deleteMany!([])).toBe(0);
    });

    it('deletes version-conditioned references only when every one is still at its version', async () => {
      await storage.put(makeRecord('a'));
      await storage.put(makeRecord('b'));
      await storage.update('b', SCOPE, { content: 'changed' });

      const stale = storage.deleteMany!([
        { id: 'a', scope: SCOPE, expectedVersion: 1 },
        { id: 'b', scope: SCOPE, expectedVersion: 1 },
      ]);
      const conflict = await rejectionOf(stale);
      expect(conflict).toBeInstanceOf(MemoryRecordVersionConflictError);
      expect(conflict).toMatchObject({ code: 'version-conflict', recordIds: ['b'] });
      const kept = await storage.list(SCOPE);
      expect(kept.map((record) => record.id).toSorted()).toEqual(['a', 'b']);

      expect(
        await storage.deleteMany!([
          { id: 'a', scope: SCOPE, expectedVersion: 1 },
          { id: 'b', scope: SCOPE, expectedVersion: 2 },
          { id: 'never-existed', scope: SCOPE, expectedVersion: 1 },
        ]),
      ).toBe(2);
      expect(await storage.count(SCOPE)).toBe(0);
    });

    it('releases the dedupe key of every deleted record', async () => {
      await storage.put(makeRecord('a', { metadata: { dedupeKey: 'op-1' } }));
      await storage.deleteMany!([{ id: 'a', scope: SCOPE }]);

      expect(await storage.getByDedupeKey!(SCOPE, 'op-1')).toBeUndefined();
      const again = await storage.putOnce!(makeRecord('a2', { metadata: { dedupeKey: 'op-1' } }));
      expect(again.inserted).toBe(true);
    });
  });
}
