/**
 * `bureau.audit.query` reads the trail from either end and can say how long it is (COR-2018, the
 * Health overview's Recent activity and its "Open audit log (N events)" link). The trail here is a
 * fake that answers the way the real one does: records oldest first within a chunk, `select:
 * 'newest'` picking the newest records, `after` and `before` positions, and a `limit`.
 */
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import type { AuditQueryOptions, AuditRecord, AuditTrail } from '../audit-trail.ts';
import { createAudit } from './create-audit.ts';

/** A record at `second` seconds past the epoch, about `runId`, acted by `principal`. */
function record(second: number, runId = 'run-a', principal?: string): AuditRecord {
  return {
    timestamp: new Date(second * 1000).toISOString(),
    timestampMs: second * 1000,
    sequence: second,
    runId,
    type: 'run.started',
    detail: null,
    ...(principal === undefined ? {} : { principal }),
  };
}

/** A trail holding `records`, answering `query` with the options the real one honours. */
function trailOf(records: readonly AuditRecord[]): Pick<AuditTrail, 'query'> {
  return {
    async query(options: AuditQueryOptions = {}): Promise<AuditRecord[]> {
      const { since, runId, type, after, before, select = 'oldest', limit = 500 } = options;
      const matches = records
        .filter((entry) => since === undefined || entry.timestampMs >= since)
        .filter((entry) => runId === undefined || entry.runId === runId)
        .filter((entry) => type === undefined || entry.type === type)
        .filter((entry) => after === undefined || entry.timestampMs > after.timestampMs)
        .filter((entry) => before === undefined || entry.timestampMs < before.timestampMs)
        .toSorted((left, right) => left.timestampMs - right.timestampMs);
      return select === 'newest' ? matches.slice(-limit) : matches.slice(0, limit);
    },
  };
}

function auditOf(records: readonly AuditRecord[], owners: Record<string, string> = {}) {
  return createAudit({
    trail: () => trailOf(records),
    ownerOf: async (entry) => owners[entry.runId],
    refusal: (message) => new Error(message),
  });
}

const seconds = (page: { records: readonly { timestamp: string }[] }): number[] =>
  page.records.map((entry) => Date.parse(entry.timestamp) / 1000);

describe('bureau.audit.query order', () => {
  const trail = Array.from({ length: 10 }, (_, index) => record(index + 1));

  it('reads oldest first by default', async () => {
    const page = await auditOf(trail).query({ limit: 3 });
    expect(seconds(page)).toEqual([1, 2, 3]);
    expect(page.nextCursor).not.toBeNull();
    expect('total' in page).toBe(false);
  });

  it('reads the newest records first and continues into older ones', async () => {
    const audit = auditOf(trail);
    const first = await audit.query({ order: 'newest', limit: 4 });
    expect(seconds(first)).toEqual([10, 9, 8, 7]);
    const second = await audit.query({
      order: 'newest',
      limit: 4,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(seconds(second)).toEqual([6, 5, 4, 3]);
    const last = await audit.query({
      order: 'newest',
      limit: 4,
      ...(second.nextCursor === null ? {} : { cursor: second.nextCursor }),
    });
    expect(seconds(last)).toEqual([2, 1]);
    expect(last.nextCursor).toBeNull();
  });

  it('starts a newest-first read at `until`', async () => {
    const page = await auditOf(trail).query({ order: 'newest', until: 6000, limit: 3 });
    expect(seconds(page)).toEqual([6, 5, 4]);
  });

  it('refuses an order it does not know', async () => {
    const audit = auditOf(trail);
    // The wire's schema keeps this out; an in-process caller is refused here.
    const refusal = await throwingRejectionOf(
      audit.query({ order: 'sideways' as unknown as 'oldest' }),
    );
    expect(refusal).toThrow('order must be oldest or newest');
  });
});

describe('bureau.audit.query total', () => {
  it('counts every record the filter matches, however many pages there are', async () => {
    const trail = Array.from({ length: 450 }, (_, index) => record(index + 1));
    const page = await auditOf(trail).query({ limit: 5, includeTotal: true });
    expect(page.total).toBe(450);
    expect(page.records).toHaveLength(5);
  });

  it('counts only what the reader may see, and honours the actor and the time range', async () => {
    const trail = [
      record(1, 'run-mine', 'anonymous:local'),
      record(2, 'run-theirs', 'anonymous:local'),
      record(3, 'run-mine', 'system:host'),
      record(4, 'run-mine', 'anonymous:local'),
    ];
    const audit = auditOf(trail, { 'run-mine': 'anonymous:local', 'run-theirs': 'api-key:other' });
    const asOwner = await audit.query({ includeTotal: true }, { owner: 'anonymous:local' });
    expect(asOwner.total).toBe(3);
    const byActor = await audit.query(
      { includeTotal: true, principal: 'anonymous:local' },
      { owner: 'anonymous:local' },
    );
    expect(byActor.total).toBe(2);
    const bounded = await audit.query({ includeTotal: true, until: 3000 });
    expect(bounded.total).toBe(3);
  });
});
