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
import type { Memory, MemoryRecordStorage } from '../src/types';

const DIMENSION = 64;
// Fixed instant used to stamp fixture records below — only relative ordering (via `now + i`)
// matters to these tests, never the real clock.
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Builds a createMemory instance scoped to a single namespace, backed by the
 * in-memory test storage.
 */
// ─── D3 acceptance: key prefix is disjoint from Weft reserved prefixes ──────

describe('createDualNamespaceMemory list() — deep pagination regression (PRRT_kwDORvupsc6MV8XV)', () => {
  /**
   * Builds a Memory instance backed by a shared storage, pre-populated
   * with `count` distinct records in the given namespace. Records are put
   * directly into storage to bypass embedding overhead.
   */
  async function makeMemoryWithRecords(
    namespace: string,
    count: number,
    storage: MemoryRecordStorage,
  ): Promise<Memory> {
    const embedder = createMockEmbedder(DIMENSION);
    const mem = createMemory({ embedder, storage, namespace });
    await mem.init();

    const now = FIXED_NOW;
    for (let i = 0; i < count; i++) {
      await storage.put({
        id: `${namespace}-record-${i}`,
        namespace,
        content: `Record ${i} in ${namespace}`,
        vector: new Float32Array(DIMENSION).fill(0),
        metadata: {},
        createdAt: now + i,
        updatedAt: now + i,
        version: 1,
        status: 'active',
      });
    }

    return mem;
  }

  it('returns non-empty pages for offset >= 100 when private namespace has > 100 records', async () => {
    // 105 records in private, 0 in shared.
    const privateStorage = createInMemoryMemoryRecordStorage();
    const sharedStorage = createInMemoryMemoryRecordStorage();
    const embedder = createMockEmbedder(DIMENSION);

    const privateMemory = await makeMemoryWithRecords('agent-private', 105, privateStorage);
    const sharedMemory = createMemory({ embedder, storage: sharedStorage, namespace: 'shared' });
    await sharedMemory.init();

    const dual = createDualNamespaceMemory(privateMemory, sharedMemory);

    // Page starting at offset 100 should have 5 records (indices 100-104).
    const page = await dual.list({ limit: 10, offset: 100 });
    expect(page.length).toBe(5);
  });

  it('paginates correctly across pages when combined total exceeds 100', async () => {
    // 60 private + 60 shared = 120 total. A page at offset 100 should return 20.
    const privateStorage = createInMemoryMemoryRecordStorage();
    const sharedStorage = createInMemoryMemoryRecordStorage();

    const privateMemory = await makeMemoryWithRecords('agent-private', 60, privateStorage);
    const sharedMemory = await makeMemoryWithRecords('bureau-global', 60, sharedStorage);

    const dual = createDualNamespaceMemory(privateMemory, sharedMemory);

    const firstHundred = await dual.list({ limit: 100, offset: 0 });
    const remainder = await dual.list({ limit: 100, offset: 100 });

    expect(firstHundred.length).toBe(100);
    expect(remainder.length).toBe(20);

    // Pages must not overlap.
    const firstIds = new Set(firstHundred.map((r) => r.id));
    for (const r of remainder) {
      expect(firstIds.has(r.id)).toBe(false);
    }
  });
});

// ─── Regression: remember() / rememberOnce() strip caller namespace ──────────
//
// PRRT_kwDORvupsc6MaaR3: the dual wrapper forwarded metadata as-is to
// privateMemory.remember / rememberOnce. createMemory honours
// `metadata.namespace` over its configured default, so a caller-supplied
// namespace (e.g. a session namespace from the bureau persist hook, or the
// 'experiential' namespace from createRunCaptureHook) was used instead of the
// private namespace — writes landed outside the agent-private scope.

describe('createDualNamespaceMemory remember() / rememberOnce() — namespace isolation regression (PRRT_kwDORvupsc6MaaR3)', () => {
  /**
   * Shared storage backend, private and shared Memory instances over it.
   * This mirrors the production D3 prefix-namespacing topology where the
   * namespace-override bug is directly observable: writes land in the wrong
   * scope of the SAME storage.
   */
  let sharedStorage: MemoryRecordStorage;
  let privateMemory: Memory;
  let sharedMemory: Memory;
  let dual: Memory;

  beforeEach(async () => {
    sharedStorage = createInMemoryMemoryRecordStorage();
    const embedder = createMockEmbedder(DIMENSION);
    privateMemory = createMemory({ embedder, storage: sharedStorage, namespace: 'agent-private' });
    sharedMemory = createMemory({ embedder, storage: sharedStorage, namespace: 'bureau-global' });
    dual = createDualNamespaceMemory(privateMemory, sharedMemory);
    await dual.init();
  });

  it('remember() with a caller-supplied shared namespace still writes to private, not shared', async () => {
    // Simulates the bureau persist hook passing a session/shared namespace.
    const entry = await dual.remember('Experiential note', { namespace: 'bureau-global' });

    // The entry must land in the private namespace.
    expect(await privateMemory.count()).toBe(1);
    expect(await sharedMemory.count()).toBe(0);
    // The returned entry reflects the private namespace, not the caller's.
    expect(entry.metadata.namespace).toBe('agent-private');
  });

  it('remember() with an arbitrary session namespace writes to private only', async () => {
    // Simulates createRunCaptureHook passing namespace:'experiential' or a
    // session namespace supplied by the bureau at runtime.
    const entry = await dual.remember('Session fact', { namespace: 'session-xyz' });

    expect(await privateMemory.count()).toBe(1);
    expect(await sharedMemory.count()).toBe(0);
    expect(entry.metadata.namespace).toBe('agent-private');
  });

  it('rememberOnce() with a caller-supplied namespace still writes to private', async () => {
    const entry = await dual.rememberOnce('Idempotent experiential note', {
      dedupeKey: 'run-1',
      namespace: 'bureau-global',
    });

    expect(await privateMemory.count()).toBe(1);
    expect(await sharedMemory.count()).toBe(0);
    expect(entry.metadata.namespace).toBe('agent-private');
  });
});

// ─── Regression: forget() / forgetAll() ignore caller-supplied namespace ─────
//
// PRRT_kwDORvupsc6MV8Xi: the original code forwarded `namespace` to
// privateMemory.forget / forgetAll. When private and shared memories share
// the same underlying storage (the intended D3 prefix-namespacing topology),
// a caller could pass the shared namespace name and delete a shared record.

describe('createDualNamespaceMemory forget() / forgetAll() — namespace isolation regression (PRRT_kwDORvupsc6MV8Xi)', () => {
  /**
   * Shared storage backend, private and shared Memory instances over it with
   * different namespaces. This is the D3 prefix-namespacing topology where the
   * namespace-forwarding bug is exploitable.
   */
  let sharedStorage: MemoryRecordStorage;
  let privateMemory: Memory;
  let sharedMemory: Memory;
  let dual: Memory;

  beforeEach(async () => {
    sharedStorage = createInMemoryMemoryRecordStorage();
    const embedder = createMockEmbedder(DIMENSION);
    privateMemory = createMemory({ embedder, storage: sharedStorage, namespace: 'agent-private' });
    sharedMemory = createMemory({ embedder, storage: sharedStorage, namespace: 'bureau-global' });
    dual = createDualNamespaceMemory(privateMemory, sharedMemory);
    await dual.init();
  });

  it('forget() with the shared namespace name cannot delete a shared record', async () => {
    // Write directly to the shared namespace via sharedMemory.
    const sharedEntry = await sharedMemory.remember('Shared bureau fact');
    expect(await sharedMemory.count()).toBe(1);

    // Attempt to delete via dual, explicitly naming the shared namespace.
    // With the bug, privateMemory.forget(id, 'bureau-global') targets the
    // shared scope in storage and removes the record. After the fix the
    // namespace argument is dropped and the call is a private-scope no-op.
    await dual.forget(sharedEntry.id, 'bureau-global');

    expect(await sharedMemory.count()).toBe(1);
  });

  it('forgetAll() with the shared namespace name cannot clear the shared namespace', async () => {
    await sharedMemory.remember('Shared fact A');
    await sharedMemory.remember('Shared fact B');
    expect(await sharedMemory.count()).toBe(2);

    // Attempt a forgetAll targeting the shared namespace through the dual wrapper.
    await dual.forgetAll('bureau-global');

    expect(await sharedMemory.count()).toBe(2);
  });
});
