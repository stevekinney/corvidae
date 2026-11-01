/**
 * COR-1978 — a hook scoped to one agent, workflow or schedule, over a scripted engine: what is
 * delivered and what is not, when the Bureau's records are read, what a scope may be written with,
 * a record whose scope this release cannot read, and the last delivery `hooks.list` carries. The
 * lookups run for real, over a real Bureau, in `hooks-scope-bureau.test.ts`.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { BUREAU_EVENT_CATALOG } from '../bureau-event-catalog.ts';
import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks, type HookScopeInput } from './create-hooks.ts';
import { type HookSubjectSources, subjectsOfPayload } from './hook-scope.ts';
import { createHookStore, HOOK_KEY_PREFIX } from './hook-store.ts';
import { type Hook, HookError } from './hook-types.ts';

const RUNS: Readonly<Record<string, Awaited<ReturnType<HookSubjectSources['run']>>>> = {
  'run-of-alpha': { agent: 'alpha', workflows: [], schedules: [] },
  'run-of-beta': { agent: 'beta', workflows: [], schedules: [] },
  'step-of-nightly': { agent: 'alpha', workflows: ['nightly'], schedules: ['every-hour'] },
};

function setup(sources: Partial<HookSubjectSources> = {}) {
  const tracked: Promise<void>[] = [];
  const engine: WebhookDeliveryEngine = {
    fetch: (() => Promise.resolve(new Response('ok'))) as unknown as typeof fetch,
    now: () => 1_800_000_000_000,
    maxAttempts: 1,
    backoffMilliseconds: () => 0,
    wait: () => Promise.resolve(),
    shuttingDown: () => false,
    signal: new AbortController().signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _runId, work) => work(),
  };
  const asked: string[] = [];
  const diagnosed: string[] = [];
  let failNotifications = false;
  let next = 0;
  const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  const created = createHooks({
    kv,
    engine,
    keys: undefined,
    bureauId: 'scope-bureau',
    newId: (kind) => `${kind}-${String(++next).padStart(3, '0')}`,
    audit: () => Promise.resolve(),
    diagnose: (message) => {
      diagnosed.push(message);
    },
    subjects: {
      run: (runId) => {
        asked.push(runId);
        return Promise.resolve(RUNS[runId] ?? { agent: undefined, workflows: [], schedules: [] });
      },
      agentOfSchedule: (scheduleId) =>
        Promise.resolve(scheduleId === 'every-hour' ? 'alpha' : undefined),
      agentOfGoal: (goalRunId) => Promise.resolve(goalRunId === 'goal-1' ? 'alpha' : undefined),
      ...sources,
    },
    notifications: () => ({
      create: () =>
        failNotifications
          ? Promise.reject(Object.assign(new Error('refused'), { code: 'BAD_REQUEST' }))
          : Promise.resolve({ notification: { id: 'n-1' }, created: true } as never),
    }),
  });
  return {
    hooks: created.hooks,
    kv,
    asked,
    diagnosed,
    failNotifications(): void {
      failNotifications = true;
    },
    notifyHook: (events: readonly string[], scope?: HookScopeInput) =>
      created.hooks.create({
        action: { type: 'notify' },
        events,
        ...(scope === undefined ? {} : { scope }),
      }),
    async fire(kind: string, payload: Record<string, unknown>): Promise<void> {
      await created.resume();
      created.dispatch({
        sequence: 0,
        cursor: '0',
        bureauId: 'scope-bureau',
        kind,
        emittedAtMs: 1_800_000_000_000,
        payload,
      } satisfies BureauEventEnvelope);
      await Promise.all(tracked.splice(0));
    },
    /** Rewrites a stored hook's scope, as a newer release would have written it. */
    async storeScope(hookId: string, scope: unknown): Promise<void> {
      const raw = JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${hookId}`))!) as object;
      await kv.set(`${HOOK_KEY_PREFIX}${hookId}`, JSON.stringify({ ...raw, scope }));
    },
  };
}

/** The scope a change leaves on a hook. */
async function scopeAfter(change: Promise<Hook | undefined>): Promise<Hook['scope']> {
  const changed = await change;
  return changed?.scope;
}

async function refusal(work: Promise<unknown>): Promise<HookError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HookError) return error;
    throw error;
  }
  throw new Error('expected a HookError');
}

describe('a scoped hook', () => {
  it('fires only for the agent it names, and a hook with no scope fires for every agent', async () => {
    const run = setup();
    const alpha = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const everyone = await run.notifyHook(['run.settled']);

    await run.fire('run.settled', { runId: 'run-of-beta' });
    expect(await run.hooks.deliveries(alpha.id)).toHaveLength(0);
    expect(await run.hooks.deliveries(everyone.id)).toHaveLength(1);

    await run.fire('run.settled', { runId: 'run-of-alpha' });
    expect(await run.hooks.deliveries(alpha.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(everyone.id)).toHaveLength(2);
  });

  it('reads a run’s workflow and schedule, and matches a step by the workflow above it', async () => {
    const run = setup();
    const nightly = await run.notifyHook(['review.requested'], { kind: 'workflow', id: 'nightly' });
    const hourly = await run.notifyHook(['review.requested'], {
      kind: 'schedule',
      id: 'every-hour',
    });
    const other = await run.notifyHook(['review.requested'], { kind: 'workflow', id: 'other' });

    await run.fire('review.requested', { reviewId: 'r', runId: 'step-of-nightly' });

    expect(await run.hooks.deliveries(nightly.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(hourly.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(other.id)).toHaveLength(0);
  });

  it('matches a schedule event by its id, its agent, and the workflow file that owns it', async () => {
    const run = setup();
    const bySchedule = await run.notifyHook(['schedule.paused'], {
      kind: 'schedule',
      id: 'every-hour',
    });
    const byAgent = await run.notifyHook(['schedule.paused'], { kind: 'agent', id: 'alpha' });
    const byWorkflow = await run.notifyHook(['schedule.paused'], {
      kind: 'workflow',
      id: 'nightly',
    });

    await run.fire('schedule.paused', { scheduleId: 'every-hour' });
    expect(await run.hooks.deliveries(bySchedule.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(byAgent.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(byWorkflow.id)).toHaveLength(0);

    await run.fire('schedule.paused', { scheduleId: 'bureau-workflow-schedule:nightly:1' });
    expect(await run.hooks.deliveries(byWorkflow.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(byAgent.id)).toHaveLength(1);
  });

  it('matches a goal event by the goal’s agent, and a chat event by the agent it names', async () => {
    const run = setup();
    const goals = await run.notifyHook(['goal.succeeded'], { kind: 'agent', id: 'alpha' });
    const chats = await run.notifyHook(['session.created'], { kind: 'agent', id: 'alpha' });

    await run.fire('goal.succeeded', { goalRunId: 'goal-2' });
    await run.fire('session.created', { sessionId: 's', agentName: 'beta' });
    expect(await run.hooks.deliveries(goals.id)).toHaveLength(0);
    expect(await run.hooks.deliveries(chats.id)).toHaveLength(0);

    await run.fire('goal.succeeded', { goalRunId: 'goal-1' });
    await run.fire('session.created', { sessionId: 's', agentName: 'alpha' });
    expect(await run.hooks.deliveries(goals.id)).toHaveLength(1);
    expect(await run.hooks.deliveries(chats.id)).toHaveLength(1);
  });

  it('asks the Bureau once for an event however many scoped hooks list it, and never without one', async () => {
    const run = setup();
    await run.notifyHook(['run.settled']);
    await run.notifyHook(['run.registered'], { kind: 'agent', id: 'alpha' });

    await run.fire('run.settled', { runId: 'run-of-alpha' });
    expect(run.asked).toEqual([]);

    await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    await run.notifyHook(['run.settled'], { kind: 'workflow', id: 'nightly' });
    await run.fire('run.settled', { runId: 'run-of-alpha' });
    expect(run.asked).toEqual(['run-of-alpha']);
  });

  it('does not fire when the lookup fails, says so, and leaves the unscoped hook alone', async () => {
    const run = setup({ run: () => Promise.reject(new Error('the store is unreachable')) });
    const scoped = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const unscoped = await run.notifyHook(['run.settled']);

    await run.fire('run.settled', { runId: 'run-of-alpha' });

    expect(await run.hooks.deliveries(scoped.id)).toHaveLength(0);
    expect(await run.hooks.deliveries(unscoped.id)).toHaveLength(1);
    expect(run.diagnosed).toEqual(['Could not tell what a run.settled event is about']);
  });

  it('never takes a subject from anything but the event: a run with no record matches nothing', async () => {
    const run = setup();
    const scoped = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });

    await run.fire('run.settled', { runId: 'a-run-nothing-knows' });

    expect(await run.hooks.deliveries(scoped.id)).toHaveLength(0);
  });
});

describe('writing a scope', () => {
  it('refuses an event its kind cannot tell, on both sides of an update, naming the event', async () => {
    const run = setup();
    const created = await refusal(
      run.notifyHook(['run.settled', 'diagnostic'], { kind: 'agent', id: 'alpha' }),
    );
    expect(created.code).toBe('invalid');
    expect(created.issues[0]?.path).toEqual(['scope']);
    expect(created.message).toContain('diagnostic');
    await refusal(run.notifyHook(['session.created'], { kind: 'workflow', id: 'nightly' }));

    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const moved = await refusal(run.hooks.update(hook.id, { events: ['diagnostic'] }));
    expect(moved.code).toBe('invalid');
    const plain = await run.notifyHook(['diagnostic']);
    const scoped = await refusal(
      run.hooks.update(plain.id, { scope: { kind: 'agent', id: 'alpha' } }),
    );
    expect(scoped.code).toBe('invalid');
  });

  it('offers no scope on run.removed: deleting a run deletes the task record a scope would read', async () => {
    const run = setup();
    expect(BUREAU_EVENT_CATALOG['run.removed'].scopes).toEqual([]);
    await refusal(run.notifyHook(['run.removed'], { kind: 'agent', id: 'alpha' }));
  });

  it('refuses a kind it does not know, and a subject that is empty or too long', async () => {
    const run = setup();
    for (const scope of [
      { kind: 'team', id: 'alpha' },
      { kind: 'agent', id: '' },
      { kind: 'agent', id: 'a'.repeat(257) },
      {},
    ]) {
      const refused = await refusal(run.notifyHook(['run.settled'], scope as HookScopeInput));
      expect(refused.code).toBe('invalid');
    }
  });

  it('keeps the scope through an unrelated change, moves it, and removes it with null', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });

    expect(await scopeAfter(run.hooks.update(hook.id, { name: 'Renamed' }))).toEqual({
      kind: 'agent',
      id: 'alpha',
    });
    expect(
      await scopeAfter(run.hooks.update(hook.id, { scope: { kind: 'agent', id: 'beta' } })),
    ).toEqual({ kind: 'agent', id: 'beta' });

    const cleared = await run.hooks.update(hook.id, { scope: null });
    expect(cleared).not.toHaveProperty('scope');
    await run.fire('run.settled', { runId: 'run-of-alpha' });
    expect(await run.hooks.deliveries(hook.id)).toHaveLength(1);
  });

  it('stores a hook with no scope without the field, so a record reads as it did before scopes', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled']);
    const stored = JSON.parse((await run.kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as object;
    expect(stored).not.toHaveProperty('scope');
    expect(await run.hooks.get(hook.id)).not.toHaveProperty('scope');
  });
});

describe('the stored version of a scoped hook', () => {
  /** What a release that predates scopes reads: version 1 only. */
  function readableByOlderRelease(raw: string | null): boolean {
    return raw !== null && (JSON.parse(raw) as { version?: unknown }).version === 1;
  }

  it('writes version 2 for a scoped hook, so an older release refuses it, and version 1 without a scope', async () => {
    const run = setup();
    const scoped = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const plain = await run.notifyHook(['run.settled']);

    const scopedRaw = await run.kv.get(`${HOOK_KEY_PREFIX}${scoped.id}`);
    const plainRaw = await run.kv.get(`${HOOK_KEY_PREFIX}${plain.id}`);
    expect(JSON.parse(scopedRaw!)).toMatchObject({
      version: 2,
      scope: { kind: 'agent', id: 'alpha' },
    });
    expect(JSON.parse(plainRaw!)).toMatchObject({ version: 1 });
    expect(readableByOlderRelease(scopedRaw)).toBe(false);
    expect(readableByOlderRelease(plainRaw)).toBe(true);
  });

  it('writes version 2 through a rename, and version 1 again once the scope is cleared or set later', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const versionOf = async (): Promise<unknown> =>
      (JSON.parse((await run.kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as { version: unknown })
        .version;

    await run.hooks.update(hook.id, { name: 'Renamed' });
    expect(await versionOf()).toBe(2);
    await run.hooks.update(hook.id, { scope: null });
    expect(await versionOf()).toBe(1);
    await run.hooks.update(hook.id, { scope: { kind: 'agent', id: 'beta' } });
    expect(await versionOf()).toBe(2);
  });

  it('refuses a scoped webhook hook to an older release too, and still keeps its top-level url', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const store = createHookStore(kv);
    await store.createHook({
      version: 1,
      id: 'hook-webhook',
      owner: 'api-key:alice',
      action: { type: 'webhook', url: 'https://hooks.example.com/receive' },
      events: ['run.settled'],
      scope: { kind: 'agent', id: 'alpha' },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    });

    const raw = await kv.get(`${HOOK_KEY_PREFIX}hook-webhook`);
    expect(JSON.parse(raw!)).toMatchObject({
      version: 2,
      url: 'https://hooks.example.com/receive',
    });
    expect(readableByOlderRelease(raw)).toBe(false);
    const stored = await store.getHook('hook-webhook');
    expect(stored?.record.scope).toEqual({
      kind: 'agent',
      id: 'alpha',
    });
  });

  it('still reads a scoped record written as version 1, as a release before this rule wrote it', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const raw = JSON.parse((await run.kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as object;
    await run.kv.set(`${HOOK_KEY_PREFIX}${hook.id}`, JSON.stringify({ ...raw, version: 1 }));

    const read = await run.hooks.get(hook.id);
    expect(read?.scope).toEqual({ kind: 'agent', id: 'alpha' });
  });

  it('does not read a version it does not know', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const raw = JSON.parse((await run.kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as object;
    await run.kv.set(`${HOOK_KEY_PREFIX}${hook.id}`, JSON.stringify({ ...raw, version: 3 }));

    expect(await run.hooks.get(hook.id)).toBeUndefined();
  });
});

describe('a stored scope this release cannot read', () => {
  for (const [name, scope] of [
    ['a kind it does not know', { kind: 'team', id: 'alpha' }],
    ['a malformed value', 'alpha'],
    ['null', null],
  ] as const) {
    it(`keeps the hook, and never fires it: ${name}`, async () => {
      const run = setup();
      const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
      await run.storeScope(hook.id, scope);

      // Still readable: a hook this release cannot read has its pending deliveries deleted.
      expect(await run.hooks.get(hook.id)).toBeDefined();
      await run.fire('run.settled', { runId: 'run-of-alpha' });

      expect(await run.hooks.deliveries(hook.id)).toHaveLength(0);
      expect(run.diagnosed).toEqual([]);
    });
  }

  it('leaves the scope on the record through a rename and a disable, every field of it', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    const future = { kind: 'team', id: 'alpha', region: 'west' };
    await run.storeScope(hook.id, future);

    await run.hooks.update(hook.id, { name: 'Renamed', enabled: false });

    const stored = JSON.parse((await run.kv.get(`${HOOK_KEY_PREFIX}${hook.id}`))!) as object;
    expect(stored).toMatchObject({ scope: future });
  });

  it('still never fires a malformed scope after a rename, which writes it as one that matches nothing', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    await run.storeScope(hook.id, 'alpha');

    await run.hooks.update(hook.id, { name: 'Renamed' });
    await run.fire('run.settled', { runId: 'run-of-alpha' });

    expect(await scopeAfter(run.hooks.get(hook.id))).toEqual({ kind: '', id: '' });
    expect(await run.hooks.deliveries(hook.id)).toHaveLength(0);
  });

  it('refuses new events on it, because no event can be told by a kind nothing knows', async () => {
    const run = setup();
    const hook = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    await run.storeScope(hook.id, { kind: 'team', id: 'alpha' });

    const refused = await refusal(run.hooks.update(hook.id, { events: ['run.registered'] }));

    expect(refused.issues[0]?.path).toEqual(['scope']);
    const cleared = await run.hooks.update(hook.id, { events: ['run.registered'], scope: null });
    expect(cleared).not.toHaveProperty('scope');
  });
});

describe('hooks.list', () => {
  it('narrows to the hooks scoped to exactly a subject', async () => {
    const run = setup();
    const alpha = await run.notifyHook(['run.settled'], { kind: 'agent', id: 'alpha' });
    await run.notifyHook(['run.settled'], { kind: 'agent', id: 'beta' });
    await run.notifyHook(['run.settled'], { kind: 'workflow', id: 'alpha' });
    await run.notifyHook(['run.settled']);

    const listed = await run.hooks.list({ scope: { kind: 'agent', id: 'alpha' } });

    expect(listed.map((hook) => hook.id)).toEqual([alpha.id]);
    expect(await run.hooks.list()).toHaveLength(4);
  });

  it('carries each hook’s newest delivery, and null for a hook with none', async () => {
    const run = setup();
    const busy = await run.notifyHook(['run.settled']);
    const idle = await run.notifyHook(['run.registered']);

    await run.fire('run.settled', { runId: 'run-of-alpha' });
    run.failNotifications();
    await run.fire('run.settled', { runId: 'run-of-alpha' });

    const listed = await run.hooks.list();
    const [newest] = await run.hooks.deliveries(busy.id);
    expect(listed.find((hook) => hook.id === busy.id)?.lastDelivery).toEqual({
      id: newest!.id,
      kind: 'run.settled',
      test: false,
      status: 'failed',
      lastAttempt: {
        number: 1,
        startedAt: 1_800_000_000_000,
        finishedAt: 1_800_000_000_000,
        outcome: 'rejected',
        error: 'refused',
      },
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
    expect(newest?.status).toBe('failed');
    expect(listed.find((hook) => hook.id === idle.id)?.lastDelivery).toBeNull();
  });
});

describe('subjectsOfPayload', () => {
  it('does not read a field a payload only inherits', async () => {
    const payload = Object.create({ agentName: 'alpha', runId: 'run-of-alpha' }) as Record<
      string,
      unknown
    >;
    const subjects = await subjectsOfPayload(payload, {
      run: () => Promise.reject(new Error('a field the payload does not hold was read')),
      agentOfSchedule: () => Promise.resolve(undefined),
      agentOfGoal: () => Promise.resolve(undefined),
    });
    expect(subjects.agent.size).toBe(0);
  });

  it('names a subject the catalog says each scoped kind can tell, from its own payload fields', () => {
    const subjectFields = ['agentName', 'runId', 'goalRunId', 'taskId', 'scheduleId'];
    for (const entry of Object.values(BUREAU_EVENT_CATALOG)) {
      if (entry.scopes.length === 0) continue;
      const fields = entry.payload.map((field) => field.name);
      expect(`${entry.kind}: ${String(fields.some((name) => subjectFields.includes(name)))}`).toBe(
        `${entry.kind}: true`,
      );
    }
  });
});
