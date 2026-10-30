import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { describe, expect, it, spyOn } from 'bun:test';

import {
  TASK_LISTING_KEY_PREFIX,
  TASK_LISTING_LIFETIME_MILLISECONDS,
  TASK_LISTING_MAXIMUM_BYTES,
  TASK_LISTING_MAXIMUM_ENTRIES,
  TaskListingTokenError,
  type TaskListingTokenFailure,
} from './task-list-snapshots';
import {
  createTaskRegistry,
  TASK_CONTEXT_INDEX_KEY_PREFIX,
  TASK_RECORD_KEY_PREFIX,
  type LiveTask,
  type TaskListQuery,
  type TaskRegistry,
  type TaskView,
} from './task-registry';
import type { TaskOrigin } from './task-origin';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';

const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

type Runtime = ReturnType<typeof createManualRuntimeServices>;

function build(options: { kv?: ConditionalTextValueStore | 'none'; runtime?: Runtime } = {}) {
  const runtime =
    options.runtime ?? createManualRuntimeServices({ origin: '2026-10-22T00:00:00.000Z' });
  const live = new Map<string, LiveTask>();
  const incarnations = new Map<string, string>([['context-1', 'incarnation-1']]);
  const kv =
    options.kv === 'none' ? undefined : (options.kv ?? textValueStore(new MemoryStorage()));
  const registry = createTaskRegistry({
    kv,
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    host: {
      liveTask: (taskId) => live.get(taskId),
      liveTasksOfContexts: () => new Map(),
      pendingReviews: () => [],
      currentIncarnation: async (contextId) => incarnations.get(contextId),
      abort: () => 'not-found',
      cancelDurable: async () => ({ status: 'requested' }),
      sleep: async () => {},
    },
    diagnose: () => {},
  });
  return { registry, kv, runtime, live, incarnations };
}

const running: LiveTask = {
  phase: 'running',
  finishReason: undefined,
  error: undefined,
  updatedAt: undefined,
};

/** Admits `count` tasks one millisecond apart, so each has its own status timestamp. */
async function admitMany(
  harness: ReturnType<typeof build>,
  count: number,
  options: { owner?: string; prefix?: string; message?: string; origin?: TaskOrigin } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const taskId = `${options.prefix ?? 'task'}-${String(index).padStart(5, '0')}`;
    await harness.registry.recordAdmission({
      taskId,
      contextId: 'context-1',
      incarnation: 'incarnation-1',
      agentName: 'assistant',
      owner: options.owner ?? ALICE,
      origin: options.origin ?? { kind: 'api' },
      message: options.message ?? `message of ${taskId}`,
    });
    ids.push(taskId);
    await harness.runtime.advance(1);
  }
  return ids;
}

async function listAll<T = TaskView>(
  registry: TaskRegistry,
  query: TaskListQuery<T>,
  between?: (pageIndex: number) => Promise<void>,
): Promise<T[]> {
  const listed: T[] = [];
  let { pageToken } = query;
  for (let pageIndex = 0; ; pageIndex += 1) {
    const page: { tasks: readonly T[]; nextPageToken: string | null } = await registry.list<T>({
      ...query,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    listed.push(...page.tasks);
    if (page.nextPageToken === null) return listed;
    pageToken = page.nextPageToken;
    await between?.(pageIndex);
  }
}

function idsOf(tasks: readonly TaskView[]): string[] {
  return tasks.map((task) => task.id);
}

async function snapshotKeys(kv: ConditionalTextValueStore | undefined): Promise<string[]> {
  return kv === undefined ? [] : kv.list(TASK_LISTING_KEY_PREFIX);
}

async function refusal(promise: Promise<unknown>): Promise<TaskListingTokenFailure> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(TaskListingTokenError);
  return (error as TaskListingTokenError).reason;
}

const CHAT_ORIGIN: TaskOrigin = {
  kind: 'chat',
  contextId: 'context-1',
  agentName: 'assistant',
  principal: ALICE,
};

describe('TaskRegistry.list', () => {
  it('orders by status timestamp, newest first, with the task id ascending breaking ties', async () => {
    const harness = build();
    await admitMany(harness, 3);
    // Two tasks admitted in the same millisecond tie on the timestamp.
    await harness.registry.recordAdmission({
      taskId: 'tie-a',
      contextId: 'context-1',
      incarnation: 'incarnation-1',
      agentName: 'assistant',
      owner: ALICE,
      origin: { kind: 'api' },
      message: undefined,
    });
    await harness.registry.recordAdmission({
      taskId: 'tie-b',
      contextId: 'context-1',
      incarnation: 'incarnation-1',
      agentName: 'assistant',
      owner: ALICE,
      origin: { kind: 'api' },
      message: undefined,
    });
    await harness.runtime.advance(1);
    // A settlement moves the oldest task to the front.
    await harness.registry.recordSettled('task-00000', {
      at: harness.runtime.clock.nowISO(),
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });

    const page = await harness.registry.list({ principal: ALICE, owner: ALICE, limit: 50 });

    expect(idsOf(page.tasks)).toEqual(['task-00000', 'tie-a', 'tie-b', 'task-00002', 'task-00001']);
    expect(page.nextPageToken).toBeNull();
    // Paging one entry at a time continues strictly after the key of the last entry, tie included.
    expect(
      idsOf(await listAll(harness.registry, { principal: ALICE, owner: ALICE, limit: 1 })),
    ).toEqual(['task-00000', 'tie-a', 'tie-b', 'task-00002', 'task-00001']);
  });

  it('lists only the tasks of an origin kind, across pages, and counts only them', async () => {
    const harness = build();
    await admitMany(harness, 3, { prefix: 'api' });
    await admitMany(harness, 3, { prefix: 'chat', origin: CHAT_ORIGIN });
    await admitMany(harness, 2, {
      prefix: 'fire',
      origin: { kind: 'schedule', scheduleId: 'schedule-1', fireId: 'fire-1' },
    });
    // A record written before origins were kept has no origin and matches no kind.
    await harness.kv?.set(
      `${TASK_RECORD_KEY_PREFIX}legacy`,
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'legacy',
        contextId: 'context-1',
        incarnation: 'incarnation-1',
        agentName: 'assistant',
        owner: ALICE,
        createdAt: '2026-10-22T00:00:00.000Z',
        history: [],
      }),
    );

    const first = await harness.registry.list({ principal: ALICE, limit: 2, origin: 'chat' });
    const chat = await listAll(harness.registry, { principal: ALICE, limit: 2, origin: 'chat' });
    const fires = await listAll(harness.registry, {
      principal: ALICE,
      limit: 1,
      origin: 'schedule',
    });
    const none = await harness.registry.list({ principal: ALICE, limit: 5, origin: 'person' });
    const everything = await listAll(harness.registry, { principal: ALICE, limit: 3 });

    expect(first.totalSize).toBe(3);
    expect(idsOf(chat)).toEqual(['chat-00002', 'chat-00001', 'chat-00000']);
    expect(chat.every((task) => task.origin?.kind === 'chat')).toBe(true);
    expect(idsOf(fires)).toEqual(['fire-00001', 'fire-00000']);
    expect(none.tasks).toEqual([]);
    expect(everything).toHaveLength(9);
    expect(everything.find((task) => task.id === 'legacy')?.origin).toBeNull();
  });

  it('writes no snapshot for a listing that fits one page', async () => {
    const harness = build();
    await admitMany(harness, 3);

    const page = await harness.registry.list({ principal: ALICE, limit: 3 });

    expect(page.tasks).toHaveLength(3);
    expect(page.nextPageToken).toBeNull();
    expect(await snapshotKeys(harness.kv)).toEqual([]);
  });

  it('keeps every page to its own owner', async () => {
    const harness = build();
    await admitMany(harness, 3, { owner: ALICE, prefix: 'alice' });
    await admitMany(harness, 3, { owner: BOB, prefix: 'bob' });

    const alice = await listAll(harness.registry, { principal: ALICE, owner: ALICE, limit: 2 });
    const everyone = await listAll(harness.registry, { principal: 'reader', limit: 2 });

    expect(alice.every((task) => task.owner === ALICE)).toBe(true);
    expect(alice).toHaveLength(3);
    expect(everyone).toHaveLength(6);
  });

  it('reports the snapshot’s size on every page, unchanged by tasks created or removed since', async () => {
    const harness = build();
    await admitMany(harness, 5);

    const first = await harness.registry.list({ principal: ALICE, limit: 2 });
    await admitMany(harness, 1, { prefix: 'late' });
    await harness.registry.remove('task-00000');
    const second = await harness.registry.list({
      principal: ALICE,
      limit: 2,
      pageToken: first.nextPageToken ?? '',
    });
    const single = await harness.registry.list({ principal: ALICE, status: 'completed', limit: 2 });

    expect([first.totalSize, second.totalSize, single.totalSize]).toEqual([5, 5, 0]);
  });

  it('filters by statusTimestampAfter, strictly', async () => {
    const harness = build();
    await admitMany(harness, 4);
    // `task-00001` was admitted at origin + 1 ms.
    const after = new Date(Date.parse('2026-10-22T00:00:00.000Z') + 1).toISOString();

    const page = await harness.registry.list({
      principal: ALICE,
      statusTimestampAfter: after,
      limit: 50,
    });

    expect(idsOf(page.tasks)).toEqual(['task-00003', 'task-00002']);
  });

  it('yields each task of the snapshot exactly once while tasks are created between pages', async () => {
    const harness = build();
    const original = await admitMany(harness, 7);
    let created = 0;

    const listed = await listAll(harness.registry, { principal: ALICE, limit: 2 }, async () => {
      created += 1;
      await admitMany(harness, 1, { prefix: `late-${created}` });
    });

    expect(created).toBe(3);
    expect(idsOf(listed)).toEqual(original.toReversed());
  });

  it('returns a task that changed mid-enumeration as it matched, in its original position', async () => {
    const harness = build();
    const ids = await admitMany(harness, 4);
    for (const id of ids) harness.live.set(id, running);

    const first = await harness.registry.list({ principal: ALICE, status: 'working', limit: 2 });
    // The oldest task, due on the second page, completes before that page is read.
    harness.live.delete('task-00000');
    await harness.registry.recordSettled('task-00000', {
      at: harness.runtime.clock.nowISO(),
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });
    const second = await harness.registry.list({
      principal: ALICE,
      status: 'working',
      limit: 2,
      pageToken: first.nextPageToken ?? '',
    });

    expect(idsOf(first.tasks)).toEqual(['task-00003', 'task-00002']);
    expect(idsOf(second.tasks)).toEqual(['task-00001', 'task-00000']);
    expect(second.tasks.at(-1)?.status).toBe('working');
    expect(second.nextPageToken).toBeNull();
    const now = await harness.registry.get('task-00000');
    expect(now?.status).toBe('completed');
  });

  it('returns a projection from the snapshot, unaffected by history cleared since', async () => {
    const harness = build();
    await admitMany(harness, 3);
    const project = async (view: TaskView) => ({
      id: view.id,
      history: ((await harness.registry.history(view.id)) ?? []).map((entry) => entry.text),
    });

    const first = await harness.registry.list({ principal: ALICE, limit: 1, project });
    await harness.registry.clearHistory('context-1', 'incarnation-1');
    const rest = await listAll(harness.registry, {
      principal: ALICE,
      limit: 2,
      project,
      pageToken: first.nextPageToken ?? '',
    });

    expect(first.tasks).toEqual([{ id: 'task-00002', history: ['message of task-00002'] }]);
    expect(rest).toEqual([
      { id: 'task-00001', history: ['message of task-00001'] },
      { id: 'task-00000', history: ['message of task-00000'] },
    ]);
    expect(await harness.registry.history('task-00000')).toEqual([]);
  });

  it('skips a task removed before its page, and still completes the enumeration', async () => {
    const harness = build();
    await admitMany(harness, 5);

    const listed = await listAll(
      harness.registry,
      { principal: ALICE, limit: 2 },
      async (index) => {
        if (index === 0) await harness.registry.remove('task-00001');
      },
    );

    expect(idsOf(listed)).toEqual(['task-00004', 'task-00003', 'task-00002', 'task-00000']);
  });

  it('keeps a page short rather than reaching past a removed task, with a token while entries remain', async () => {
    const harness = build();
    await admitMany(harness, 5);

    const first = await harness.registry.list({ principal: ALICE, limit: 2 });
    await harness.registry.remove('task-00002');
    const second = await harness.registry.list({
      principal: ALICE,
      limit: 2,
      pageToken: first.nextPageToken ?? '',
    });

    expect(idsOf(second.tasks)).toEqual(['task-00001']);
    expect(second.nextPageToken).not.toBeNull();
  });

  it('pages a 2,500-task listing completely, with every snapshot within both bounds', async () => {
    const harness = build();
    const ids = await admitMany(harness, 2500, { message: '' });

    const listed = await listAll(harness.registry, { principal: ALICE, limit: 100 });
    const keys = await snapshotKeys(harness.kv);

    expect(idsOf(listed)).toEqual(ids.toReversed());
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      const raw = (await harness.kv?.get(key)) ?? '';
      const record = JSON.parse(raw) as { entries: unknown[] };
      expect(record.entries.length).toBeLessThanOrEqual(TASK_LISTING_MAXIMUM_ENTRIES);
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
        TASK_LISTING_MAXIMUM_BYTES,
      );
    }
  });

  it('closes a window on the byte bound before it reaches 1,000 entries', async () => {
    const harness = build();
    await admitMany(harness, 100, { message: '' });
    const large = 'x'.repeat(64 * 1024);

    const listed = await listAll(harness.registry, {
      principal: ALICE,
      limit: 100,
      project: (view) => ({ id: view.id, large }),
    });
    const keys = await snapshotKeys(harness.kv);
    const first = JSON.parse((await harness.kv?.get(keys[0] ?? '')) ?? '') as {
      entries: unknown[];
    };

    expect(listed).toHaveLength(100);
    expect(keys.length).toBeGreaterThan(1);
    expect(first.entries.length).toBeLessThan(100);
    for (const key of keys) {
      const raw = (await harness.kv?.get(key)) ?? '';
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
        TASK_LISTING_MAXIMUM_BYTES,
      );
    }
  });
});

describe('a TaskRegistry.list page token', () => {
  async function started(harness: ReturnType<typeof build>, query: Partial<TaskListQuery> = {}) {
    await admitMany(harness, 3);
    const first = await harness.registry.list({
      principal: ALICE,
      owner: ALICE,
      limit: 1,
      ...query,
    });
    expect(first.nextPageToken).not.toBeNull();
    return first.nextPageToken ?? '';
  }

  it('is refused when it is not a token', async () => {
    const harness = build();
    expect(
      await refusal(harness.registry.list({ principal: ALICE, limit: 1, pageToken: 'nonsense' })),
    ).toBe('malformed');
  });

  it('is refused for another principal', async () => {
    const harness = build();
    const pageToken = await started(harness);
    expect(
      await refusal(harness.registry.list({ principal: BOB, owner: BOB, limit: 1, pageToken })),
    ).toBe('not-found');
  });

  it('is refused for another reach', async () => {
    const harness = build();
    const pageToken = await started(harness);
    expect(await refusal(harness.registry.list({ principal: ALICE, limit: 1, pageToken }))).toBe(
      'reach',
    );
  });

  it('is refused for another projection, whichever way it crosses', async () => {
    const harness = build();
    const native = await started(harness);
    const firstA2APage = await harness.registry.list({
      principal: ALICE,
      owner: ALICE,
      limit: 1,
      projection: 'a2a',
    });
    const a2a = firstA2APage.nextPageToken ?? '';
    const listAs = (pageToken: string, projection?: string) =>
      harness.registry.list({
        principal: ALICE,
        owner: ALICE,
        limit: 1,
        pageToken,
        ...(projection === undefined ? {} : { projection }),
      });

    expect(await refusal(listAs(native, 'a2a'))).toBe('projection');
    expect(await refusal(listAs(a2a))).toBe('projection');
    // Each token still works for the projection it was issued for.
    const nativePage = await listAs(native);
    const a2aPage = await listAs(a2a, 'a2a');
    expect(nativePage.tasks).toHaveLength(1);
    expect(a2aPage.tasks).toHaveLength(1);
  });

  it('is refused for other filters', async () => {
    const harness = build();
    const pageToken = await started(harness);
    for (const filter of [
      { status: 'working' },
      { agentName: 'assistant' },
      { contextId: 'context-1' },
      { statusTimestampAfter: '2026-01-01T00:00:00.000Z' },
      { origin: 'chat' },
    ] as const) {
      expect(
        await refusal(
          harness.registry.list({ principal: ALICE, owner: ALICE, limit: 1, pageToken, ...filter }),
        ),
      ).toBe('filters');
    }
  });

  it('is refused under another origin filter, whichever way it crosses', async () => {
    const harness = build();
    await admitMany(harness, 3, { prefix: 'chat', origin: CHAT_ORIGIN });
    await admitMany(harness, 3, { prefix: 'api' });
    const query = { principal: ALICE, owner: ALICE, limit: 1 } as const;
    const chatPage = await harness.registry.list({ ...query, origin: 'chat' });
    const unfilteredPage = await harness.registry.list(query);
    const chatToken = chatPage.nextPageToken ?? '';
    const unfilteredToken = unfilteredPage.nextPageToken ?? '';

    expect(
      await refusal(harness.registry.list({ ...query, origin: 'schedule', pageToken: chatToken })),
    ).toBe('filters');
    expect(await refusal(harness.registry.list({ ...query, pageToken: chatToken }))).toBe(
      'filters',
    );
    expect(
      await refusal(
        harness.registry.list({ ...query, origin: 'chat', pageToken: unfilteredToken }),
      ),
    ).toBe('filters');
    // The token still works for the filter it was issued for.
    const next = await harness.registry.list({ ...query, origin: 'chat', pageToken: chatToken });
    expect(next.tasks).toHaveLength(1);
  });

  it('is refused once its context was deleted and created again', async () => {
    const harness = build();
    const pageToken = await started(harness, { contextId: 'context-1' });
    harness.incarnations.set('context-1', 'incarnation-2');

    expect(
      await refusal(
        harness.registry.list({
          principal: ALICE,
          owner: ALICE,
          contextId: 'context-1',
          limit: 1,
          pageToken,
        }),
      ),
    ).toBe('context-changed');
  });

  it('works until 15 minutes after the first page, and not after', async () => {
    const harness = build();
    const pageToken = await started(harness);
    const query = { principal: ALICE, owner: ALICE, limit: 1, pageToken };

    await harness.runtime.advance(TASK_LISTING_LIFETIME_MILLISECONDS - 1);
    const before = await harness.registry.list(query);
    await harness.runtime.advance(1);

    expect(before.tasks).toHaveLength(1);
    // The token the later page issued shares the listing's expiry.
    expect(
      await refusal(harness.registry.list({ ...query, pageToken: before.nextPageToken ?? '' })),
    ).toBe('expired');
    expect(await refusal(harness.registry.list(query))).toBe('expired');
  });

  it('ends the oldest of a principal’s listings when a 17th starts', async () => {
    const harness = build();
    await admitMany(harness, 2);
    const tokens: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const page = await harness.registry.list({ principal: ALICE, limit: 1 });
      tokens.push(page.nextPageToken ?? '');
      await harness.runtime.advance(1);
    }
    // Another principal's listings are its own.
    await harness.registry.list({ principal: BOB, limit: 1 });

    expect(
      await refusal(harness.registry.list({ principal: ALICE, limit: 1, pageToken: tokens[0] })),
    ).toBe('not-found');
    const second = await harness.registry.list({
      principal: ALICE,
      limit: 1,
      pageToken: tokens[1],
    });
    expect(second.tasks).toHaveLength(1);
    expect(await snapshotKeys(harness.kv)).toHaveLength(17);
  });

  it('stays within the cap when many listings start at once', async () => {
    const harness = build();
    await admitMany(harness, 2);

    await Promise.all(
      Array.from({ length: 24 }, () => harness.registry.list({ principal: ALICE, limit: 1 })),
    );

    expect(await snapshotKeys(harness.kv)).toHaveLength(16);
  });

  it('survives a restart over persistent storage', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-22T00:00:00.000Z' });
    const kv = textValueStore(new MemoryStorage());
    const before = build({ kv, runtime });
    const pageToken = await started(before);
    await runtime.advance(60_000);

    const after = build({ kv, runtime });
    const page = await after.registry.list({ principal: ALICE, owner: ALICE, limit: 5, pageToken });

    expect(idsOf(page.tasks)).toEqual(['task-00001', 'task-00000']);
  });

  it('is refused after a restart without persistent storage', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-22T00:00:00.000Z' });
    const before = build({ kv: 'none', runtime });
    const pageToken = await started(before);
    await runtime.advance(60_000);
    const still = await before.registry.list({
      principal: ALICE,
      owner: ALICE,
      limit: 5,
      pageToken,
    });

    const after = build({ kv: 'none', runtime });

    expect(idsOf(still.tasks)).toEqual(['task-00001', 'task-00000']);
    expect(
      await refusal(after.registry.list({ principal: ALICE, owner: ALICE, limit: 5, pageToken })),
    ).toBe('not-found');
  });
});

describe('TaskRegistry.expireListings', () => {
  it('deletes an expired snapshot by its key alone, and keeps a live one', async () => {
    const harness = build();
    await admitMany(harness, 3);
    await harness.registry.list({ principal: ALICE, limit: 1 });
    await harness.runtime.advance(TASK_LISTING_LIFETIME_MILLISECONDS);
    await harness.registry.list({ principal: BOB, limit: 1 });
    const kv = harness.kv;
    if (kv === undefined) throw new Error('expected a store');
    const reads = spyOn(kv, 'get');

    const removed = await harness.registry.expireListings();

    expect(removed).toBe(1);
    expect(reads).not.toHaveBeenCalled();
    const left = await snapshotKeys(kv);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain(encodeURIComponent(BOB));
  });

  it('pins the key version to the task view’s shape, so a snapshot saved without `kind` is never read', () => {
    // Bump this with the view: a stored view is parsed as the current shape by the next page.
    expect(TASK_LISTING_KEY_PREFIX).toBe('bureau-task-listing:v3:');
  });

  it('stores under a prefix disjoint from the task records and the context index', () => {
    for (const prefix of [TASK_RECORD_KEY_PREFIX, TASK_CONTEXT_INDEX_KEY_PREFIX]) {
      expect(TASK_LISTING_KEY_PREFIX.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(TASK_LISTING_KEY_PREFIX)).toBe(false);
    }
  });
});
