/**
 * COR-2242: `{ kind: 'parallel', branches: { <name>: Step[] } }` runs every branch together and
 * continues with an object keyed by branch name. Branch step lists are validated and pinned
 * through the same recursive walk as `branch` and `map` steps.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { waitForCondition } from '@lostgradient/testing/fake-timers';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { deserializeCheckpoint } from '../core/checkpoint.ts';
import { isParallelOperationCacheEntry } from '../core/context/parallel-cache-entry.ts';
import { Engine } from '../core/engine/index.ts';
import { KEYS } from '../storage/keys.ts';
import {
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const calls: string[] = [];
const started = new Set<string>();
let hangRestart = false;

/** Resolves once both `left` and `right` have started: neither can finish before the other starts. */
async function bothStarted(own: string, other: string): Promise<void> {
  started.add(own);
  await waitForCondition(async () => started.has(other), { label: `${other} to start` });
}

async function waitingOn(engine: Engine, id: string): Promise<readonly string[]> {
  const state = await engine.get(id);
  return state?.waitingForSignals ?? [];
}

/** The history events that opened a wait of run `id`, in the order the engine recorded them. */
async function signalWaitingEvents(engine: Engine, id: string) {
  const events = await engine.getEvents(id);
  return events.filter((event) => event.type === 'file-workflow:signal-waiting');
}

/** The status of every branch slot the run's committed checkpoint holds, empty before any commit. */
async function committedSlotStatuses(storage: MemoryStorage, id: string): Promise<string[]> {
  const bytes = await storage.get(KEYS.checkpoint(id));
  if (bytes === null) return [];
  const entry = deserializeCheckpoint(bytes)
    .accumulatedResults.map(([, value]) => value)
    .find(isParallelOperationCacheEntry);
  return entry?.branches.map((slot) => slot.status) ?? [];
}

async function hasCommittedSlot(
  storage: MemoryStorage,
  id: string,
  status: string,
): Promise<boolean> {
  const statuses = await committedSlotStatuses(storage, id);
  return statuses.includes(status);
}

/** The status of the committed slot of branch `index`, if the run has committed one. */
async function committedSlotStatus(
  storage: MemoryStorage,
  id: string,
  index: number,
): Promise<string | undefined> {
  const statuses = await committedSlotStatuses(storage, id);
  return statuses[index];
}

async function waitingCount(engine: Engine, id: string): Promise<number> {
  const names = await waitingOn(engine, id);
  return names.length;
}

async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

async function isWaitingOnTwo(engine: Engine, id: string): Promise<boolean> {
  const names = await waitingOn(engine, id);
  return names.length === 2;
}

async function isWaitingOnSignal(engine: Engine, id: string, name: string): Promise<boolean> {
  const names = await waitingOn(engine, id);
  return names.includes(name);
}

/** A step input as the call log records it: a string as written, anything else as JSON. */
function labelOf(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

const host: DocumentWorkflowHost = {
  activities: {
    seed: () => ({ seeded: true }),
    list: () => ({ items: [1, 2] }),
    left: async () => {
      await bothStarted('left', 'right');
      return 'L';
    },
    right: async () => {
      await bothStarted('right', 'left');
      return 'R';
    },
    echo: ({ input, previous }) => ({ input, previous }),
    count: ({ input }) => {
      calls.push(labelOf(input));
      return input;
    },
    hang: ({ input }) => {
      calls.push(labelOf(input));
      return hangRestart ? new Promise(() => undefined) : input;
    },
    boom: () => {
      throw new Error('branch exploded');
    },
    boomCounted: ({ input }) => {
      calls.push(labelOf(input));
      throw new Error('branch exploded');
    },
    after: ({ previous }) => {
      calls.push('after');
      return previous;
    },
    pinned: ({ input }) => input,
  },
  triggerKinds: { manual: () => undefined },
  activityVersions: { pinned: '2.0.0' },
};

const manual = { kind: 'manual' };
const parallel = (branches: Record<string, unknown>) => ({ kind: 'parallel', branches });
const doc = (name: string, steps: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  name,
  trigger: manual,
  steps,
  ...extra,
});

describe('validating a parallel step', () => {
  const rows: readonly [string, unknown, string | undefined][] = [
    ['one branch', parallel({ a: [{ kind: 'activity', handler: 'seed' }] }), undefined],
    [
      'two branches, one nested in a branch',
      parallel({
        a: [{ kind: 'activity', handler: 'seed' }],
        b: [
          { kind: 'sleep', duration: 1 },
          { kind: 'await-signal', signal: 'go', timeout: 5 },
        ],
      }),
      undefined,
    ],
    ['no branches', parallel({}), 'steps[0].branches'],
    ['an empty branch', parallel({ a: [] }), 'steps[0].branches.a'],
    [
      'a branch that is not a list',
      parallel({ a: { kind: 'activity', handler: 'seed' } }),
      'steps[0].branches.a',
    ],
    ['an unknown key', { ...parallel({ a: [{ kind: 'sleep', duration: 1 }] }), extra: 1 }, 'extra'],
    ['no branches key', { kind: 'parallel' }, 'steps[0].branches'],
    [
      'an unregistered handler in a branch',
      parallel({ a: [{ kind: 'activity', handler: 'missing' }] }),
      'steps[0].branches.a[0].handler',
    ],
    [
      'an unregistered handler nested two levels down',
      parallel({
        a: [
          {
            kind: 'branch',
            on: 'x',
            cases: { y: [parallel({ b: [{ kind: 'activity', handler: 'missing' }] })] },
          },
        ],
      }),
      'steps[0].branches.a[0].cases.y[0].branches.b[0].handler',
    ],
  ];
  for (const [name, step, issue] of rows) {
    it(`${issue === undefined ? 'accepts' : 'refuses'} ${name}`, () => {
      const run = () => validateWorkflowDocument(doc('shape', [step]), host);
      if (issue === undefined) expect(run).not.toThrow();
      else expect(run).toThrow(issue);
    });
  }

  it('pins a handler used only inside a branch, and refuses a pin the host cannot honor', () => {
    const steps = [parallel({ a: [{ kind: 'activity', handler: 'pinned' }] })];
    expect(() =>
      validateWorkflowDocument(
        doc('pin-ok', steps, { activityVersions: { pinned: '2.0.0' } }),
        host,
      ),
    ).not.toThrow();
    expect(() =>
      validateWorkflowDocument(
        doc('pin-bad', steps, { activityVersions: { pinned: '1.0.0' } }),
        host,
      ),
    ).toThrow('activityVersions.pinned');
    expect(() =>
      validateWorkflowDocument(
        doc('pin-unused', steps, { activityVersions: { seed: '1.0.0' } }),
        host,
      ),
    ).toThrow('no step uses the activity handler "seed"');
  });
});

describe('running a parallel step', () => {
  it('starts every branch before any finishes and keys the result by branch name', async () => {
    started.clear();
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-start', [
          parallel({
            right: [{ kind: 'activity', handler: 'right' }],
            left: [{ kind: 'activity', handler: 'left' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-start', null, { id: 'parallel-start-run' });
    expect(await run.result()).toEqual({ left: 'L', right: 'R' });
  });

  it('hands each branch the step before it, runs a branch in order, and passes the object on', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-previous', [
          { kind: 'activity', handler: 'seed' },
          parallel({
            a: [
              { kind: 'activity', handler: 'echo', input: 'a1' },
              { kind: 'activity', handler: 'echo', input: 'a2' },
            ],
            b: [{ kind: 'activity', handler: 'echo', input: 'b1' }],
          }),
          { kind: 'activity', handler: 'echo', input: 'after' },
        ]),
      ],
    });
    const run = await engine.start('parallel-previous', null, { id: 'parallel-previous-run' });
    expect(await run.result()).toEqual({
      input: 'after',
      previous: {
        a: { input: 'a2', previous: { input: 'a1', previous: { seeded: true } } },
        b: { input: 'b1', previous: { seeded: true } },
      },
    });
  });

  it('fails the step, and the run, when a branch fails', async () => {
    calls.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-fail', [
          parallel({
            a: [{ kind: 'activity', handler: 'boom' }],
            b: [{ kind: 'activity', handler: 'count', input: 'b' }],
          }),
          { kind: 'activity', handler: 'count', input: 'after' },
        ]),
      ],
    });
    const run = await engine.start('parallel-fail', null, { id: 'parallel-fail-run' });
    expect(await throwingRejectionOf(run.result())).toThrow('branch exploded');
    const finished = await engine.get(run.id);
    expect(finished?.status).toBe('failed');
    expect(calls).not.toContain('after');
  });

  it('waits for a different signal in each branch at once, then continues', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-signals', [
          parallel({
            a: [{ kind: 'await-signal', signal: 'one' }],
            b: [{ kind: 'await-signal', signal: 'two' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-signals', null, { id: 'parallel-signals-run' });
    await waitForCondition(
      async () => {
        const current = await engine.get(run.id);
        return (current?.waitingForSignals ?? []).length === 2;
      },
      { label: 'both branches to wait' },
    );
    await run.signal('two', 'B');
    await run.signal('one', 'A');
    expect(await run.result()).toEqual({ a: 'A', b: 'B' });
  });

  it('advances each branch on its own: a branch starts its next step without waiting for a sibling`s current one', async () => {
    // COR-2416: branch `a` finishes `seed` and opens its wait while branch `b` is still on its own.
    // The branches advanced in lockstep rounds before, and `a` opened its wait only once `b` had
    // finished its step.
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-independent', [
          parallel({
            a: [
              { kind: 'activity', handler: 'seed' },
              { kind: 'await-signal', signal: 'one' },
            ],
            b: [{ kind: 'await-signal', signal: 'two' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-independent', null, {
      id: 'parallel-independent-run',
    });
    await waitUntil(async () => (await waitingCount(engine, run.id)) === 2, {
      message: 'both branches to wait at once',
    });
    const waiting = await waitingOn(engine, run.id);
    expect(waiting.toSorted()).toEqual(['one', 'two']);
    await run.signal('one', 'A');
    await run.signal('two', 'B');
    expect(await run.result()).toEqual({ a: 'A', b: 'B' });
  });

  it('refuses two branches that wait on the same signal, as the engine does for a race', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-same-signal', [
          parallel({
            a: [{ kind: 'await-signal', signal: 'one' }],
            b: [{ kind: 'await-signal', signal: 'one' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-same-signal', null, {
      id: 'parallel-same-signal-run',
    });
    expect(await throwingRejectionOf(run.result())).toThrow('same signal');
  });

  it('does not run a finished activity again after a restart while a sibling wait is open, and resumes the wait once', async () => {
    // COR-2416: a branch that settles before its siblings is committed on its own, so a restart
    // that comes while a sibling still waits finds it done. It was run again on every restart
    // before, with the whole round cached only once every branch had settled.
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'parallel-wait-restarts-run';
    const document = doc('parallel-wait-restarts', [
      parallel({
        notify: [{ kind: 'activity', handler: 'count', input: 'notify' }],
        review: [{ kind: 'await-signal', signal: 'approve' }],
      }),
    ]);
    const executions = () => calls.filter((call) => call === 'notify').length;
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('parallel-wait-restarts', null, { id });
      await waitUntil(async () => executions() === 1, { message: 'the first run' });
      await waitUntil(async () => hasCommittedSlot(storage, id, 'fulfilled'), {
        message: 'the finished branch to be committed',
      });
    }
    for (const restart of [1, 2, 3, 4]) {
      await using restarted = new Engine({ storage });
      await registerWorkflowDocuments(restarted, host, { active: [document] });
      await restarted.recoverAll();
      await waitUntil(async () => isWaitingOnSignal(restarted, id, 'approve'), {
        message: `restart ${String(restart)} to wait again`,
      });
      expect(executions()).toBe(1);
    }
    await using last = new Engine({ storage });
    await registerWorkflowDocuments(last, host, { active: [document] });
    const [handle] = await last.recoverAll();
    await waitUntil(async () => isWaitingOnSignal(last, id, 'approve'), {
      message: 'the last restart to wait again',
    });
    await last.signal(id, 'approve', 'yes');
    // The wait resumed once and took the one signal; the activity ran once, for the first run.
    expect(await handle!.result()).toEqual({ notify: 'notify', review: 'yes' });
    expect(executions()).toBe(1);
  });

  it('runs only the branches that had not finished again after a restart', async () => {
    calls.length = 0;
    hangRestart = true;
    const storage = new MemoryStorage();
    const id = 'parallel-restart-run';
    const document = doc('parallel-restart', [
      parallel({
        done: [{ kind: 'activity', handler: 'count', input: 'done' }],
        slow: [{ kind: 'activity', handler: 'hang', input: 'slow' }],
        slower: [{ kind: 'activity', handler: 'hang', input: 'slower' }],
      }),
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('parallel-restart', null, { id });
      await waitForCondition(async () => calls.length === 3, { label: 'every branch to start' });
      await waitUntil(async () => hasCommittedSlot(storage, id, 'fulfilled'), {
        message: 'the finished branch to be committed',
      });
    }
    hangRestart = false;
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    expect(await handle!.result()).toEqual({ done: 'done', slow: 'slow', slower: 'slower' });
    // The branch that finished ran once. The two that had not ran before the restart and again
    // after it: an activity is at-least-once across a crash, which is why it is handed a stable
    // workflow id and step.
    const count = (label: string) => calls.filter((call) => call === label).length;
    expect({ done: count('done'), slow: count('slow'), slower: count('slower') }).toEqual({
      done: 1,
      slow: 2,
      slower: 2,
    });
  });

  it('takes a signal delivered before a restart once, and resumes the branch still waiting', async () => {
    const storage = new MemoryStorage();
    const document = doc('parallel-signal-restart', [
      parallel({
        a: [{ kind: 'await-signal', signal: 'one' }],
        b: [{ kind: 'await-signal', signal: 'two' }],
      }),
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      const run = await original.start('parallel-signal-restart', null, {
        id: 'parallel-signal-restart-run',
      });
      await waitForCondition(async () => isWaitingOnTwo(original, run.id), {
        label: 'both branches to wait',
      });
      await run.signal('one', 'A');
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await waitForCondition(async () => isWaitingOnSignal(restarted, handle!.id, 'two'), {
      label: 'the branch still waiting',
    });
    await handle!.signal('two', 'B');
    expect(await handle!.result()).toEqual({ a: 'A', b: 'B' });
  });

  it('cancels a run that is waiting in a parallel step', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-cancel', [
          parallel({
            a: [{ kind: 'await-signal', signal: 'one' }],
            b: [{ kind: 'await-signal', signal: 'two' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-cancel', null, { id: 'parallel-cancel-run' });
    await waitForCondition(async () => isWaitingOnTwo(engine, run.id), {
      label: 'both branches to wait',
    });
    await engine.cancel(run.id);
    const state = await engine.get(run.id);
    expect(state?.status).toBe('cancelled');
  });

  it('runs a parallel step inside each item of a map', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-in-map', [
          { kind: 'activity', handler: 'list' },
          {
            kind: 'map',
            over: 'items',
            steps: [parallel({ a: [{ kind: 'activity', handler: 'echo', input: 'a' }] })],
          },
        ]),
      ],
    });
    const run = await engine.start('parallel-in-map', null, { id: 'parallel-in-map-run' });
    expect(await run.result()).toEqual([
      { a: { input: 'a', previous: 1 } },
      { a: { input: 'a', previous: 2 } },
    ]);
  });

  it('G19: runs a map inside a branch, each item of a map that waits one after another', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('map-in-parallel', [
          { kind: 'activity', handler: 'list' },
          parallel({
            plain: [
              {
                kind: 'map',
                over: 'items',
                steps: [{ kind: 'activity', handler: 'echo', input: 'x' }],
              },
            ],
          }),
        ]),
        doc('waiting-map-in-parallel', [
          { kind: 'activity', handler: 'list' },
          parallel({
            waits: [
              { kind: 'map', over: 'items', steps: [{ kind: 'await-signal', signal: 'item' }] },
            ],
          }),
        ]),
      ],
    });
    const plain = await engine.start('map-in-parallel', null, { id: 'map-in-parallel-run' });
    expect(await plain.result()).toEqual({
      plain: [
        { input: 'x', previous: 1 },
        { input: 'x', previous: 2 },
      ],
    });

    // A map that waits runs its items one after another, so each wait comes alone.
    const waiting = await engine.start('waiting-map-in-parallel', null, { id: 'waiting-map-run' });
    await waitForCondition(() => isWaitingOnSignal(engine, waiting.id, 'item'), {
      label: 'the first item to wait',
    });
    await waiting.signal('item', 'first');
    await waitForCondition(
      async () => {
        const opened = await signalWaitingEvents(engine, waiting.id);
        return opened.length === 2;
      },
      { label: 'the second item to wait' },
    );
    await waiting.signal('item', 'second');
    expect(await waiting.result()).toEqual({ waits: ['first', 'second'] });
    // Each item waited at its own address.
    const opened = await signalWaitingEvents(engine, waiting.id);
    expect(new Set(opened.map((event) => event.data['stepAddress'])).size).toBe(2);
  });
});

describe('the step addresses of a document with a parallel step', () => {
  /** The (signal, step, address) of every wait a run opened, sorted by signal. */
  async function waitsOf(engine: Engine, id: string) {
    const opened = await signalWaitingEvents(engine, id);
    return opened
      .map((event) => ({
        signal: event.data['signal'],
        step: event.data['step'],
        address: event.data['stepAddress'],
      }))
      .toSorted((left, right) => String(left.signal).localeCompare(String(right.signal)));
  }

  it('G13: keeps every step index and address when the branches are written in another order', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const branches = (names: readonly string[]) =>
      parallel(
        Object.fromEntries(
          names.map((name) => [name, [{ kind: 'await-signal', signal: `wait-${name}` }]]),
        ),
      );
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('addresses-ab', [branches(['a', 'b'])]),
        doc('addresses-ba', [branches(['b', 'a'])]),
      ],
    });
    const seen: unknown[][] = [];
    for (const name of ['addresses-ab', 'addresses-ba']) {
      const run = await engine.start(name, null, { id: `${name}-run` });
      await waitForCondition(() => isWaitingOnTwo(engine, run.id), { label: 'both to wait' });
      seen.push(await waitsOf(engine, run.id));
      await run.signal('wait-a', 1);
      await run.signal('wait-b', 2);
      expect(await run.result()).toEqual({ a: 1, b: 2 });
    }

    expect(seen[0]).toEqual(seen[1]);
    // The addresses are the canonical order's, and differ per branch.
    expect(seen[0]).toEqual([
      expect.objectContaining({ signal: 'wait-a', step: 1 }),
      expect.objectContaining({ signal: 'wait-b', step: 2 }),
    ]);
    const addresses = (seen[0] as { address: unknown }[]).map((entry) => entry.address ?? null);
    expect(new Set(addresses).size).toBe(2);
  });
});

describe('the version of a document with a parallel step', () => {
  it('does not depend on the order the branches are written in', async () => {
    const written = (names: readonly string[]) =>
      validateWorkflowDocument(
        doc('parallel-hash', [
          parallel(
            Object.fromEntries(
              names.map((name) => [name, [{ kind: 'activity', handler: 'seed' }]]),
            ),
          ),
        ]),
        host,
      );
    expect(await workflowDocumentVersion(written(['a', 'b']))).toBe(
      await workflowDocumentVersion(written(['b', 'a'])),
    );
  });
});

describe('a parallel step across restarts (COR-2416)', () => {
  it('resumes a branch after a settled step and a settled sibling, and runs each activity once', async () => {
    // Before, a restart after a settled round recovered with the wrong values: the next round's
    // results were read from the numbers the settled round had used.
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'parallel-resume-run';
    const document = doc('parallel-resume', [
      parallel({
        a: [
          { kind: 'activity', handler: 'count', input: 'a1' },
          { kind: 'await-signal', signal: 'one' },
        ],
        b: [{ kind: 'await-signal', signal: 'two' }],
      }),
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      const run = await original.start('parallel-resume', null, { id });
      await waitUntil(async () => (await waitingCount(original, id)) === 2, {
        message: 'both branches to wait',
      });
      await waitUntil(async () => (await committedSlotStatus(storage, id, 0)) === 'pending', {
        message: 'the first branch`s step to be committed',
      });
      await run.signal('two', 'B');
      await waitUntil(async () => (await committedSlotStatus(storage, id, 1)) === 'fulfilled', {
        message: 'the second branch to be committed',
      });
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => isWaitingOnSignal(restarted, id, 'one'), {
      message: 'the first branch to wait again',
    });
    await handle!.signal('one', 'A');
    expect(await handle!.result()).toEqual({ a: 'A', b: 'B' });
    expect(calls.filter((call) => call === 'a1')).toHaveLength(1);
  });

  it('settles a branch that fails after its siblings settle, and runs the failed activity again after a restart', async () => {
    calls.length = 0;
    const storage = new MemoryStorage();
    const id = 'parallel-failed-branch-run';
    const document = doc('parallel-failed-branch', [
      parallel({
        a: [{ kind: 'activity', handler: 'boomCounted', input: 'boom' }],
        b: [{ kind: 'await-signal', signal: 'two' }],
      }),
      { kind: 'activity', handler: 'after' },
    ]);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('parallel-failed-branch', null, { id });
      await waitUntil(async () => calls.includes('boom'), { message: 'the branch to fail' });
      // A failed branch ends the step only once its siblings settle: the run is still waiting.
      expect(await statusOf(original, id)).toBe('running');
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, host, { active: [document] });
    const [handle] = await restarted.recoverAll();
    await waitUntil(async () => calls.filter((call) => call === 'boom').length === 2, {
      message: 'the failed activity to run again',
    });
    await handle!.signal('two', 'B');
    expect(await throwingRejectionOf(handle!.result())).toThrow('branch exploded');
    expect(calls).not.toContain('after');
  });

  it('refuses a branch that opens a wait on a signal a sibling is already waiting on', async () => {
    // The lockstep rounds never held two such waits at once; branches that advance on their own can.
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [
        doc('parallel-same-signal-later', [
          parallel({
            a: [
              { kind: 'activity', handler: 'seed' },
              { kind: 'await-signal', signal: 'shared' },
            ],
            b: [{ kind: 'await-signal', signal: 'shared' }],
          }),
        ]),
      ],
    });
    const run = await engine.start('parallel-same-signal-later', null, {
      id: 'parallel-same-signal-later-run',
    });
    expect(await throwingRejectionOf(run.result())).toThrow('same signal');
  });

  const orders: readonly [string, readonly [string, string]][] = [
    ['one then two', ['one', 'two']],
    ['two then one', ['two', 'one']],
  ];
  for (const [name, [firstSignal, secondSignal]] of orders) {
    it(`completes with the same result, running each activity once, when the signals come ${name} across a restart`, async () => {
      calls.length = 0;
      const storage = new MemoryStorage();
      const id = `parallel-order-${firstSignal}-run`;
      const document = doc(`parallel-order-${firstSignal}`, [
        parallel({
          a: [
            { kind: 'await-signal', signal: 'one' },
            { kind: 'activity', handler: 'count', input: 'a2' },
          ],
          b: [
            { kind: 'await-signal', signal: 'two' },
            { kind: 'activity', handler: 'count', input: 'b2' },
          ],
        }),
      ]);
      {
        await using original = new Engine({ storage });
        await registerWorkflowDocuments(original, host, { active: [document] });
        const run = await original.start(document.name, null, { id });
        await waitUntil(async () => (await waitingCount(original, id)) === 2, {
          message: 'both branches to wait',
        });
        await run.signal(firstSignal, firstSignal);
        const settledBranch = firstSignal === 'one' ? 0 : 1;
        await waitUntil(
          async () => (await committedSlotStatus(storage, id, settledBranch)) === 'fulfilled',
          { message: 'the first branch to be committed' },
        );
      }
      await using restarted = new Engine({ storage });
      await registerWorkflowDocuments(restarted, host, { active: [document] });
      const [handle] = await restarted.recoverAll();
      await waitUntil(async () => isWaitingOnSignal(restarted, id, secondSignal), {
        message: 'the second branch to wait again',
      });
      await handle!.signal(secondSignal, secondSignal);
      // Each branch's result is the output of its last step, an activity that echoes its input.
      expect(await handle!.result()).toEqual({ a: 'a2', b: 'b2' });
      expect(calls.toSorted()).toEqual(['a2', 'b2']);
    });
  }
});

/**
 * COR-2416 AC6: a run persisted before branches advanced on their own. Each fixture is the storage
 * of a run the previous interpreter left parked, dumped on `main`, loaded into a fresh store and
 * recovered by this one.
 */
async function loadPersistedRun(fixture: string): Promise<MemoryStorage> {
  const entries = (await Bun.file(
    new URL(`./__fixtures__/legacy-parallel/${fixture}.json`, import.meta.url),
  ).json()) as [string, string][];
  const storage = new MemoryStorage();
  for (const [key, encoded] of entries) await storage.put(key, Buffer.from(encoded, 'base64'));
  return storage;
}

describe('a parallel step persisted before branches advanced on their own (COR-2416)', () => {
  it('recovers a run parked in the first round, and commits its finished branch from then on', async () => {
    calls.length = 0;
    const storage = await loadPersistedRun('legacy-round-one');
    const id = 'legacy-round-one-run';
    const document = doc('legacy-round-one', [
      parallel({
        notify: [{ kind: 'activity', handler: 'count', input: 'notify' }],
        review: [{ kind: 'await-signal', signal: 'approve' }],
      }),
      { kind: 'activity', handler: 'after' },
    ]);
    {
      await using recovered = new Engine({ storage });
      await registerWorkflowDocuments(recovered, host, { active: [document] });
      await recovered.recoverAll();
      await waitUntil(async () => isWaitingOnSignal(recovered, id, 'approve'), {
        message: 'the recovered run to wait',
      });
      await waitUntil(async () => hasCommittedSlot(storage, id, 'fulfilled'), {
        message: 'the finished branch to be committed',
      });
    }
    // The previous interpreter ran `notify` before the fixture was taken; this one ran it once for
    // the recovery, and a second restart finds it done.
    expect(calls.filter((call) => call === 'notify')).toHaveLength(1);
    await using again = new Engine({ storage });
    await registerWorkflowDocuments(again, host, { active: [document] });
    const [handle] = await again.recoverAll();
    await waitUntil(async () => isWaitingOnSignal(again, id, 'approve'), {
      message: 'the run to wait again',
    });
    await handle!.signal('approve', 'yes');
    expect(await handle!.result()).toEqual({ notify: 'notify', review: 'yes' });
    expect(calls.filter((call) => call === 'notify')).toHaveLength(1);
  });

  it('finishes a run the previous interpreter left between rounds, on the numbering it began with', async () => {
    // The first round settled and the second is open: its results sit under the shared step
    // numbers of the lockstep rounds, so the step is finished by the lockstep path. (That path
    // reads the second round's results from the numbers the first used, which `main` did too; the
    // step is not a regression, and a run that begins now does not take it.)
    calls.length = 0;
    const storage = await loadPersistedRun('legacy-round-two');
    const id = 'legacy-round-two-run';
    const document = doc('legacy-round-two', [
      parallel({
        a: [
          { kind: 'activity', handler: 'count', input: 'a1' },
          { kind: 'await-signal', signal: 'one' },
        ],
        b: [{ kind: 'await-signal', signal: 'two' }],
      }),
    ]);
    await using recovered = new Engine({ storage });
    await registerWorkflowDocuments(recovered, host, { active: [document] });
    const [handle] = await recovered.recoverAll();
    await waitUntil(async () => isWaitingOnSignal(recovered, id, 'one'), {
      message: 'the recovered run to wait on the second round',
    });
    await handle!.signal('one', 'A');
    await handle!.result();
    expect(await statusOf(recovered, id)).toBe('completed');
  });
});
