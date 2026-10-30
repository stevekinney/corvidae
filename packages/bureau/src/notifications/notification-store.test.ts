/**
 * COR-1941 — the notification store: what it keeps per owner, how a dedupe key makes a write
 * idempotent, how a list filters and pages, and that no read or change crosses an owner.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { createNotificationStore, NOTIFICATION_KEY_PREFIX } from './notification-store';
import { type NotificationInput, NotificationPageTokenError } from './notification-types';

const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

/** A store over memory with a clock that moves one second per read, so order is deterministic. */
function open(options: { limitPerOwner?: number } = {}) {
  const storage = new MemoryStorage();
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  let tick = 0;
  let counter = 0;
  const diagnostics: string[] = [];
  const store = createNotificationStore({
    kv,
    clock: { nowISO: () => new Date(Date.UTC(2026, 9, 30, 12, 0, tick++)).toISOString() },
    identifiers: { next: (kind) => `${kind}-${++counter}` },
    diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
    refusal: (message) => new Error(message),
    ...options,
  });
  return { store, kv, diagnostics };
}

const input = (owner: string, title: string, extra: Record<string, unknown> = {}) => ({
  owner,
  kind: 'run.failed',
  title,
  ...extra,
});

describe('create', () => {
  it('stores an unread notification for its owner and reads it back', async () => {
    const { store } = open();
    const { notification, created } = await store.create(
      input(ALICE, 'It failed', {
        body: 'boom',
        link: '/chat/s1',
        subject: { runId: 'r1', agentName: 'default' },
      }),
    );

    expect(created).toBe(true);
    expect(notification).toMatchObject({
      kind: 'run.failed',
      title: 'It failed',
      body: 'boom',
      link: '/chat/s1',
      subject: { runId: 'r1', agentName: 'default' },
      readAt: null,
      dismissedAt: null,
    });
    const page = await store.list({ owner: ALICE });
    expect(page.notifications).toEqual([notification]);
    expect(await store.list({ owner: BOB }).then((value) => value.notifications)).toEqual([]);
  });

  it('is idempotent per owner for a dedupe key, even after the first was read or dismissed', async () => {
    const { store } = open();
    const first = await store.create(input(ALICE, 'First', { dedupeKey: 'run.settled:r1' }));
    await store.dismiss({ owner: ALICE, ids: [first.notification.id] });

    const again = await store.create(input(ALICE, 'Second', { dedupeKey: 'run.settled:r1' }));
    const other = await store.create(input(BOB, 'Bob’s', { dedupeKey: 'run.settled:r1' }));

    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(first.notification.id);
    expect(again.notification.title).toBe('First');
    expect(other.created).toBe(true);
    const all = await store.list({ owner: ALICE, includeDismissed: true });
    expect(all.notifications).toHaveLength(1);
  });

  it('writes one record when the same dedupe key is created concurrently', async () => {
    const { store } = open();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.create(input(ALICE, 'Once', { dedupeKey: 'k' }))),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.notification.id)).size).toBe(1);
    expect(await store.list({ owner: ALICE }).then((value) => value.notifications)).toHaveLength(1);
  });

  it.each([
    ['an empty owner', { owner: '' }],
    ['an uppercase kind', { kind: 'Run.Failed' }],
    ['an empty title', { title: '' }],
    ['a too long title', { title: 'x'.repeat(201) }],
    ['a script link', { link: 'javascript:alert(1)' }],
    ['a protocol-relative link', { link: '//evil.example/x' }],
    ['an unknown subject key', { subject: { owner: 'bob' } }],
    ['an empty dedupe key', { dedupeKey: '' }],
  ])('refuses %s', async (_name, change) => {
    const { store } = open();

    const refusal = await rejectionOf(
      store.create({ ...input(ALICE, 'ok'), ...change } as NotificationInput),
    );

    expect((refusal as Error).message).toContain('Cannot create the notification');
    expect(await store.list({ owner: ALICE }).then((value) => value.notifications)).toEqual([]);
  });

  it('accepts an http link and an application path', async () => {
    const { store } = open();

    await store.create(input(ALICE, 'a', { link: 'https://example.com/x?y=1' }));
    await store.create(input(ALICE, 'b', { link: '/reviews' }));

    expect(await store.list({ owner: ALICE }).then((value) => value.notifications)).toHaveLength(2);
  });

  it('keeps the newest notifications of an owner past the cap, and leaves other owners alone', async () => {
    const { store } = open({ limitPerOwner: 3 });
    await store.create(input(BOB, 'bob'));
    for (let index = 1; index <= 5; index += 1) {
      await store.create(input(ALICE, `n${index}`, { dedupeKey: `k${index}` }));
    }

    const titles = await store
      .list({ owner: ALICE })
      .then((value) => value.notifications.map((n) => n.title));
    expect(titles).toEqual(['n5', 'n4', 'n3']);
    expect(await store.list({ owner: BOB }).then((value) => value.notifications)).toHaveLength(1);
    // The evicted ones left their dedupe keys with them.
    expect(
      await store.create(input(ALICE, 'again', { dedupeKey: 'k1' })).then((value) => value.created),
    ).toBe(true);
  });
});

describe('list', () => {
  async function seeded() {
    const opened = open();
    const { store } = opened;
    const ids: string[] = [];
    for (const [index, kind] of [
      'run.failed',
      'review.waiting',
      'run.failed',
      'hook.note',
    ].entries()) {
      const { notification } = await store.create({ owner: ALICE, kind, title: `n${index}` });
      ids.push(notification.id);
    }
    return { ...opened, ids };
  }

  it('lists newest first', async () => {
    const { store } = await seeded();

    const titles = await store
      .list({ owner: ALICE })
      .then((value) => value.notifications.map((n) => n.title));

    expect(titles).toEqual(['n3', 'n2', 'n1', 'n0']);
  });

  it('filters by kind, unread and dismissed', async () => {
    const { store, ids } = await seeded();
    await store.markRead({ owner: ALICE, ids: [ids[2]!] });
    await store.dismiss({ owner: ALICE, ids: [ids[3]!] });

    const failed = await store.list({ owner: ALICE, kind: 'run.failed' });
    const unreadFailed = await store.list({ owner: ALICE, kind: 'run.failed', unread: true });
    const withDismissed = await store.list({ owner: ALICE, includeDismissed: true });

    expect(failed.notifications.map((n) => n.title)).toEqual(['n2', 'n0']);
    expect(unreadFailed.notifications.map((n) => n.title)).toEqual(['n0']);
    expect(withDismissed.notifications.map((n) => n.title)).toEqual(['n3', 'n2', 'n1', 'n0']);
  });

  it('pages by token without repeating or skipping, across a change between pages', async () => {
    const { store } = await seeded();

    const first = await store.list({ owner: ALICE, limit: 3 });
    expect(first.notifications.map((n) => n.title)).toEqual(['n3', 'n2', 'n1']);
    expect(first.nextPageToken).not.toBeNull();
    // A newer notification arrives while the reader holds a token: the next page is unaffected.
    await store.create(input(ALICE, 'newer'));
    const second = await store.list({ owner: ALICE, limit: 3, pageToken: first.nextPageToken! });

    expect(second.notifications.map((n) => n.title)).toEqual(['n0']);
    expect(second.nextPageToken).toBeNull();
  });

  it('refuses a token for another owner, another filter, or no token at all', async () => {
    const { store } = await seeded();
    await store.create(input(BOB, 'bob'));
    const token = await store
      .list({ owner: ALICE, limit: 1 })
      .then((value) => value.nextPageToken!);

    const refusals = [
      store.list({ owner: BOB, limit: 1, pageToken: token }),
      store.list({ owner: ALICE, unread: true, limit: 1, pageToken: token }),
      store.list({ owner: ALICE, pageToken: 'not a token' }),
    ];

    const reasons = await Promise.allSettled(refusals).then((value) =>
      value.map((result) =>
        result.status === 'rejected' && result.reason instanceof NotificationPageTokenError
          ? result.reason.reason
          : 'accepted',
      ),
    );
    expect(reasons).toEqual(['mismatch', 'mismatch', 'malformed']);
  });

  it('skips a record it cannot read and says so', async () => {
    const { store, kv, diagnostics } = await seeded();
    const [key] = await kv.list(`${NOTIFICATION_KEY_PREFIX}r:`);
    await kv.set(key!, '{"schemaVersion":2}');

    const page = await store.list({ owner: ALICE });

    expect(page.notifications).toHaveLength(3);
    expect(diagnostics.join('\n')).toContain('is not a version 1 record');
  });
});

describe('markRead and dismiss', () => {
  it('change only the caller’s own, and count only what changed', async () => {
    const { store } = open();
    const mine = await store.create(input(ALICE, 'mine')).then((value) => value.notification);
    const theirs = await store.create(input(BOB, 'theirs')).then((value) => value.notification);

    const crossed = await store.markRead({ owner: ALICE, ids: [theirs.id, 'unknown'] });
    const read = await store.markRead({ owner: ALICE, ids: [mine.id, mine.id] });
    const readAgain = await store.markRead({ owner: ALICE, ids: [mine.id] });

    expect([crossed, read, readAgain]).toEqual([0, 1, 0]);
    expect(
      await store.list({ owner: BOB }).then((value) => value.notifications[0]!.readAt),
    ).toBeNull();
    expect(
      await store.list({ owner: ALICE }).then((value) => value.notifications[0]!.readAt),
    ).not.toBeNull();
  });

  it('dismiss reads, hides from the default list, and keeps an earlier read time', async () => {
    const { store } = open();
    const { notification } = await store.create(input(ALICE, 'n'));
    await store.markRead({ owner: ALICE, ids: [notification.id] });
    const [readOnly] = await store.list({ owner: ALICE }).then((value) => value.notifications);

    const changed = await store.dismiss({ owner: ALICE, ids: [notification.id] });
    const again = await store.dismiss({ owner: ALICE, ids: [notification.id] });

    expect([changed, again]).toEqual([1, 0]);
    expect(await store.list({ owner: ALICE }).then((value) => value.notifications)).toEqual([]);
    const [dismissed] = await store
      .list({ owner: ALICE, includeDismissed: true })
      .then((value) => value.notifications);
    expect(dismissed!.readAt).toBe(readOnly!.readAt);
    expect(dismissed!.dismissedAt).not.toBeNull();
  });

  it('all acts on every notification the caller has, and on no one else’s', async () => {
    const { store } = open();
    for (const title of ['a', 'b', 'c']) await store.create(input(ALICE, title));
    await store.create(input(BOB, 'bob'));

    const marked = await store.markRead({ owner: ALICE, all: true });
    const dismissed = await store.dismiss({ owner: ALICE, all: true });

    expect([marked, dismissed]).toEqual([3, 3]);
    expect(
      await store.list({ owner: BOB, unread: true }).then((value) => value.notifications),
    ).toHaveLength(1);
  });

  it('dismissByDedupeKey dismisses the matching notification of every owner', async () => {
    const { store } = open();
    await store.create(input(ALICE, 'a', { dedupeKey: 'review.waiting:x' }));
    await store.create(input(BOB, 'b', { dedupeKey: 'review.waiting:x' }));
    await store.create(input(ALICE, 'c', { dedupeKey: 'review.waiting:y' }));

    const changed = await store.dismissByDedupeKey('review.waiting:x');

    expect(changed).toBe(2);
    expect(
      await store.list({ owner: ALICE }).then((value) => value.notifications.map((n) => n.title)),
    ).toEqual(['c']);
    expect(await store.list({ owner: BOB }).then((value) => value.notifications)).toEqual([]);
    expect(await store.dismissByDedupeKey('review.waiting:x')).toBe(0);
  });
});

describe('prune', () => {
  it('removes what was written before the cutoff, with its dedupe key, whatever its state', async () => {
    const { store } = open();
    const old = await store
      .create(input(ALICE, 'old', { dedupeKey: 'k' }))
      .then((value) => value.notification);
    await store.markRead({ owner: ALICE, ids: [old.id] });
    await store.create(input(ALICE, 'kept'));
    const cutoff = Date.parse(old.createdAt) + 1;

    const removed = await store.prune(cutoff);

    expect(removed).toBe(1);
    expect(
      await store.list({ owner: ALICE }).then((value) => value.notifications.map((n) => n.title)),
    ).toEqual(['kept']);
    expect(
      await store.create(input(ALICE, 'again', { dedupeKey: 'k' })).then((value) => value.created),
    ).toBe(true);
  });
});

describe('persistence', () => {
  it('a second store over the same storage lists what the first wrote', async () => {
    const storage = new MemoryStorage();
    const make = () =>
      createNotificationStore({
        kv: textValueStore(storage, { disposeUnderlyingStorage: false }),
        clock: { nowISO: () => new Date().toISOString() },
        identifiers: { next: (kind) => `${kind}-${crypto.randomUUID()}` },
        diagnose: () => undefined,
        refusal: (message) => new Error(message),
      });
    const written = await make().create(input(ALICE, 'survives', { dedupeKey: 'k' }));

    const restarted = make();

    expect(await restarted.list({ owner: ALICE }).then((value) => value.notifications)).toEqual([
      written.notification,
    ]);
    expect(
      await restarted
        .create(input(ALICE, 'dup', { dedupeKey: 'k' }))
        .then((value) => value.created),
    ).toBe(false);
  });
});

type StoredRecord = Record<string, unknown> & {
  subject: object;
  readAt: string | null;
  dismissedAt: string | null;
};

/** The record key of the only record stored, and its parsed JSON. */
async function onlyRecord(kv: ReturnType<typeof open>['kv']) {
  const keys = await kv.list(`${NOTIFICATION_KEY_PREFIX}r:`);
  expect(keys).toHaveLength(1);
  const key = keys[0]!;
  return { key, value: JSON.parse((await kv.get(key))!) as StoredRecord };
}

describe('a record a newer release wrote', () => {
  const review = {
    owner: ALICE,
    kind: 'review.waiting',
    title: 'Needs you',
    dedupeKey: 'review.waiting:R1',
  };

  /** Writes a record, then gives its subject and its top level a key this release does not know. */
  async function withNewerKeys() {
    const opened = open();
    const first = await opened.store.create({ ...review, subject: { reviewId: 'R1' } });
    const { key, value } = await onlyRecord(opened.kv);
    await opened.kv.set(
      key,
      JSON.stringify({
        ...value,
        urgency: 'high',
        subject: { ...value.subject, toolName: 'deploy' },
      }),
    );
    return { ...opened, first };
  }

  it('is found by a replay under its dedupe key, which writes nothing beside it', async () => {
    const { store, kv, first, diagnostics } = await withNewerKeys();

    const replay = await store.create({ ...review, subject: { reviewId: 'R1' } });

    expect(replay.created).toBe(false);
    expect(replay.notification.id).toBe(first.notification.id);
    expect(await kv.list(`${NOTIFICATION_KEY_PREFIX}r:`)).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it('is listed with the keys this release knows, and none of the newer ones', async () => {
    const { store, first } = await withNewerKeys();

    const page = await store.list({ owner: ALICE });

    expect(page.notifications).toEqual([first.notification]);
    expect(page.notifications[0]?.subject).toEqual({ reviewId: 'R1' });
  });

  it('keeps the newer keys when it is marked read, and when it is dismissed', async () => {
    const { store, kv, first } = await withNewerKeys();

    expect(await store.markRead({ owner: ALICE, ids: [first.notification.id] })).toBe(1);
    const read = await onlyRecord(kv);
    expect(read.value).toMatchObject({ urgency: 'high', subject: { toolName: 'deploy' } });
    expect(read.value.readAt).not.toBeNull();

    expect(await store.dismissByDedupeKey('review.waiting:R1')).toBe(1);
    const dismissed = await onlyRecord(kv);
    expect(dismissed.value).toMatchObject({ urgency: 'high', subject: { toolName: 'deploy' } });
    expect(dismissed.value.dismissedAt).not.toBeNull();
  });

  it('is removed by retention with its dedupe key, so the event is written again afterwards', async () => {
    const { store, kv } = await withNewerKeys();

    expect(await store.prune(Date.now() + 60_000)).toBe(1);

    expect(await kv.list(NOTIFICATION_KEY_PREFIX)).toEqual([]);
    expect(await store.create({ ...review }).then((value) => value.created)).toBe(true);
  });
});

describe('a record this release cannot parse', () => {
  /** Replaces the only record with one whose `kind` is not a string, keeping the rest. */
  async function unreadable() {
    const opened = open();
    await opened.store.create(input(ALICE, 'Old', { dedupeKey: 'k' }));
    const { key, value } = await onlyRecord(opened.kv);
    await opened.kv.set(key, JSON.stringify({ ...value, kind: 42 }));
    return opened;
  }

  it('is skipped by a list with a diagnostic, and a replay does not write beside it', async () => {
    const { store, kv, diagnostics } = await unreadable();

    expect(await store.list({ owner: ALICE }).then((value) => value.notifications)).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    const keysBefore = await kv.list(NOTIFICATION_KEY_PREFIX);

    const error = await rejectionOf(store.create(input(ALICE, 'Again', { dedupeKey: 'k' })));

    expect(String(error)).toContain('cannot read it');
    expect(await kv.list(NOTIFICATION_KEY_PREFIX)).toEqual(keysBefore);
  });

  it('is still removed by retention, with its dedupe key', async () => {
    const { store, kv } = await unreadable();

    expect(await store.prune(Date.now() + 60_000)).toBe(1);

    expect(await kv.list(NOTIFICATION_KEY_PREFIX)).toEqual([]);
  });

  it('still counts toward the cap, and is the oldest to go', async () => {
    const opened = open({ limitPerOwner: 2 });
    await opened.store.create(input(ALICE, 'Old'));
    const { key, value } = await onlyRecord(opened.kv);
    await opened.kv.set(key, JSON.stringify({ ...value, kind: 42 }));

    await opened.store.create(input(ALICE, 'Two'));
    await opened.store.create(input(ALICE, 'Three'));

    expect(await opened.kv.list(`${NOTIFICATION_KEY_PREFIX}r:`)).not.toContain(key);
    expect(
      await opened.store
        .list({ owner: ALICE })
        .then((page) => page.notifications.map((n) => n.title)),
    ).toEqual(['Three', 'Two']);
  });
});

describe('retention racing a create under the same dedupe key', () => {
  it('does not take away the index of the replacement the create wrote', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    let counter = 0;
    let between: (() => Promise<void>) | undefined;
    const store = createNotificationStore({
      // The create runs right after retention deleted the record and before it deletes the index.
      kv: new Proxy(kv, {
        get(target, property, receiver) {
          if (property !== 'delete') return Reflect.get(target, property, receiver);
          return async (key: string) => {
            await target.delete(key);
            const run = between;
            between = undefined;
            await run?.();
          };
        },
      }),
      clock: { nowISO: () => new Date(Date.UTC(2026, 9, 30, 12, 0, counter)).toISOString() },
      identifiers: { next: (kind) => `${kind}-${++counter}` },
      diagnose: () => undefined,
      refusal: (message) => new Error(message),
    });
    await store.create(input(ALICE, 'Old', { dedupeKey: 'k' }));
    let replacementId = '';
    between = async () => {
      const replacement = await store.create(input(ALICE, 'New', { dedupeKey: 'k' }));
      expect(replacement.created).toBe(true);
      replacementId = replacement.notification.id;
    };

    expect(await store.prune(Date.now() + 60_000)).toBe(1);

    const indexKeys = await kv.list(`${NOTIFICATION_KEY_PREFIX}d:`);
    const indexKey = indexKeys[0]!;
    expect(await kv.get(indexKey)).toBe(replacementId);
    expect(
      await store.create(input(ALICE, 'Again', { dedupeKey: 'k' })).then((value) => value.created),
    ).toBe(false);
  });
});
