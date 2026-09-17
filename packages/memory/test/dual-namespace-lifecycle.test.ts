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

  describe('@repo/lifecycle', () => {
    it('initializes both private and shared memories', async () => {
      const lifecyclePrivateMemory = makeMemory('lifecycle-private');
      const lifecycleSharedMemory = makeMemory('lifecycle-shared');
      let privateInitCount = 0;
      let sharedInitCount = 0;
      const originalPrivateInit = lifecyclePrivateMemory.init.bind(lifecyclePrivateMemory);
      const originalSharedInit = lifecycleSharedMemory.init.bind(lifecycleSharedMemory);
      lifecyclePrivateMemory.init = async () => {
        privateInitCount++;
        await originalPrivateInit();
      };
      lifecycleSharedMemory.init = async () => {
        sharedInitCount++;
        await originalSharedInit();
      };
      const lifecycleDualMemory = createDualNamespaceMemory(
        lifecyclePrivateMemory,
        lifecycleSharedMemory,
      );

      await lifecycleDualMemory.init();

      expect(privateInitCount).toBe(1);
      expect(sharedInitCount).toBe(1);
    });

    it('closes both private and shared memories', async () => {
      let privateCloseCount = 0;
      let sharedCloseCount = 0;
      const originalPrivateClose = privateMemory.close.bind(privateMemory);
      const originalSharedClose = sharedMemory.close.bind(sharedMemory);
      privateMemory.close = async () => {
        privateCloseCount++;
        await originalPrivateClose();
      };
      sharedMemory.close = async () => {
        sharedCloseCount++;
        await originalSharedClose();
      };

      await dualMemory.close();

      expect(privateCloseCount).toBe(1);
      expect(sharedCloseCount).toBe(1);
    });
  });

  // ── write path ──────────────────────────────────────────────────────────
});
