/**
 * COR-1809 — `sweepRetention({ retention })` replaces the policy's rule for the classes it names,
 * for that sweep only. A host applies an operating retention window this way without activating a
 * policy revision, and the default 90-day episodic rule is back on the next sweep without one.
 */
import { describe, expect, it } from 'bun:test';

import {
  DAY,
  createGovernedFixture,
  principalA,
  recordIdOf,
  retentionService,
} from './governed-memory-harness';

async function writeNote(fixture: Awaited<ReturnType<typeof createGovernedFixture>>) {
  return recordIdOf(
    fixture.memory.write(principalA, 'The gate code is 4471.', {
      collection: 'notes',
      source: 'conversation',
    }),
  );
}

describe('sweepRetention with a retention override', () => {
  it('expires a record the policy would keep, only for that sweep', async () => {
    const fixture = await createGovernedFixture('in-memory');
    const recordId = await writeNote(fixture);
    await fixture.runtime.advance(8 * DAY);

    const kept = await fixture.memory.sweepRetention(retentionService);
    expect(kept.expired).toEqual([]);

    const preview = await fixture.memory.sweepRetention(retentionService, {
      dryRun: true,
      retention: { episodic: { kind: 'duration', milliseconds: 7 * DAY } },
    });
    expect(preview.expired.map((candidate) => candidate.id)).toEqual([recordId]);
    expect(preview.deletionIds).toEqual([]);

    const swept = await fixture.memory.sweepRetention(retentionService, {
      retention: { episodic: { kind: 'duration', milliseconds: 7 * DAY } },
    });
    expect(swept.status).toBe('applied');
    expect(swept.expired.map((candidate) => candidate.id)).toEqual([recordId]);
    expect(swept.deletionIds).toHaveLength(1);
    expect(
      await fixture.memory.get(principalA, { id: recordId, collection: 'notes' }),
    ).toBeUndefined();
  });

  it('rejects a rule the policy would refuse, before it reads a record', async () => {
    const fixture = await createGovernedFixture('in-memory');
    const recordId = await writeNote(fixture);
    await fixture.runtime.advance(91 * DAY);

    const rejected = await fixture.memory.sweepRetention(retentionService, {
      retention: { episodic: { kind: 'duration', milliseconds: 0 } },
    });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'invalid-retention' });
    expect(rejected.deletionIds).toEqual([]);
    expect(
      await fixture.memory.get(principalA, { id: recordId, collection: 'notes' }),
    ).toBeDefined();
  });
});
