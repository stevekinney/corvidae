/**
 * COR-1941 — `retention.notifications` is read by the next maintenance pass, whether the
 * notification was read or not; with it unset, nothing is removed by age. Every test moves the
 * manual clock; none waits on wall time.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau';
import { DAY_MS, withLiveSettingsBureau } from '../testing/live-settings-bureau.test-support';

const OWNER = 'api-key:alice';

describe('retention.notifications', () => {
  it('removes notifications older than its window on the next pass, and only those', async () => {
    await withLiveSettingsBureau(
      async ({ bureau, at, change }) => {
        const old = await bureau.notifications.create({
          owner: OWNER,
          kind: 'hook.note',
          title: 'old',
        });
        await bureau.notifications.markRead({ owner: OWNER, ids: [old.notification.id] });
        at(5 * DAY_MS);
        await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'recent' });

        at(6 * DAY_MS);
        await bureau.maintain();
        expect(
          await bureau.notifications.list({ owner: OWNER }).then((value) => value.notifications),
        ).toHaveLength(2);

        at(8 * DAY_MS);
        await bureau.maintain();
        const titles = await bureau.notifications
          .list({ owner: OWNER })
          .then((value) => value.notifications.map((notification) => notification.title));
        expect(titles).toEqual(['recent']);

        // A shorter window set at runtime applies to the next pass.
        await change({ 'retention.notifications': { olderThan: DAY_MS } });
        await bureau.maintain();
        expect(
          await bureau.notifications.list({ owner: OWNER }).then((value) => value.notifications),
        ).toEqual([]);
      },
      { retention: { notifications: { olderThan: 7 * DAY_MS } } },
    );
  });

  it('keeps notifications for good when no window is set', async () => {
    await withLiveSettingsBureau(async ({ bureau, at }) => {
      await bureau.notifications.create({ owner: OWNER, kind: 'hook.note', title: 'kept' });

      at(400 * DAY_MS);
      await bureau.maintain();

      expect(
        await bureau.notifications.list({ owner: OWNER }).then((value) => value.notifications),
      ).toHaveLength(1);
    });
  });

  it('refuses a window that is not a positive integer', async () => {
    const refusal = await rejectionOf(
      createBureau({ agents: {}, retention: { notifications: { olderThan: 0 } } }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('options.retention.notifications.olderThan');
  });
});
