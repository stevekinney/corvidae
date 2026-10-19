import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  MemoryStorage,
  textValueStore,
  WEFT_RESERVED_KEY_PREFIXES,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  aggregateCleanup,
  cleanupStateOf,
  createTaskRegistry,
  type LiveTask,
  originatingMessageText,
  settledTaskState,
  TASK_CONTEXT_INDEX_KEY_PREFIX,
  TASK_RECORD_KEY_PREFIX,
  type TaskCleanupState,
  type TaskRegistryHost,
} from './task-registry';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { CancelDurableRunOutcome, PendingReview } from './types';

const OWNER = 'api-key:alice';

function humanWait(runId: string, signalName = 'human-response'): PendingReview {
  return {
    kind: 'human-wait',
    id: `human-wait:${runId}:${signalName}:0`,
    runId,
    sessionId: 'session',
    agentName: 'assistant',
    signalName,
    prompt: 'Secret prompt',
    requestedAt: 1,
    ageMilliseconds: 0,
    status: 'pending',
  };
}

type HostState = {
  live: Map<string, LiveTask>;
  contexts: Map<string, string>;
  reviews: PendingReview[];
  aborted: string[];
  durable: CancelDurableRunOutcome;
  liveTasksOfContextsCalls: number;
  /** What the host's abort answers; by default, whether it holds the run. */
  abortOutcome?: 'requested' | 'already-terminal' | 'not-found';
};

function build(state?: Partial<HostState>) {
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const held: HostState = {
    live: new Map(),
    contexts: new Map(),
    reviews: [],
    aborted: [],
    durable: { status: 'requested' },
    liveTasksOfContextsCalls: 0,
    ...state,
  };
  const diagnostics: string[] = [];
  const host: TaskRegistryHost = {
    liveTask: (taskId) => held.live.get(taskId),
    liveTasksOfContexts: (contextIds) => {
      held.liveTasksOfContextsCalls += 1;
      const grouped = new Map<string, { taskId: string; phase: LiveTask['phase'] }[]>();
      for (const [taskId, task] of held.live) {
        const contextId = held.contexts.get(taskId);
        if (contextId === undefined || !contextIds.includes(contextId)) continue;
        grouped.set(contextId, [...(grouped.get(contextId) ?? []), { taskId, phase: task.phase }]);
      }
      return grouped;
    },
    pendingReviews: () => held.reviews,
    currentIncarnation: async () => 'incarnation-1',
    abort: (taskId) => {
      held.aborted.push(taskId);
      const live = held.live.get(taskId);
      if (live) held.live.set(taskId, { ...live, phase: 'aborting' });
      if (held.abortOutcome !== undefined) return held.abortOutcome;
      return live === undefined ? 'not-found' : 'requested';
    },
    cancelDurable: async () => held.durable,
    sleep: (milliseconds) =>
      new Promise<void>((resolve) => {
        runtime.timers.setTimeout(resolve, milliseconds);
      }),
  };
  const kv = textValueStore(new MemoryStorage());
  const registry = createTaskRegistry({
    kv,
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    host,
    diagnose: (message) => diagnostics.push(message),
  });
  return { registry, kv, host, held, runtime, diagnostics };
}

const running: LiveTask = {
  phase: 'running',
  finishReason: undefined,
  error: undefined,
  updatedAt: undefined,
};

async function admit(
  registry: ReturnType<typeof build>['registry'],
  taskId: string,
  overrides: Partial<Parameters<ReturnType<typeof build>['registry']['recordAdmission']>[0]> = {},
) {
  await registry.recordAdmission({
    taskId,
    contextId: 'context-1',
    incarnation: 'incarnation-1',
    agentName: 'assistant',
    owner: OWNER,
    message: `message of ${taskId}`,
    ...overrides,
  });
}

describe('the task record keys', () => {
  const OTHER_PREFIXES = [
    'bureau-catalog-run:',
    'bureau-child:',
    'bureau-delegation:',
    'bureau-goal:',
    'bureau-steering-run:',
    'command-ledger:v1',
    // The respond command's own ledger, a sibling of run creation's.
    'command-ledger:tasks-respond:v1',
    // Pull request #359's AG-UI lease records.
    'ag-ui-lease:v1:',
    'agent-session:',
    'agent-session-v2:body:',
    'agent-session-outbox:',
    'asset:v1:',
    'audit:v1:',
    'audit-dedupe:v1:',
    'audit-retention:v1:',
    'audit-sequence:v1:',
    'durable-run:',
    'goal:',
    'outbox-dedupe:',
    'schedule:',
    'session:',
    'session-deletion-owner:v1:',
    'session-input-identity:v1',
    'session-input-open:v2:',
    'steering-key:v1',
    'steering-log:v1',
    'webhook-delivery:v1:',
    ...WEFT_RESERVED_KEY_PREFIXES,
  ];

  it('are disjoint from each other and from every other prefix the Bureau stores under', () => {
    const ours = [TASK_RECORD_KEY_PREFIX, TASK_CONTEXT_INDEX_KEY_PREFIX];
    expect(TASK_RECORD_KEY_PREFIX.startsWith(TASK_CONTEXT_INDEX_KEY_PREFIX)).toBe(false);
    expect(TASK_CONTEXT_INDEX_KEY_PREFIX.startsWith(TASK_RECORD_KEY_PREFIX)).toBe(false);
    for (const prefix of ours) {
      for (const other of OTHER_PREFIXES) {
        expect(prefix.startsWith(other), `${prefix} starts with ${other}`).toBe(false);
        expect(other.startsWith(prefix), `${other} starts with ${prefix}`).toBe(false);
      }
    }
  });
});

describe('recordAdmission and history', () => {
  it('records the originating user message as the task history, with its own message identifier', async () => {
    const { registry } = build();
    await admit(registry, 'run-1', { message: 'Please plan my trip' });

    const history = await registry.history('run-1');

    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({ role: 'user', text: 'Please plan my trip' });
    expect(history?.[0]?.messageId).toMatch(/task-message-/);
  });

  it('records no history entry for a task admitted without a message, and nothing for an unknown task', async () => {
    const { registry } = build();
    await admit(registry, 'run-1', { message: undefined });

    expect(await registry.history('run-1')).toEqual([]);
    expect(await registry.history('run-unknown')).toBeUndefined();
  });

  it('writes a record once: admitting the same run again leaves the first', async () => {
    const { registry } = build();
    await admit(registry, 'run-1', { message: 'first' });
    await admit(registry, 'run-1', { message: 'second' });

    const history = await registry.history('run-1');
    expect(history?.[0]?.text).toBe('first');
  });

  it('keeps every originating message out of a view', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-1', { message: 'a private request' });
    held.live.set('run-1', running);

    expect(JSON.stringify(await registry.get('run-1'))).not.toContain('a private request');
  });

  it('empties the history of one incarnation of a context and keeps status and cleanup', async () => {
    const { registry } = build();
    await admit(registry, 'run-old', { incarnation: 'old', message: 'old text' });
    await admit(registry, 'run-new', { incarnation: 'incarnation-1', message: 'new text' });
    await registry.recordSettled('run-old', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });

    expect(await registry.clearHistory('context-1', 'old')).toBe(1);

    expect(await registry.history('run-old')).toEqual([]);
    const old = await registry.record('run-old');
    const fresh = await registry.history('run-new');
    expect(old?.settled?.status).toBe('completed');
    expect(fresh?.[0]?.text).toBe('new text');
  });
});

describe('originatingMessageText', () => {
  it('reads text input, the text parts of a part list, and the latest visible user row of a conversation', () => {
    expect(originatingMessageText('hello')).toBe('hello');
    expect(
      originatingMessageText([
        { type: 'text', text: 'one' },
        { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } } as never,
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
    const message = (id: string, role: string, content: string, hidden = false) => ({
      id,
      role,
      content,
      hidden,
      position: 0,
      createdAt: '',
      metadata: {},
    });
    expect(
      originatingMessageText({
        conversation: {
          ids: ['a', 'b', 'c'],
          messages: {
            a: message('a', 'user', 'first'),
            b: message('b', 'assistant', 'reply'),
            c: message('c', 'user', 'hidden', true),
          },
        } as never,
      }),
    ).toBe('first');
  });
});

describe('views', () => {
  it('maps a live run, a settled record, and a pending review onto the task states', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-working');
    await admit(registry, 'run-waiting');
    await admit(registry, 'run-done');
    await admit(registry, 'run-failed');
    await admit(registry, 'run-canceled');
    await admit(registry, 'run-submitted');
    held.live.set('run-working', running);
    held.live.set('run-waiting', running);
    held.live.set('run-submitted', { ...running, phase: 'submitted' });
    held.live.set('run-done', {
      phase: 'completed',
      finishReason: 'stop-condition',
      error: undefined,
      updatedAt: Date.parse('2026-10-18T00:00:05.000Z'),
    });
    held.live.set('run-failed', {
      phase: 'completed',
      finishReason: 'maximum-steps',
      error: undefined,
      updatedAt: undefined,
    });
    held.live.set('run-canceled', {
      phase: 'aborted',
      finishReason: 'aborted',
      error: undefined,
      updatedAt: undefined,
    });
    held.reviews = [humanWait('run-waiting')];

    const statuses = Object.fromEntries(
      await Promise.all(
        ['working', 'waiting', 'done', 'failed', 'canceled', 'submitted'].map(async (name) => {
          const view = await registry.get(`run-${name}`);
          return [name, view?.status] as const;
        }),
      ),
    );

    expect(statuses).toEqual({
      working: 'working',
      waiting: 'input-required',
      done: 'completed',
      failed: 'failed',
      canceled: 'canceled',
      submitted: 'submitted',
    });
    const waiting = await registry.get('run-waiting');
    expect(waiting?.openWaits).toEqual([
      {
        kind: 'human-wait',
        reviewId: 'human-wait:run-waiting:human-response:0',
        signalName: 'human-response',
      },
    ]);
    const failed = await registry.get('run-failed');
    const done = await registry.get('run-done');
    expect(failed?.statusMessage).toBe('maximum-steps');
    expect(done?.updatedAt).toBe('2026-10-18T00:00:05.000Z');
  });

  it('reads a task this process holds no run for from its settlement', async () => {
    const { registry } = build();
    await admit(registry, 'run-1');
    await registry.recordSettled('run-1', {
      at: '2026-10-18T01:00:00.000Z',
      status: 'failed',
      finishReason: 'error',
      message: 'boom',
    });

    expect(await registry.get('run-1')).toMatchObject({
      status: 'failed',
      finishReason: 'error',
      statusMessage: 'boom',
      updatedAt: '2026-10-18T01:00:00.000Z',
    });
  });

  it('maps finish reasons onto settled states', () => {
    expect(settledTaskState('completed', 'stop-condition')).toBe('completed');
    expect(settledTaskState('completed', 'elicitation-denied')).toBe('failed');
    expect(settledTaskState('completed', 'tripwire')).toBe('failed');
    expect(settledTaskState('completed', 'budget-exceeded')).toBe('failed');
    expect(settledTaskState('completed', 'aborted')).toBe('canceled');
    expect(settledTaskState('error', undefined)).toBe('failed');
    expect(settledTaskState('aborted', undefined)).toBe('canceled');
  });
});

describe('list', () => {
  it('filters by owner, agent, status and context, newest first, and pages with nextOffset', async () => {
    const { registry, held, runtime } = build();
    for (const [index, owner] of [OWNER, OWNER, 'api-key:bob', OWNER].entries()) {
      runtime.setTime(Date.parse('2026-10-18T00:00:00.000Z') + index * 1000);
      await admit(registry, `run-${index}`, {
        owner,
        agentName: index === 3 ? 'writer' : 'assistant',
        contextId: index === 1 ? 'context-2' : 'context-1',
      });
      held.live.set(`run-${index}`, running);
    }

    const own = await registry.list({ owner: OWNER, limit: 50, offset: 0 });
    const everyone = await registry.list({ limit: 50, offset: 0 });
    const writer = await registry.list({ agentName: 'writer', limit: 50, offset: 0 });
    const context = await registry.list({ contextId: 'context-1', limit: 50, offset: 0 });
    const paged = await registry.list({ limit: 2, offset: 0 });
    const last = await registry.list({ limit: 2, offset: 2 });
    const none = await registry.list({ status: 'completed', limit: 50, offset: 0 });

    expect(own.tasks.map((task) => task.id)).toEqual(['run-3', 'run-1', 'run-0']);
    expect(everyone.tasks).toHaveLength(4);
    expect(writer.tasks.map((task) => task.id)).toEqual(['run-3']);
    expect(context.tasks.map((task) => task.id)).toEqual(['run-3', 'run-2', 'run-0']);
    expect(paged.nextOffset).toBe(2);
    expect(last.nextOffset).toBeNull();
    expect(none.tasks).toEqual([]);
  });

  it('returns only the current incarnation of a context', async () => {
    const { registry } = build();
    await admit(registry, 'run-old', { incarnation: 'before-delete' });
    await admit(registry, 'run-new', { incarnation: 'incarnation-1' });

    const page = await registry.list({ contextId: 'context-1', limit: 50, offset: 0 });

    expect(page.tasks.map((task) => task.id)).toEqual(['run-new']);
  });
});

describe('activityOf', () => {
  it('answers a whole page with one query to the host', async () => {
    const { registry, held } = build();
    held.contexts.set('run-1', 'context-1');
    held.contexts.set('run-2', 'context-2');
    held.contexts.set('run-3', 'context-3');
    held.live.set('run-1', running);
    held.live.set('run-2', running);
    held.live.set('run-3', { ...running, phase: 'completed' });
    held.reviews = [humanWait('run-2')];
    await admit(registry, 'run-1', { contextId: 'context-1' });
    await admit(registry, 'run-2', { contextId: 'context-2' });
    await admit(registry, 'run-3', { contextId: 'context-3' });

    const activity = await registry.activityOf([
      'context-1',
      'context-2',
      'context-3',
      'context-4',
    ]);

    expect(held.liveTasksOfContextsCalls).toBe(1);
    expect([...activity]).toEqual([
      ['context-1', 'running'],
      ['context-2', 'awaiting-input'],
      ['context-3', 'idle'],
      ['context-4', 'idle'],
    ]);
  });

  async function activityWith(
    tasks: ReadonlyArray<readonly [string, LiveTask['phase']]>,
    parked: readonly string[],
  ) {
    const { registry, held } = build();
    for (const [taskId, phase] of tasks) {
      held.contexts.set(taskId, 'context-1');
      held.live.set(taskId, { ...running, phase });
      await admit(registry, taskId, { contextId: 'context-1' });
    }
    held.reviews = parked.map((taskId) => humanWait(taskId));
    const activity = await registry.activityOf(['context-1']);
    return activity.get('context-1');
  }

  it('is decided by the context’s latest task alone: an older parked task does not hold a newer working one', async () => {
    expect(
      await activityWith(
        [
          ['run-old', 'running'],
          ['run-new', 'running'],
        ],
        ['run-old'],
      ),
    ).toBe('running');
    expect(
      await activityWith(
        [
          ['run-old', 'running'],
          ['run-new', 'running'],
        ],
        ['run-new'],
      ),
    ).toBe('awaiting-input');
  });

  it('reads idle when the latest task has ended, whatever an older task is still doing', async () => {
    expect(
      await activityWith(
        [
          ['run-old', 'running'],
          ['run-new', 'completed'],
        ],
        [],
      ),
    ).toBe('idle');
  });

  it('counts only the tasks of the incarnation it is asked about, and the one the context has now by default', async () => {
    const { registry, held } = build();
    // The context was deleted and created again: the old incarnation's task still lingers.
    held.contexts.set('run-old', 'context-1');
    held.contexts.set('run-new', 'context-1');
    held.live.set('run-old', running);
    held.live.set('run-new', { ...running, phase: 'completed' });
    await admit(registry, 'run-old', { contextId: 'context-1', incarnation: 'incarnation-0' });
    await admit(registry, 'run-new', { contextId: 'context-1', incarnation: 'incarnation-1' });

    const authorized = await registry.activityOf(
      ['context-1'],
      new Map([['context-1', 'incarnation-1']]),
    );
    const previous = await registry.activityOf(
      ['context-1'],
      new Map([['context-1', 'incarnation-0']]),
    );
    const current = await registry.activityOf(['context-1']);

    expect(authorized.get('context-1')).toBe('idle');
    expect(previous.get('context-1')).toBe('running');
    expect(current.get('context-1')).toBe('idle');
  });

  it('agrees with list about which tasks belong to a context, catalog records included', async () => {
    const { registry, held } = build();
    held.contexts.set('run-catalog', 'context-1');
    held.live.set('run-catalog', running);
    // A catalog record has no incarnation; the context has a session, so neither read counts it.
    await admit(registry, 'run-catalog', { contextId: 'context-1', incarnation: '' });

    const activity = await registry.activityOf(['context-1']);
    const listed = await registry.list({ contextId: 'context-1', limit: 10, offset: 0 });

    expect(listed.tasks).toEqual([]);
    expect(activity.get('context-1')).toBe('idle');
  });
});

describe('cleanup states', () => {
  it('maps every acknowledgement onto a cleanup state', () => {
    expect(cleanupStateOf({ status: 'not-required' })).toBe('cleaned-up');
    expect(cleanupStateOf({ status: 'completed' })).toBe('cleaned-up');
    expect(cleanupStateOf({ status: 'failed' })).toBe('cleanup-failed');
    expect(cleanupStateOf({ status: 'unresolved', reason: 'timed-out' })).toBe(
      'cleanup-unresolved',
    );
    expect(cleanupStateOf({ status: 'unresolved', reason: 'unreachable' })).toBe(
      'cleanup-unresolved',
    );
    expect(cleanupStateOf({ status: 'unresolved', reason: 'persistence-failed' })).toBe(
      'cleanup-unresolved',
    );
    expect(cleanupStateOf({ status: 'unresolved', reason: 'unknown-effect' })).toBe(
      'unknown-outcome',
    );
  });

  it('aggregates by the least settled state, and treats a request or a stop with no evidence conservatively', () => {
    expect(aggregateCleanup([])).toBeUndefined();
    expect(aggregateCleanup(['cleaned-up'])).toBe('cleaned-up');
    expect(aggregateCleanup(['cleaned-up', 'cleanup-failed'])).toBe('cleanup-failed');
    expect(aggregateCleanup(['cleanup-failed', 'unknown-outcome'])).toBe('unknown-outcome');
    expect(aggregateCleanup(['unknown-outcome', 'cleanup-unresolved'])).toBe('cleanup-unresolved');
    expect(aggregateCleanup(['cleanup-unresolved', 'cleanup-pending', 'cleaned-up'])).toBe(
      'cleanup-pending',
    );
    expect(aggregateCleanup(['cancel-requested', 'cleaned-up'])).toBe('cleanup-pending');
    expect(aggregateCleanup(['canceled', 'cleaned-up'])).toBe('cleanup-unresolved');
  });
});

describe('cancel', () => {
  function settle(registry: ReturnType<typeof build>['registry'], taskId: string) {
    return registry.recordSettled(taskId, {
      at: '2026-10-18T00:00:09.000Z',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });
  }

  it('is not found for a task with no record', async () => {
    const { registry } = build();

    expect(await registry.cancel('run-unknown', 0)).toBeUndefined();
  });

  it('answers cancel-requested without waiting, and then the settled cleanup state', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-1');
    held.live.set('run-1', running);
    let acknowledge: (value: { status: 'completed' }) => void = () => undefined;
    const closed = new Promise<{ status: 'completed' }>((resolve) => {
      acknowledge = resolve;
    });
    const watching = registry.watchCleanup('run-1', closed);

    const pending = await registry.cancel('run-1', 0);
    acknowledge({ status: 'completed' });
    await watching;
    held.live.set('run-1', { ...running, phase: 'aborted', finishReason: 'aborted' });
    const settledOutcome = await registry.cancel('run-1', 0);

    expect(pending).toEqual({ receipt: 'cancel-requested' });
    expect(held.aborted).toContain('run-1');
    expect(settledOutcome).toEqual({ receipt: 'cleaned-up' });
  });

  it('waits for the acknowledgement up to waitMilliseconds, and reports cleanup-pending when the wait elapses first', async () => {
    const { registry, held, runtime } = build();
    await admit(registry, 'run-1');
    held.live.set('run-1', running);
    void registry.watchCleanup('run-1', new Promise(() => undefined));

    const outcome = registry.cancel('run-1', 1000);
    // The cancel has aborted the run, which reaches its terminal state at once.
    while (runtime.pendingTimers().length === 0) await Promise.resolve();
    held.live.set('run-1', { ...running, phase: 'aborted', finishReason: 'aborted' });
    await runtime.advance(1000);

    expect(await outcome).toEqual({ receipt: 'cleanup-pending' });
    expect(held.aborted).toContain('run-1');
  });

  it('reports each acknowledgement it waits for', async () => {
    const cases: Array<[Parameters<typeof cleanupStateOf>[0], TaskCleanupState]> = [
      [{ status: 'completed' }, 'cleaned-up'],
      [{ status: 'not-required' }, 'cleaned-up'],
      [{ status: 'failed' }, 'cleanup-failed'],
      [{ status: 'unresolved', reason: 'timed-out' }, 'cleanup-unresolved'],
      [{ status: 'unresolved', reason: 'unknown-effect' }, 'unknown-outcome'],
    ];
    for (const [acknowledgement, receipt] of cases) {
      const { registry, held } = build();
      await admit(registry, 'run-1');
      held.live.set('run-1', running);
      void registry.watchCleanup('run-1', Promise.resolve(acknowledgement));

      const outcome = await registry.cancel('run-1', 1000);

      expect(outcome).toEqual({ receipt });
    }
  });

  it('rejects a task that finished without being canceled, and reports a repeated cancel of a canceled one', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-done');
    await settle(registry, 'run-done');
    await admit(registry, 'run-canceled');
    held.live.set('run-canceled', { ...running, phase: 'aborted', finishReason: 'aborted' });
    void registry.watchCleanup('run-canceled', Promise.resolve({ status: 'completed' }));
    await registry.watchCleanup('run-canceled', Promise.resolve({ status: 'completed' }));

    expect(await registry.cancel('run-done', 0)).toEqual({
      receipt: 'rejected',
      reason: 'already-terminal',
    });
    expect(await registry.cancel('run-canceled', 0)).toEqual({ receipt: 'cleaned-up' });
    expect(await registry.cancel('run-canceled', 0)).toEqual({ receipt: 'cleaned-up' });
  });

  it('rejects a cancel that loses to the run completing between the live check and the abort', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-1');
    held.live.set('run-1', running);
    // The run ends after the registry saw it running, so the abort finds it over.
    held.abortOutcome = 'already-terminal';

    const outcome = await registry.cancel('run-1', 0);

    expect(outcome).toEqual({ receipt: 'rejected', reason: 'already-terminal' });
  });

  it('answers a repeated cancel at once while the cleanup is still pending, whatever the wait', async () => {
    const { registry, held, runtime } = build();
    await admit(registry, 'run-1');
    held.live.set('run-1', running);
    void registry.watchCleanup('run-1', new Promise(() => undefined));
    held.live.set('run-1', { ...running, phase: 'aborted', finishReason: 'aborted' });

    const hung = Symbol('hung');
    const bounded = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        new Promise<symbol>((resolve) => setTimeout(() => resolve(hung), 100)),
      ]);
    const immediate = await bounded(registry.cancel('run-1', 0));
    const waiting = registry.cancel('run-1', 1000);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await runtime.advance(1000);
    const waited = await bounded(waiting);

    expect(immediate).toEqual({ receipt: 'cleanup-pending' });
    expect(waited).toEqual({ receipt: 'cleanup-pending' });
  });

  it('keeps the answer whichever of two settlements of one task lands last', async () => {
    const withAnswer = {
      at: '2026-10-18T00:00:09.000Z',
      status: 'completed' as const,
      finishReason: 'stop-condition',
      message: null,
      answer: { text: 'the answer', truncated: false },
    };
    const withoutAnswer = { ...withAnswer, answer: undefined };
    for (const order of [
      [withoutAnswer, withAnswer],
      [withAnswer, withoutAnswer],
    ]) {
      const { registry } = build();
      await admit(registry, 'run-1', { incarnation: '' });
      for (const settlement of order) await registry.recordSettled('run-1', settlement);

      const record = await registry.record('run-1');

      expect(record?.settled?.answer).toEqual({ text: 'the answer', truncated: false });
    }
  });

  it('stores an answer on a catalog task’s record only, never on a session task’s', async () => {
    const { registry } = build();
    await admit(registry, 'run-catalog', { incarnation: '' });
    await admit(registry, 'run-session', { incarnation: 'incarnation-1' });
    const settlement = {
      at: '2026-10-18T00:00:09.000Z',
      status: 'completed' as const,
      finishReason: 'stop-condition',
      message: null,
      answer: { text: 'SESSION-ANSWER', truncated: false },
    };

    await registry.recordSettled('run-catalog', settlement);
    await registry.recordSettled('run-session', settlement);

    const catalog = await registry.record('run-catalog');
    const session = await registry.record('run-session');
    expect(catalog?.settled?.answer).toBeDefined();
    expect(session?.settled?.answer).toBeUndefined();
  });

  it('lets a shutdown wait for the settlement and cleanup writes in flight', async () => {
    const { registry } = build();
    await admit(registry, 'run-1');
    const writing = registry.recordSettled('run-1', {
      at: '2026-10-18T00:00:09.000Z',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });

    await registry.flush();

    await writing;
    const record = await registry.record('run-1');
    expect(record?.settled?.status).toBe('completed');
  });

  it('lists the records no settlement has been written for', async () => {
    const { registry } = build();
    await admit(registry, 'run-open');
    await admit(registry, 'run-done');
    await settle(registry, 'run-done');

    const open = await registry.unsettled();

    expect(open.map((record) => record.taskId)).toEqual(['run-open']);
  });

  it('answers a repeated cancel of a durable run it stopped as canceled, and records that on the task', async () => {
    const { registry } = build();
    await admit(registry, 'run-1');

    const first = await registry.cancel('run-1', 0);
    const repeat = await registry.cancel('run-1', 0);
    const view = await registry.get('run-1');

    expect(first).toEqual({ receipt: 'canceled' });
    expect(repeat).toEqual({ receipt: 'canceled' });
    expect(view?.cleanup).toBe('canceled');
  });

  it('cancels a durable run this process holds no live run for', async () => {
    const requested = build();
    await admit(requested.registry, 'run-1');

    expect(await requested.registry.cancel('run-1', 0)).toEqual({ receipt: 'canceled' });
    const afterwards = await requested.registry.get('run-1');
    expect(afterwards?.status).toBe('canceled');

    const terminal = build({ durable: { status: 'already-terminal' } });
    await admit(terminal.registry, 'run-1');
    expect(await terminal.registry.cancel('run-1', 0)).toEqual({
      receipt: 'rejected',
      reason: 'already-terminal',
    });

    const failing = build({ durable: { status: 'failed', error: new Error('engine down') } });
    await admit(failing.registry, 'run-1');
    const failure = await rejectionOf(failing.registry.cancel('run-1', 0));
    expect((failure as Error).message).toBe('engine down');
  });
});

describe('remove and expire', () => {
  it('removes a record with its context index entry', async () => {
    const { registry, kv } = build();
    await admit(registry, 'run-1');

    await registry.remove('run-1');

    expect(await registry.get('run-1')).toBeUndefined();
    expect(await kv.list(TASK_RECORD_KEY_PREFIX)).toEqual([]);
    expect(await kv.list(TASK_CONTEXT_INDEX_KEY_PREFIX)).toEqual([]);
  });

  it('expires only settled records past the cutoff that no live run and no kept id holds', async () => {
    const { registry, held } = build();
    for (const id of ['old', 'recent', 'kept', 'live', 'unsettled']) await admit(registry, id);
    const settledAt = (iso: string) => ({
      at: iso,
      status: 'completed' as const,
      finishReason: 'stop-condition',
      message: null,
    });
    await registry.recordSettled('old', settledAt('2026-09-01T00:00:00.000Z'));
    await registry.recordSettled('recent', settledAt('2026-10-17T00:00:00.000Z'));
    await registry.recordSettled('kept', settledAt('2026-09-01T00:00:00.000Z'));
    await registry.recordSettled('live', settledAt('2026-09-01T00:00:00.000Z'));
    held.live.set('live', { ...running, phase: 'completed' });

    const removed = await registry.expire(
      Date.parse('2026-10-01T00:00:00.000Z'),
      new Set(['kept']),
    );

    expect(removed).toBe(1);
    expect(await registry.record('old')).toBeUndefined();
    for (const id of ['recent', 'kept', 'live', 'unsettled']) {
      expect(await registry.record(id), id).toBeDefined();
    }
  });
});

/** A stored task record, valid in every field, for a test to break one field of. */
function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: 'run-bad',
    contextId: 'context-1',
    incarnation: 'incarnation-1',
    agentName: 'assistant',
    owner: OWNER,
    createdAt: '2026-09-01T00:00:00.000Z',
    history: [],
    ...overrides,
  };
}

describe('a task record with a malformed field', () => {
  const settled = {
    at: '2026-09-01T00:00:00.000Z',
    status: 'completed',
    finishReason: 'stop-condition',
    message: null,
  };
  const MALFORMED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['no agentName', { agentName: undefined }],
    ['a numeric agentName', { agentName: 7 }],
    ['an invalid createdAt', { createdAt: 'yesterday' }],
    [
      'a history entry without text',
      { history: [{ messageId: 'm', role: 'user', createdAt: '2026-09-01T00:00:00.000Z' }] },
    ],
    ['a settlement with an invalid timestamp', { settled: { ...settled, at: 'not a date' } }],
    ['a settlement with an unknown status', { settled: { ...settled, status: 'working' } }],
    ['a settlement with a numeric message', { settled: { ...settled, message: 4 } }],
    ['a settlement with a malformed answer', { settled: { ...settled, answer: { text: 1 } } }],
    ['an unknown cleanup state', { cleanup: 'tidy' }],
  ];

  it.each(MALFORMED)(
    'is isolated, never thrown and never pruned, and leaves the good rows listed: %s',
    async (_label, overrides) => {
      const { registry, kv, diagnostics } = build();
      await admit(registry, 'run-good');
      const key = `${TASK_RECORD_KEY_PREFIX}run-bad`;
      const raw = JSON.stringify(storedRecord(overrides));
      await kv.set(key, raw);

      const listed = await registry.list({ limit: 50, offset: 0 });
      const got = await registry.get('run-bad');
      // Far in the future: a settlement timestamp read as 0 or NaN would qualify at once.
      const removed = await registry.expire(Date.parse('2030-01-01T00:00:00.000Z'), new Set());

      expect(listed.tasks.map((task) => task.id)).toEqual(['run-good']);
      expect(got).toBeUndefined();
      expect(removed).toBe(0);
      expect(await kv.get(key)).toBe(raw);
      expect(diagnostics.length).toBeGreaterThan(0);
    },
  );

  it('reads a record whose every field is well formed', async () => {
    const { registry, kv } = build();
    await kv.set(
      `${TASK_RECORD_KEY_PREFIX}run-bad`,
      JSON.stringify(storedRecord({ settled, cleanup: 'cleaned-up', agentName: null })),
    );

    const view = await registry.get('run-bad');
    expect(view?.status).toBe('completed');
  });
});

describe('expiry and a review still pending', () => {
  it('keeps a settled task whose review is still open until the review is gone', async () => {
    const { registry, held } = build();
    await admit(registry, 'run-1');
    await registry.recordSettled('run-1', {
      at: '2026-09-01T00:00:00.000Z',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    });
    held.reviews = [humanWait('run-1')];
    const cutoff = Date.parse('2026-10-01T00:00:00.000Z');

    const whileOpen = await registry.expire(cutoff, new Set());
    const view = await registry.get('run-1');
    held.reviews = [];
    const afterwards = await registry.expire(cutoff, new Set());

    expect(whileOpen).toBe(0);
    expect(view?.status).toBe('input-required');
    expect(afterwards).toBe(1);
    expect(await registry.record('run-1')).toBeUndefined();
  });
});

describe('an unreadable task record', () => {
  const UNREADABLE = [
    ['an unknown schema version', JSON.stringify({ schemaVersion: 2, taskId: 'run-bad' })],
    ['malformed JSON', '{not json'],
    ['a value that is not a record', '[]'],
  ] as const;

  it.each(UNREADABLE)(
    'is skipped and diagnosed, not thrown, by listing, expiry and removal: %s',
    async (_label, value) => {
      const { registry, kv, diagnostics } = build();
      await admit(registry, 'run-good', { owner: OWNER });
      await admit(registry, 'run-old');
      await registry.recordSettled('run-old', {
        at: '2026-09-01T00:00:00.000Z',
        status: 'completed',
        finishReason: 'stop-condition',
        message: null,
      });
      await kv.set(`${TASK_RECORD_KEY_PREFIX}run-bad`, value);

      const listed = await registry.list({ limit: 50, offset: 0 });
      const removed = await registry.expire(Date.parse('2026-10-01T00:00:00.000Z'), new Set());
      await registry.remove('run-bad');

      expect(listed.tasks.map((task) => task.id).toSorted()).toEqual(['run-good', 'run-old']);
      expect(removed).toBe(1);
      expect(await registry.record('run-old')).toBeUndefined();
      expect(await registry.get('run-bad')).toBeUndefined();
      expect(diagnostics.length).toBeGreaterThan(0);
    },
  );
});

describe('idle', () => {
  /** An acknowledgement that arrives after `turns` event-loop turns. */
  function acknowledgedAfter(turns: number): Promise<{ status: 'completed' }> {
    return (async () => {
      for (let turn = 0; turn < turns; turn += 1) await yieldToPortableEventLoop();
      return { status: 'completed' as const };
    })();
  }

  it('records an acknowledgement that arrives within its turn limit', async () => {
    const { registry } = build();
    await admit(registry, 'run-1');
    void registry.watchCleanup('run-1', acknowledgedAfter(5));

    await registry.idle();

    const record = await registry.record('run-1');

    expect(record?.cleanup).toBe('cleaned-up');
  });

  it('is a bound, not a barrier: it stops waiting at its turn limit, and a limit of zero waits for no acknowledgement', async () => {
    const { registry } = build();
    await admit(registry, 'run-1');
    void registry.watchCleanup('run-1', acknowledgedAfter(5));

    await registry.idle(0);

    const record = await registry.record('run-1');

    expect(record?.cleanup).toBeUndefined();
  });
});

describe('a task started on its owner’s behalf (COR-1482)', () => {
  it('records the actor beside the owner, and shows a task its owner started with none', async () => {
    const { registry } = build();
    await admit(registry, 'fire-1', { incarnation: '', actor: 'system:scheduler' });
    await admit(registry, 'own-1');

    expect(await registry.get('fire-1')).toMatchObject({ owner: OWNER, actor: 'system:scheduler' });
    const awaited16 = await registry.record('fire-1');
    expect(awaited16?.actor).toBe('system:scheduler');
    expect(await registry.get('own-1')).toMatchObject({ owner: OWNER, actor: null });
    const awaited17 = await registry.record('own-1');
    expect(awaited17?.actor).toBeUndefined();
  });

  it('binds an unbound task to the incarnation its session turned out to have, once', async () => {
    const { registry } = build();
    await admit(registry, 'fire-1', { incarnation: '', actor: 'system:scheduler' });

    // Unbound, it is a context that is only a run: found while the context has no incarnation.
    expect(await registry.bindIncarnation('fire-1', '')).toBe(false);
    expect(await registry.bindIncarnation('fire-1', 'incarnation-1')).toBe(true);
    const awaited18 = await registry.record('fire-1');
    expect(awaited18?.incarnation).toBe('incarnation-1');
    // A task already bound keeps what it has, and a task with no record has nothing to bind.
    expect(await registry.bindIncarnation('fire-1', 'incarnation-2')).toBe(false);
    const awaited19 = await registry.record('fire-1');
    expect(awaited19?.incarnation).toBe('incarnation-1');
    expect(await registry.bindIncarnation('nobody', 'incarnation-1')).toBe(false);
    const found = await registry.list({ contextId: 'context-1', limit: 10, offset: 0 });
    expect(found.tasks.map((task) => task.id)).toEqual(['fire-1']);
  });
});

describe('a schedule fire in the registry (COR-1482)', () => {
  it('keeps its kind, is unsettled until it is settled, and keeps its answer however it is bound', async () => {
    const { registry } = build();
    await admit(registry, 'fire-1', { incarnation: '', kind: 'schedule-fire' });
    await admit(registry, 'own-1', { contextId: 'context-2' });

    const fireRecord = await registry.record('fire-1');
    const ownRecord = await registry.record('own-1');
    expect(fireRecord?.kind).toBe('schedule-fire');
    expect(ownRecord?.kind).toBeUndefined();
    const unsettled = await registry.unsettledFiresOfContext('context-1');
    expect(unsettled.map((record) => record.taskId)).toEqual(['fire-1']);
    expect(await registry.unsettledFiresOfContext('context-2')).toEqual([]);

    await registry.bindIncarnation('fire-1', 'incarnation-1');
    await registry.recordSettled('fire-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'completed',
      finishReason: 'stop',
      message: null,
      answer: { text: 'the answer', truncated: false },
    });

    const record = await registry.record('fire-1');
    expect(record?.settled?.answer).toEqual({ text: 'the answer', truncated: false });
    expect(await registry.unsettledFiresOfContext('context-1')).toEqual([]);
  });

  it('keeps its context running while it is unsettled, bound to the session or not', async () => {
    const { registry } = build();
    await admit(registry, 'fire-1', { incarnation: '', kind: 'schedule-fire' });

    const running = await registry.activityOf(['context-1']);
    expect(running.get('context-1')).toBe('running');
    await registry.recordSettled('fire-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'completed',
      finishReason: 'stop',
      message: null,
    });
    const idle = await registry.activityOf(['context-1']);
    expect(idle.get('context-1')).toBe('idle');
  });

  it('tells a listener once that it settled, whether the run ended or it was cancelled, and not before', async () => {
    const { registry } = build();
    await admit(registry, 'fire-1', { incarnation: '', kind: 'schedule-fire' });
    await admit(registry, 'fire-2', { incarnation: '', kind: 'schedule-fire' });
    const told: string[] = [];
    registry.onSettled('fire-1', (view) => told.push(`${view.id}:${view.status}`));
    registry.onSettled('fire-2', (view) => told.push(`${view.id}:${view.status}`));
    const stopped = registry.onSettled('fire-2', () => told.push('stopped listener'));
    stopped();

    await registry.recordSettled('fire-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'failed',
      finishReason: null,
      message: 'it failed',
    });
    await registry.recordSettled('fire-1', {
      at: '2026-10-18T00:00:02.000Z',
      status: 'failed',
      finishReason: null,
      message: 'it failed again',
    });
    expect(told).toEqual(['fire-1:failed']);

    const outcome = await registry.cancel('fire-2', 0);
    expect(outcome?.receipt).toBe('canceled');
    expect(told).toEqual(['fire-1:failed', 'fire-2:canceled']);
  });

  it('survives a listener that throws, diagnosing it', async () => {
    const { registry, diagnostics } = build();
    await admit(registry, 'fire-1', { incarnation: '', kind: 'schedule-fire' });
    registry.onSettled('fire-1', () => {
      throw new Error('listener failed');
    });

    const recorded = await registry.recordSettled('fire-1', {
      at: '2026-10-18T00:00:01.000Z',
      status: 'completed',
      finishReason: 'stop',
      message: null,
    });

    expect(recorded).toBe(true);
    expect(
      diagnostics.some((message) => message.includes('listener of task "fire-1" failed')),
    ).toBe(true);
  });
});
