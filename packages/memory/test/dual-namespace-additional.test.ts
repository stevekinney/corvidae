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

import { MemoryStorage, WEFT_RESERVED_KEY_PREFIXES } from '@repo/weft';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import {
  createWeftMemoryRecordStorage,
  DEFAULT_MEMORY_KEY_PREFIX,
} from '../src/create-weft-memory-record-storage';
import { createDualNamespaceMemory } from '../src/dual-namespace-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;
// Fixed instant used to stamp fixture records below — only relative ordering (via `now + i`)
// matters to these tests, never the real clock.
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

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

describe('D3 prefix namespacing — app:agent-bureau:memory:v1:', () => {
  it('does not collide with any WEFT_RESERVED_KEY_PREFIXES entry (neither direction)', () => {
    for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
      expect(
        DEFAULT_MEMORY_KEY_PREFIX.startsWith(reserved),
        `DEFAULT_MEMORY_KEY_PREFIX starts with reserved prefix "${reserved}"`,
      ).toBe(false);

      expect(
        reserved.startsWith(DEFAULT_MEMORY_KEY_PREFIX),
        `Reserved prefix "${reserved}" starts with DEFAULT_MEMORY_KEY_PREFIX`,
      ).toBe(false);
    }
  });

  it('stores memory records under the memory prefix, never under a Weft reserved prefix', async () => {
    const underlying = new MemoryStorage();
    const storage = createWeftMemoryRecordStorage(underlying);
    await storage.init();

    const now = FIXED_NOW;
    await storage.put({
      id: 'test-id',
      namespace: 'agent',
      content: 'hello',
      vector: new Float32Array([1, 0, 0]),
      metadata: {},
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: 'active',
    });

    for (const key of underlying.snapshot().keys()) {
      expect(key.startsWith(DEFAULT_MEMORY_KEY_PREFIX)).toBe(true);
      for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
        expect(key.startsWith(reserved)).toBe(false);
      }
    }
  });
});

// ─── D3 acceptance: merged-read / private-write semantics ───────────────────

describe('createDualNamespaceMemory — standalone (no sharedMemory)', () => {
  let privateMemory: Memory;
  let standaloneMemory: Memory;

  beforeEach(async () => {
    privateMemory = makeMemory('agent-standalone');
    // No sharedMemory — the standalone path.
    standaloneMemory = createDualNamespaceMemory(privateMemory);
    await standaloneMemory.init();
  });

  it('remember() writes to the private namespace', async () => {
    await standaloneMemory.remember('Standalone knowledge');
    expect(await privateMemory.count()).toBe(1);
  });

  it('recall() reads from private only (no shared pool to merge)', async () => {
    await privateMemory.remember('Private standalone fact');
    const results = await standaloneMemory.recall('standalone fact');

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.metadata.namespace).toBe('agent-standalone');
    }
  });

  it('list() returns only private entries', async () => {
    await privateMemory.remember('Private entry');
    const results = await standaloneMemory.list();

    expect(results.length).toBe(1);
    expect(results[0]!.metadata.namespace).toBe('agent-standalone');
  });

  it('count() returns only the private count', async () => {
    await privateMemory.remember('P1');
    await privateMemory.remember('P2');
    expect(await standaloneMemory.count()).toBe(2);
  });

  it('forgetAll() clears only the private namespace', async () => {
    await privateMemory.remember('To clear');
    await standaloneMemory.forgetAll();
    expect(await standaloneMemory.count()).toBe(0);
  });
});

// ─── D3 acceptance: tenantId scoping (bureau = tenant boundary) ──────────────

// ─── Regression: list() fetches enough records to serve deep pages ────────────
//
// PRRT_kwDORvupsc6MV8XV: `limit: undefined` in the inner list() calls was
// capped at 100 by createMemory's default, so pages past offset 100 were
// empty or truncated. The fix fetches (offset + limit) from each side.
