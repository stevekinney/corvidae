import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import {
  clearProposals,
  getProposal,
  isRejectedPattern,
  rejectProposal,
  saveProposal,
} from '../../src/self-improvement/proposals';
import { createMockKeyValueStore } from '../../src/test';
import type { Proposal } from '../../src/types';

// Fixed instant standing in for a proposal's createdAt below — saveProposal persists whatever
// the caller provides verbatim, so a stable value is all these fixtures need.
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
let nextProposalId = 0;

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: overrides.id ?? `test-proposal-${nextProposalId++}`,
    type: 'skill',
    summary: 'Test proposal',
    content: '---\nname: test-skill\ndescription: A test skill\n---\n\nDo the thing.',
    sourceEntryIds: ['entry-1'],
    createdAt: FIXED_CREATED_AT,
    status: 'pending',
    ...overrides,
  };
}

describe('proposals', () => {
  describe('rejectProposal', () => {
    it('sets the proposal status to rejected and records reason', async () => {
      const storage = createMockKeyValueStore();
      const proposal = makeProposal({ id: 'reject-me' });
      await saveProposal(storage, proposal);

      const result = await rejectProposal(storage, 'reject-me', 'Low quality');

      expect(result.rejected).toBe(true);

      const updated = await getProposal(storage, 'reject-me');
      expect(updated?.status).toBe('rejected');
      expect(updated?.rejectionReason).toBe('Low quality');
    });

    it('hashes content and stores in rejected patterns', async () => {
      const storage = createMockKeyValueStore();
      const proposal = makeProposal({ id: 'reject-hash', content: 'unique-content-to-reject' });
      await saveProposal(storage, proposal);

      await rejectProposal(storage, 'reject-hash', 'Not useful');

      const isRejected = await isRejectedPattern(storage, 'unique-content-to-reject');
      expect(isRejected).toBe(true);
    });

    it('recovers from malformed rejected-pattern storage when recording a new rejection', async () => {
      const storage = createMockKeyValueStore();
      const proposal = makeProposal({ id: 'reject-with-bad-patterns', content: 'new-rejection' });
      await saveProposal(storage, proposal);
      await storage.set('proposal:rejected-patterns', '{not valid json');

      const result = await rejectProposal(storage, 'reject-with-bad-patterns');

      expect(result.rejected).toBe(true);
      expect(await isRejectedPattern(storage, 'new-rejection')).toBe(true);
    });

    it('returns an error for a non-existent proposal', async () => {
      const storage = createMockKeyValueStore();

      const result = await rejectProposal(storage, 'does-not-exist');

      expect(result.rejected).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('isRejectedPattern', () => {
    it('returns true for previously rejected content', async () => {
      const storage = createMockKeyValueStore();
      const proposal = makeProposal({ id: 'r1', content: 'content-to-reject' });
      await saveProposal(storage, proposal);
      await rejectProposal(storage, 'r1');

      const result = await isRejectedPattern(storage, 'content-to-reject');
      expect(result).toBe(true);
    });

    it('returns false for new content', async () => {
      const storage = createMockKeyValueStore();

      const result = await isRejectedPattern(storage, 'brand-new-content');
      expect(result).toBe(false);
    });
  });

  describe('clearProposals', () => {
    it('removes proposals matching the given status', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'accepted' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'rejected' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'pending' }));

      const removed = await clearProposals(storage, { status: 'accepted' });

      expect(removed).toBe(1);
      expect(await getProposal(storage, 'p1')).toBeUndefined();
      expect(await getProposal(storage, 'p2')).toBeDefined();
      expect(await getProposal(storage, 'p3')).toBeDefined();
    });

    it('preserves pending proposals when no status filter is given', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'accepted' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'rejected' }));

      const removed = await clearProposals(storage);

      expect(removed).toBe(2);
      expect(await getProposal(storage, 'p1')).toBeDefined();
      expect(await getProposal(storage, 'p2')).toBeUndefined();
      expect(await getProposal(storage, 'p3')).toBeUndefined();
    });

    it('removes old proposals when olderThanMs is specified', async () => {
      const storage = createMockKeyValueStore();
      const runtime = createManualRuntimeServices({ origin: '2026-02-08T00:00:00.000Z' });

      const oldDate = new Date(runtime.clock.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date(runtime.clock.now()).toISOString();

      await saveProposal(
        storage,
        makeProposal({ id: 'old', status: 'accepted', createdAt: oldDate }),
      );
      await saveProposal(
        storage,
        makeProposal({ id: 'recent', status: 'accepted', createdAt: recentDate }),
      );

      const removed = await clearProposals(storage, {
        status: 'accepted',
        olderThanMs: 24 * 60 * 60 * 1000,
        runtime,
      });

      expect(removed).toBe(1);
      expect(await getProposal(storage, 'old')).toBeUndefined();
      expect(await getProposal(storage, 'recent')).toBeDefined();
    });

    it("uses the injected runtime's clock rather than the real clock for age comparisons", async () => {
      const storage = createMockKeyValueStore();
      const runtime = createManualRuntimeServices({ origin: '2026-01-10T00:00:00.000Z' });

      const oldDate = '2026-01-01T00:00:00.000Z';
      const recentDate = '2026-01-09T12:00:00.000Z';

      await saveProposal(
        storage,
        makeProposal({ id: 'old', status: 'accepted', createdAt: oldDate }),
      );
      await saveProposal(
        storage,
        makeProposal({ id: 'recent', status: 'accepted', createdAt: recentDate }),
      );

      // Relative to the manual runtime's pinned origin (2026-01-10), "old" is
      // more than 24h stale and "recent" is not — a real clock (2026-09-04)
      // would treat both as ancient and remove both.
      const removed = await clearProposals(storage, {
        status: 'accepted',
        olderThanMs: 24 * 60 * 60 * 1000,
        runtime,
      });

      expect(removed).toBe(1);
      expect(await getProposal(storage, 'old')).toBeUndefined();
      expect(await getProposal(storage, 'recent')).toBeDefined();
    });
  });
});

describe('isRejectedPattern', () => {
  it('returns true for previously rejected content', async () => {
    const storage = createMockKeyValueStore();
    const proposal = makeProposal({ id: 'r1', content: 'content-to-reject' });
    await saveProposal(storage, proposal);
    await rejectProposal(storage, 'r1');

    const result = await isRejectedPattern(storage, 'content-to-reject');
    expect(result).toBe(true);
  });

  it('returns false for new content', async () => {
    const storage = createMockKeyValueStore();

    const result = await isRejectedPattern(storage, 'brand-new-content');
    expect(result).toBe(false);
  });
});

describe('clearProposals', () => {
  it('removes proposals matching the given status', async () => {
    const storage = createMockKeyValueStore();

    await saveProposal(storage, makeProposal({ id: 'p1', status: 'accepted' }));
    await saveProposal(storage, makeProposal({ id: 'p2', status: 'rejected' }));
    await saveProposal(storage, makeProposal({ id: 'p3', status: 'pending' }));

    const removed = await clearProposals(storage, { status: 'accepted' });

    expect(removed).toBe(1);
    expect(await getProposal(storage, 'p1')).toBeUndefined();
    expect(await getProposal(storage, 'p2')).toBeDefined();
    expect(await getProposal(storage, 'p3')).toBeDefined();
  });

  it('preserves pending proposals when no status filter is given', async () => {
    const storage = createMockKeyValueStore();

    await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
    await saveProposal(storage, makeProposal({ id: 'p2', status: 'accepted' }));
    await saveProposal(storage, makeProposal({ id: 'p3', status: 'rejected' }));

    const removed = await clearProposals(storage);

    expect(removed).toBe(2);
    expect(await getProposal(storage, 'p1')).toBeDefined();
    expect(await getProposal(storage, 'p2')).toBeUndefined();
    expect(await getProposal(storage, 'p3')).toBeUndefined();
  });

  it('removes old proposals when olderThanMs is specified', async () => {
    const storage = createMockKeyValueStore();
    const runtime = createManualRuntimeServices({ origin: '2026-02-08T00:00:00.000Z' });

    const oldDate = new Date(runtime.clock.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(runtime.clock.now()).toISOString();

    await saveProposal(
      storage,
      makeProposal({ id: 'old', status: 'accepted', createdAt: oldDate }),
    );
    await saveProposal(
      storage,
      makeProposal({ id: 'recent', status: 'accepted', createdAt: recentDate }),
    );

    const removed = await clearProposals(storage, {
      status: 'accepted',
      olderThanMs: 24 * 60 * 60 * 1000,
      runtime,
    });

    expect(removed).toBe(1);
    expect(await getProposal(storage, 'old')).toBeUndefined();
    expect(await getProposal(storage, 'recent')).toBeDefined();
  });

  it("uses the injected runtime's clock rather than the real clock for age comparisons", async () => {
    const storage = createMockKeyValueStore();
    const runtime = createManualRuntimeServices({ origin: '2026-01-10T00:00:00.000Z' });

    const oldDate = '2026-01-01T00:00:00.000Z';
    const recentDate = '2026-01-09T12:00:00.000Z';

    await saveProposal(
      storage,
      makeProposal({ id: 'old', status: 'accepted', createdAt: oldDate }),
    );
    await saveProposal(
      storage,
      makeProposal({ id: 'recent', status: 'accepted', createdAt: recentDate }),
    );

    // Relative to the manual runtime's pinned origin (2026-01-10), "old" is
    // more than 24h stale and "recent" is not — a real clock (2026-09-04)
    // would treat both as ancient and remove both.
    const removed = await clearProposals(storage, {
      status: 'accepted',
      olderThanMs: 24 * 60 * 60 * 1000,
      runtime,
    });

    expect(removed).toBe(1);
    expect(await getProposal(storage, 'old')).toBeUndefined();
    expect(await getProposal(storage, 'recent')).toBeDefined();
  });
});
