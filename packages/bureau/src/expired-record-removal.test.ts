/**
 * COR-2009 — `removeExpiredRecords` removes every record past its retention window and says how
 * many of each kind went, and `expiredRecords: 'on-request'` keeps the maintenance passes from
 * removing them, so a host can clean up once a night. Every test moves the manual clock; none waits
 * on wall time.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { DAY_MS, withLiveSettingsBureau } from './testing/live-settings-bureau.test-support';

const OWNER = 'api-key:alice';

const WINDOWS = {
  audit: { olderThan: 7 * DAY_MS },
  notifications: { olderThan: 7 * DAY_MS },
} as const;

describe('removeExpiredRecords', () => {
  it('leaves expired records to the request under on-request, and counts what it removes', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at }) => {
        const trail = bureau.internals.auditTrail!;
        await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'old' });
        // A schedule is no run the fleet feed retains, so only the window decides.
        await trail.record({ runId: 'schedule:old', type: 'schedule.note', detail: {} });
        at(5 * DAY_MS);
        await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'recent' });
        await trail.record({ runId: 'schedule:recent', type: 'schedule.note', detail: {} });

        at(8 * DAY_MS);
        await bureau.maintain();
        expect(
          await bureau.notifications.list({ owner: OWNER }).then((value) => value.notifications),
        ).toHaveLength(2);
        expect(await trail.query({ type: 'schedule.note' })).toHaveLength(2);

        const removal = await bureau.removeExpiredRecords();

        expect(removal).toEqual({
          removed: 2,
          byKind: {
            audit: 1,
            reviews: 0,
            memories: 0,
            logs: 0,
            notifications: 1,
            hookDeliveries: 0,
          },
          failed: [],
        });
        const titles = await bureau.notifications
          .list({ owner: OWNER })
          .then((value) => value.notifications.map((notification) => notification.title));
        expect(titles).toEqual(['recent']);
        const notes = await trail.query({ type: 'schedule.note' });
        expect(notes.map((record) => record.runId)).toEqual(['schedule:recent']);

        // Nothing left past its window: a second request removes nothing.
        const again = await bureau.removeExpiredRecords();
        expect(again.removed).toBe(0);
      },
      { expiredRecords: 'on-request', retention: WINDOWS },
    );
  });

  it('removes what the next pass would under the default, which still removes them itself', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at }) => {
        await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'first' });
        at(8 * DAY_MS);
        const removal = await bureau.removeExpiredRecords();
        expect(removal.byKind.notifications).toBe(1);

        await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'second' });
        at(16 * DAY_MS);
        await bureau.maintain();
        expect(
          await bureau.notifications.list({ owner: OWNER }).then((value) => value.notifications),
        ).toEqual([]);
      },
      { retention: WINDOWS },
    );
  });

  it('refuses once shutdown has begun', async () => {
    let removal: Promise<unknown> | undefined;
    await withLiveSettingsBureau(async ({ bureau }) => {
      await bureau.shutdown();
      removal = bureau.removeExpiredRecords();
    });

    const refusal = await rejectionOf(removal!);
    expect(refusal).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses an expiredRecords value that is neither choice', async () => {
    const refusal = await rejectionOf(
      createBureau({ agents: {}, expiredRecords: 'nightly' as never }),
    );

    expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
    expect((refusal as Error).message).toContain('expiredRecords');
  });
});
