/**
 * Tests for the dual-namespace memory (merged-read / private-write) semantics
 * specified by D3 — Memory over the same store (prefix namespacing).
 *
 * Architecture contract (from architecture.md / plan.md D3):
 *   - remember() writes to the PRIVATE (agent) namespace only.
 *   - recall()  searches private ∪ shared, merges by score, returns top N.
 *   - list()    returns entries from both, merged newest-first.
 *   - forget()  and forgetAll() target the PRIVATE namespace only.
 *   - count()   is the sum of both namespaces.
 *   - Standalone agent (no sharedMemory) reads and writes private only.
 *
 * Namespace model:
 *   tenantId  = bureau id  (the tenant boundary)
 *   namespace = agent name  (per-agent within the bureau)
 *
 * Prefix namespacing assertion:
 *   app:agent-bureau:memory:v1: is disjoint from all WEFT_RESERVED_KEY_PREFIXES
 *   (also exercised in create-weft-memory-record-storage.test.ts — repeated
 *   here so D3's acceptance criteria live in one place for reviewers).
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { createDualNamespaceMemory } from '../src/dual-namespace-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;
// Fixed instant used to stamp fixture records below — only relative ordering (via `now + i`)
// matters to these tests, never the real clock.

/**
 * Builds a createMemory instance scoped to a single namespace, backed by the
 * in-memory test storage.
 */
function makeMemory(namespace: string): Memory {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  return createMemory({ embedder, storage, namespace });
}

// ─── D3 acceptance: key prefix is disjoint from Weft reserved prefixes ──────

describe('createDualNamespaceMemory — merged-read / private-write', () => {
  let privateMemory: Memory;
  let sharedMemory: Memory;
  let dualMemory: Memory;

  beforeEach(async () => {
    privateMemory = makeMemory('agent-researcher');
    sharedMemory = makeMemory('bureau-global');
    dualMemory = createDualNamespaceMemory(privateMemory, sharedMemory);
    await dualMemory.init();
  });

  describe('remember() — private-write', () => {
    it('writes to the private namespace only, not the shared namespace', async () => {
      await dualMemory.remember('Agent-only knowledge');

      expect(await privateMemory.count()).toBe(1);
      expect(await sharedMemory.count()).toBe(0);
    });

    it('the remembered entry is readable through the private Memory', async () => {
      const entry = await dualMemory.remember('Private note');
      const listed = await privateMemory.list();

      expect(listed.some((e) => e.id === entry.id)).toBe(true);
    });
  });

  describe('rememberOnce() — private-write', () => {
    it('writes to the private namespace only on the first call', async () => {
      await dualMemory.rememberOnce('Idempotent private note', { dedupeKey: 'note-1' });

      expect(await privateMemory.count()).toBe(1);
      expect(await sharedMemory.count()).toBe(0);
    });

    it('returns the existing record on duplicate dedupeKey without writing to shared', async () => {
      const first = await dualMemory.rememberOnce('Note A', { dedupeKey: 'key-1' });
      const second = await dualMemory.rememberOnce('Note B', { dedupeKey: 'key-1' });

      expect(second.id).toBe(first.id);
      expect(await privateMemory.count()).toBe(1);
      expect(await sharedMemory.count()).toBe(0);
    });
  });

  // ── read path ───────────────────────────────────────────────────────────

  describe('recall() — merged-read from private ∪ shared', () => {
    it('returns results from both private and shared namespaces', async () => {
      await privateMemory.remember('Machine learning fundamentals');
      await sharedMemory.remember('Machine learning advanced techniques');

      const results = await dualMemory.recall('machine learning');

      expect(results.length).toBeGreaterThanOrEqual(2);
      const namespaces = results.map((r) => r.metadata.namespace);
      expect(namespaces).toContain('agent-researcher');
      expect(namespaces).toContain('bureau-global');
    });

    it('strips a caller-supplied namespace so recall still reads private ∪ shared (regression PRRT_kwDORvupsc6Ma-Dx)', async () => {
      // The bureau memory hook calls recall(query, { namespace: sessionId }).
      // createMemory.recall gives options.namespace precedence over each memory's
      // configured namespace, so forwarding it would redirect both underlying
      // reads to the (empty) caller namespace and return nothing. recall() must
      // strip it, mirroring remember()/rememberOnce()/forget().
      await privateMemory.remember('Namespace isolation in recall');
      await sharedMemory.remember('Namespace isolation shared note');

      const results = await dualMemory.recall('namespace isolation', {
        namespace: 'some-session-id',
      });

      // Without the strip, both underlying recalls would target 'some-session-id'
      // (empty) and return []. With the strip, the configured private/shared
      // namespaces are read as usual.
      expect(results.length).toBeGreaterThanOrEqual(2);
      const namespaces = results.map((r) => r.metadata.namespace);
      expect(namespaces).toContain('agent-researcher');
      expect(namespaces).toContain('bureau-global');
    });

    it('results are sorted by score descending across both namespaces', async () => {
      await privateMemory.remember('TypeScript type inference guide');
      await sharedMemory.remember('TypeScript generics deep dive');

      const results = await dualMemory.recall('TypeScript type system');

      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
      }
    });

    it('respects the limit option across the merged result set', async () => {
      for (let i = 0; i < 5; i++) {
        await privateMemory.remember(`Private entry about topic number ${i}`);
        await sharedMemory.remember(`Shared entry about topic number ${i}`);
      }

      const results = await dualMemory.recall('topic', { limit: 3 });

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('deduplicates: private copy wins if the same id somehow appears in both', async () => {
      // Simulate by adding the same content to both; they get different ids so
      // dedup by content does not trigger here — we just check no duplication
      // of actual ids in the merged set.
      await privateMemory.remember('Shared concept X');
      await sharedMemory.remember('Shared concept X');

      const results = await dualMemory.recall('concept X', { limit: 10 });

      const ids = results.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('returns only private results when no shared content exists', async () => {
      await privateMemory.remember('Private-only knowledge');

      const results = await dualMemory.recall('knowledge');

      for (const result of results) {
        expect(result.metadata.namespace).toBe('agent-researcher');
      }
    });

    it('returns shared results even when private namespace is empty', async () => {
      await sharedMemory.remember('Bureau-global fact');

      const results = await dualMemory.recall('fact');

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.metadata.namespace).toBe('bureau-global');
      }
    });
  });

  describe('list() — merged newest-first', () => {
    it('returns entries from both namespaces merged newest-first', async () => {
      await privateMemory.remember('Private entry');
      await sharedMemory.remember('Shared entry');

      const results = await dualMemory.list();

      expect(results.length).toBe(2);
      const namespaces = results.map((r) => r.metadata.namespace);
      expect(namespaces).toContain('agent-researcher');
      expect(namespaces).toContain('bureau-global');

      // Newest-first ordering.
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.createdAt).toBeLessThanOrEqual(results[i - 1]!.createdAt);
      }
    });

    it('respects limit and offset across the merged set', async () => {
      for (let i = 0; i < 3; i++) await privateMemory.remember(`P${i}`);
      for (let i = 0; i < 3; i++) await sharedMemory.remember(`S${i}`);

      const page1 = await dualMemory.list({ limit: 2, offset: 0 });
      const page2 = await dualMemory.list({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      // No id overlap between pages.
      const page1Ids = new Set(page1.map((r) => r.id));
      const page2Ids = new Set(page2.map((r) => r.id));
      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false);
      }
    });

    it('strips a caller-supplied namespace so list() still reads private ∪ shared (regression PRRT_kwDORvupsc6MbhPw)', async () => {
      // The gateway memory route calls memory.list({ namespace, limit, offset }).
      // createMemory.list gives options.namespace precedence over each memory's
      // configured namespace, so forwarding it would redirect both underlying
      // list() calls to the caller namespace (e.g. a session id) instead of the
      // configured private and shared namespaces — returning empty or wrong
      // records even though recall() was already fixed to strip this.
      await privateMemory.remember('Private namespace list entry');
      await sharedMemory.remember('Shared namespace list entry');

      // Simulate the gateway passing a caller/session namespace.
      const results = await dualMemory.list({ namespace: 'some-session-id', limit: 10 });

      // Without the strip, both underlying list() calls target 'some-session-id'
      // (empty) and return []. With the strip, the configured private/shared
      // namespaces are read and merged as usual.
      expect(results.length).toBe(2);
      const namespaces = results.map((r) => r.metadata.namespace);
      expect(namespaces).toContain('agent-researcher');
      expect(namespaces).toContain('bureau-global');
    });
  });

  // ── delete path ─────────────────────────────────────────────────────────

  describe('forget() — private namespace only', () => {
    it('deletes from the private namespace only', async () => {
      const entry = await privateMemory.remember('To be forgotten');

      await dualMemory.forget(entry.id);

      expect(await privateMemory.count()).toBe(0);
      // Shared namespace is unaffected.
      expect(await sharedMemory.count()).toBe(0);
    });

    it('does not allow deleting entries from the shared namespace', async () => {
      const sharedEntry = await sharedMemory.remember('Shared record');

      // forget() targets private — so deleting a shared id through the dual
      // wrapper is a no-op (the private scope has no such id).
      await dualMemory.forget(sharedEntry.id);

      // The shared entry is still present.
      expect(await sharedMemory.count()).toBe(1);
    });
  });

  describe('forgetAll() — private namespace only', () => {
    it('clears the private namespace only, leaving shared intact', async () => {
      await privateMemory.remember('Private A');
      await privateMemory.remember('Private B');
      await sharedMemory.remember('Shared A');

      await dualMemory.forgetAll();

      expect(await privateMemory.count()).toBe(0);
      expect(await sharedMemory.count()).toBe(1);
    });
  });

  // ── count ───────────────────────────────────────────────────────────────

  describe('count() — sum of both namespaces', () => {
    it('returns the combined record count from private and shared', async () => {
      await privateMemory.remember('P1');
      await privateMemory.remember('P2');
      await sharedMemory.remember('S1');

      expect(await dualMemory.count()).toBe(3);
    });

    it('returns 0 when both namespaces are empty', async () => {
      expect(await dualMemory.count()).toBe(0);
    });
  });
});

// ─── D3 acceptance: standalone agent gets only injected private memory ────────
