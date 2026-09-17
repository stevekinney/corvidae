import { beforeEach, describe, expect, it } from 'bun:test';
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
}
