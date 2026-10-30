/**
 * COR-1941 — the built-in notifications and `bureau.notifications.*` over a real Bureau and its
 * handler: a failed run, a run over budget and a review waiting each notify the run's owner and no
 * one else, a closed review's notification is dismissed, a restart keeps what was written, and the
 * operations read and change only the caller's own.
 */
import {
  BudgetExceededError,
  createAgent,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { projectBureauEvent, PUBLISHED_BUREAU_EVENT_KINDS } from '../../bureau-event-feed.ts';
import type { NotificationCreatedEvent } from '../../events.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { waitForTaskState } from '../../test';
import { bureauNotificationsOperations } from './notifications-operations.ts';
import {
  approvalToolbox,
  chargesOnce,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(options: Parameters<typeof openBureau>[0] = {}): Promise<OpenedBureau> {
  const opened = await openBureau(options);
  cleanups.push(() => opened.dispose());
  return opened;
}

const failing: GenerateFunction = async () => {
  throw new Error('provider unavailable\nsecond line of the stack');
};

const overBudget: GenerateFunction = async () => {
  throw new BudgetExceededError('token limit reached');
};

type Listed = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  readAt: string | null;
};

async function list(opened: OpenedBureau, key: string, params: object = {}) {
  const body = await rpc(opened.handler, 'bureau.notifications.list', params, key);
  return {
    body,
    notifications: (body.result?.['notifications'] ?? []) as Listed[],
    nextPageToken: (body.result?.['nextPageToken'] ?? null) as string | null,
  };
}

const ownList = (opened: OpenedBureau, owner: string) =>
  opened.bureau.notifications.list({ owner }).then((page) => page.notifications);

describe('the operations', () => {
  it('are served and mapped to the in-process members', () => {
    for (const operation of bureauNotificationsOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
    expect(bureauNotificationsOperations.map((operation) => operation.name)).toEqual([
      'bureau.notifications.list',
      'bureau.notifications.markread',
      'bureau.notifications.dismiss',
    ]);
  });
});

describe('a failed run', () => {
  it('notifies its owner once, with the first line of the error, and no other owner', async () => {
    const opened = await open({ generate: failing });

    const run = await opened.bureau.tasks.start('default', 'Go.', { principal: OWNER.alice });
    await waitForTaskState(opened.bureau, run.id);
    await waitUntil(
      async () => (await ownList(opened, OWNER.alice).then((value) => value.length)) === 1,
    );

    const alice = await list(opened, 'alice-key');
    expect(alice.notifications).toHaveLength(1);
    expect(alice.notifications[0]).toMatchObject({
      kind: 'run.failed',
      title: 'default failed',
      body: 'provider unavailable',
      readAt: null,
    });
    expect(await list(opened, 'bob-key').then((value) => value.notifications)).toEqual([]);
    expect(JSON.stringify(alice.body.result)).not.toContain('second line');
    expect(await ownList(opened, OWNER.alice)).toMatchObject([
      { subject: { runId: run.id, agentName: 'default' } },
    ]);
  });

  it('is a budget-exceeded notification instead when the run ran out of budget', async () => {
    const opened = await open({ generate: overBudget });

    const run = await opened.bureau.tasks.start('default', 'Go.', { principal: OWNER.alice });
    await waitForTaskState(opened.bureau, run.id);
    await waitUntil(
      async () => (await ownList(opened, OWNER.alice).then((value) => value.length)) === 1,
    );

    const [only] = await ownList(opened, OWNER.alice);
    expect(only).toMatchObject({
      kind: 'run.budget-exceeded',
      title: 'default exceeded its budget',
    });
  });

  it('is not written for a run that completes', async () => {
    const opened = await open({ generate: async () => ({ content: 'Done.', toolCalls: [] }) });

    const run = await opened.bureau.tasks.start('default', 'Go.', { principal: OWNER.alice });
    await waitForTaskState(opened.bureau, run.id);
    await opened.bureau.shutdown();

    expect(await ownList(opened, OWNER.alice)).toEqual([]);
  });

  it('survives a restart, and a recovered settlement does not write it twice', async () => {
    const storage = new MemoryStorage();
    const first = await openBureau({ generate: failing, storage });
    const run = await first.bureau.tasks.start('default', 'Go.', { principal: OWNER.alice });
    await waitForTaskState(first.bureau, run.id);
    await waitUntil(
      async () => (await ownList(first, OWNER.alice).then((value) => value.length)) === 1,
    );
    await first.dispose();

    const second = await open({ generate: failing, storage });

    expect(await ownList(second, OWNER.alice)).toMatchObject([{ kind: 'run.failed' }]);
    const created = await second.bureau.notifications.create({
      owner: OWNER.alice,
      kind: 'run.failed',
      title: 'again',
      dedupeKey: `run.settled:${run.id}`,
    });
    expect(created.created).toBe(false);
  });
});

describe('a review waiting', () => {
  const reviewing = () =>
    open({
      agents: {
        parked: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });

  it('notifies the run’s owner, and is dismissed when the review is decided', async () => {
    const opened = await reviewing();

    await opened.bureau.tasks.start('parked', 'charge', { principal: OWNER.alice });
    await waitUntil(
      async () => (await ownList(opened, OWNER.alice).then((value) => value.length)) === 1,
    );

    const [waiting] = await ownList(opened, OWNER.alice);
    expect(waiting).toMatchObject({
      kind: 'review.waiting',
      title: 'parked needs your approval',
      subject: { reviewKind: 'tool-approval', agentName: 'parked' },
    });
    expect(await ownList(opened, OWNER.bob)).toEqual([]);

    const [review] = opened.bureau.reviews.list();
    await opened.bureau.reviews.resolve({
      id: review!.id,
      decision: 'deny',
      principal: OWNER.alice,
    });
    await waitUntil(
      async () => (await ownList(opened, OWNER.alice).then((value) => value.length)) === 0,
    );

    const kept = await opened.bureau.notifications.list({
      owner: OWNER.alice,
      includeDismissed: true,
    });
    expect(kept.notifications).toMatchObject([{ kind: 'review.waiting' }]);
    expect(kept.notifications[0]!.dismissedAt).not.toBeNull();
  });
});

describe('notification.created', () => {
  it('is dispatched once per written notification, and published with its id and kind only', async () => {
    const opened = await open();
    const heard: NotificationCreatedEvent[] = [];
    opened.bureau.addEventListener('notification.created', (event) => heard.push(event));

    const first = await opened.bureau.notifications.create({
      owner: OWNER.alice,
      kind: 'hook.note',
      title: 'secret title',
      dedupeKey: 'k',
    });
    await opened.bureau.notifications.create({
      owner: OWNER.alice,
      kind: 'hook.note',
      title: 'again',
      dedupeKey: 'k',
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      notificationId: first.notification.id,
      notificationKind: 'hook.note',
    });
    expect(projectBureauEvent(heard[0])).toEqual({
      kind: 'notification.created',
      payload: { notificationId: first.notification.id, kind: 'hook.note' },
    });
    expect(PUBLISHED_BUREAU_EVENT_KINDS).toContain('notification.created');
  });
});

describe('bureau.notifications.list', () => {
  it('filters by kind and unread, and pages with a token bound to the filters', async () => {
    const opened = await open();
    for (const [index, kind] of ['a.one', 'b.two', 'a.one'].entries()) {
      await opened.bureau.notifications.create({ owner: OWNER.alice, kind, title: `n${index}` });
    }

    const first = await list(opened, 'alice-key', { limit: 2 });
    const second = await list(opened, 'alice-key', {
      limit: 2,
      pageToken: first.nextPageToken!,
    });
    const kinds = await list(opened, 'alice-key', { kind: 'a.one' });
    const mismatched = await list(opened, 'alice-key', {
      kind: 'a.one',
      limit: 2,
      pageToken: first.nextPageToken!,
    });
    const strangers = await list(opened, 'bob-key', { pageToken: first.nextPageToken! });

    expect(first.notifications).toHaveLength(2);
    expect(second.notifications).toHaveLength(1);
    expect(second.nextPageToken).toBeNull();
    expect(kinds.notifications.map((n) => n.title)).toEqual(['n2', 'n0']);
    for (const refused of [mismatched, strangers]) {
      expect(refused.body.error?.data).toMatchObject({
        issues: [{ path: ['pageToken'], code: 'page-token-mismatch' }],
      });
    }
  });

  it('answers a caller that can own nothing with an empty page', async () => {
    const opened = await open();
    await opened.bureau.notifications.create({ owner: OWNER.alice, kind: 'a.one', title: 't' });

    const response = await rpc(opened.handler, 'bureau.notifications.list', {}, 'no-such-key');

    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
  });
});

describe('bureau.notifications.markread and dismiss', () => {
  async function seeded() {
    const opened = await open();
    const mine = await opened.bureau.notifications.create({
      owner: OWNER.alice,
      kind: 'a.one',
      title: 'mine',
    });
    const theirs = await opened.bureau.notifications.create({
      owner: OWNER.bob,
      kind: 'a.one',
      title: 'theirs',
    });
    return { opened, mine: mine.notification.id, theirs: theirs.notification.id };
  }

  const updated = (body: RpcBody) => body.result?.['updated'];

  it('change the caller’s own notification and never another owner’s', async () => {
    const { opened, mine, theirs } = await seeded();

    const crossed = await rpc(
      opened.handler,
      'bureau.notifications.markread',
      { ids: [theirs] },
      'alice-key',
    );
    const read = await rpc(
      opened.handler,
      'bureau.notifications.markread',
      { ids: [mine] },
      'alice-key',
    );
    const readAgain = await rpc(
      opened.handler,
      'bureau.notifications.markread',
      { ids: [mine] },
      'alice-key',
    );

    expect([updated(crossed), updated(read), updated(readAgain)]).toEqual([0, 1, 0]);
    expect(await ownList(opened, OWNER.bob).then((value) => value[0]!.readAt)).toBeNull();
    expect(
      await list(opened, 'alice-key', { unread: true }).then((value) => value.notifications),
    ).toEqual([]);
  });

  it('dismiss hides a notification from the default list', async () => {
    const { opened, mine, theirs } = await seeded();

    const crossed = await rpc(
      opened.handler,
      'bureau.notifications.dismiss',
      { ids: [theirs] },
      'alice-key',
    );
    const dismissed = await rpc(
      opened.handler,
      'bureau.notifications.dismiss',
      { ids: [mine] },
      'alice-key',
    );

    expect([updated(crossed), updated(dismissed)]).toEqual([0, 1]);
    expect(await list(opened, 'alice-key').then((value) => value.notifications)).toEqual([]);
    expect(
      await list(opened, 'alice-key', { includeDismissed: true }).then(
        (value) => value.notifications,
      ),
    ).toHaveLength(1);
    expect(await ownList(opened, OWNER.bob)).toHaveLength(1);
  });

  it('take all: true for every one of the caller’s own', async () => {
    const { opened } = await seeded();
    await opened.bureau.notifications.create({ owner: OWNER.alice, kind: 'a.one', title: 'two' });

    const all = await rpc(
      opened.handler,
      'bureau.notifications.markread',
      { all: true },
      'alice-key',
    );

    expect(updated(all)).toBe(2);
    expect(await ownList(opened, OWNER.bob).then((value) => value[0]!.readAt)).toBeNull();
  });

  it.each([
    {},
    { ids: ['x'], all: true },
    { ids: [] },
    { all: false },
    { ids: ['x'], owner: OWNER.bob },
  ])('refuse the selection %j', async (selection) => {
    const { opened } = await seeded();

    const response = await rpc(
      opened.handler,
      'bureau.notifications.dismiss',
      selection,
      'alice-key',
    );

    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
  });
});
