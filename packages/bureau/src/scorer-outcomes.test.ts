/**
 * COR-2199: scorers share the validator outcome vocabulary, receive a signal, and map failures to
 * outcomes. One table, one entry per row of the issue's outcome matrix
 * (`tmp/chef/briefs/COR-2199-matrix.md`): a row marked "same" there pins what `main` already did,
 * and every other row asserts the new result.
 *
 * No test here sleeps, counts turns or reads a wall clock. A scorer's 30 second deadline runs on an
 * injected clock whose timers fire only when the test advances it, so no real timer exists, and a
 * wait on the sampler's own progress goes through `waitUntil` or `flush()`.
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import type { PluginScore, PluginScorer } from '@lostgradient/interborough-plugin';
import { type Action, type RunResult, type StallWatchdogClock } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AuditTrail } from './audit-trail';
import type { Bureau } from './bureau-types/facade';
import { ActionEvent } from './events';
import {
  createPluginSecretGate,
  gatedContributions,
  PluginNeedsSetupError,
} from './plugins/plugin-secret-gate';
import { createScorerSampler, type ScorerSampler } from './scorers';
import type { WebhookNotifier } from './webhook-notifier';

// ── Fixtures ─────────────────────────────────────────────────────────

const DEADLINE = 30_000;
const MALFORMED = 'Judge returned a malformed score';
const DEADLINE_MESSAGE = 'Judge exceeded its deadline of 30000 milliseconds';

/** A clock whose timers fire only when the test advances it. */
function deadlineClock(): StallWatchdogClock & {
  advance(milliseconds: number): void;
  pending(): number;
} {
  let time = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback, milliseconds) {
      const handle = nextHandle++;
      timers.set(handle, { at: time + milliseconds, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const [handle, timer] of [...timers].toSorted((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

interface AuditEntry {
  runId: string;
  type: string;
  detail: Record<string, unknown>;
}

interface Alert {
  runId: string;
  subjectId: string;
  trigger: string;
  detail: Record<string, unknown>;
}

function stubBureau(): { bureau: Bureau; emit: (action: Action) => void } {
  const listeners = new Set<(event: ActionEvent) => void>();
  const bureau = {
    addEventListener(_type: string, listener: (event: ActionEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: ActionEvent) => void) {
      listeners.delete(listener);
    },
  } as unknown as Bureau;
  return {
    bureau,
    emit(action) {
      const event = new ActionEvent(action);
      for (const listener of listeners) listener(event);
    },
  };
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content: 'the final answer',
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'stop',
    ...overrides,
  } as RunResult;
}

interface Harness {
  readonly sampler: ScorerSampler;
  readonly clock: ReturnType<typeof deadlineClock>;
  readonly owner: AbortController;
  readonly records: AuditEntry[];
  readonly alerts: Alert[];
  /** Emits a `run.completed` action. */
  complete(runId?: string, detail?: unknown): void;
}

interface HarnessOptions {
  readonly list: PluginScorer[];
  readonly ownerSignal?: boolean;
  readonly notifier?: boolean;
  readonly auditTrail?: AuditTrail;
  readonly rng?: () => number;
  readonly bureau?: ReturnType<typeof stubBureau>;
  readonly records?: AuditEntry[];
  readonly clock?: ReturnType<typeof deadlineClock>;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  // Ending the owner's signal first lets a scorer a test left hanging settle, so dispose() returns.
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function harness(options: HarnessOptions): Harness {
  const { bureau, emit } = options.bureau ?? stubBureau();
  const clock = options.clock ?? deadlineClock();
  const owner = new AbortController();
  const records = options.records ?? [];
  const alerts: Alert[] = [];
  const auditTrail: AuditTrail = options.auditTrail ?? {
    async record(entry) {
      records.push(entry as AuditEntry);
    },
    async query() {
      throw new Error('the sampler never reads the audit trail back');
    },
    async prune() {
      return undefined;
    },
    async redact() {
      return 0;
    },
    async dispose() {},
  };
  const webhookNotifier =
    options.notifier === false
      ? undefined
      : ({
          notify(input: Alert) {
            alerts.push(input);
          },
        } as unknown as WebhookNotifier);
  const sampler = createScorerSampler(bureau, auditTrail, webhookNotifier, {
    list: options.list,
    sampleRate: 1,
    rng: options.rng ?? (() => 0),
    ...(options.ownerSignal === false ? {} : { signal: owner.signal }),
    clock,
  });
  cleanups.push(async () => {
    owner.abort(new Error('test cleanup'));
    await sampler.dispose();
  });
  return {
    sampler,
    clock,
    owner,
    records,
    alerts,
    complete(runId = 'run-1', detail = runResult()) {
      emit({ sequence: 1, type: 'run.completed', runId, detail, timestamp: 1_000 });
    },
  };
}

/** A scorer that returns `value` as it stands, malformed or not. */
function returning(value: unknown, extras: Partial<PluginScorer> = {}): PluginScorer {
  return { name: 'judge', version: '1.0.0', ...extras, score: () => value as PluginScore };
}

/** A scorer a test settles by hand, and that records the signal it was given on each call. */
function controlled(name = 'controlled'): {
  scorer: PluginScorer;
  calls: () => number;
  signals: AbortSignal[];
  runs: RunResult[];
  resolve(value: PluginScore): void;
  reject(error: unknown): void;
} {
  const signals: AbortSignal[] = [];
  const runs: RunResult[] = [];
  const settlers: { resolve(value: PluginScore): void; reject(error: unknown): void }[] = [];
  const scorer: PluginScorer = {
    name,
    version: '1.0.0',
    score: (run, signal) => {
      runs.push(run);
      signals.push(signal);
      return new Promise<PluginScore>((resolve, reject) => {
        settlers.push({ resolve, reject });
      });
    },
  };
  return {
    scorer,
    calls: () => signals.length,
    signals,
    runs,
    resolve: (value) => settlers.at(-1)?.resolve(value),
    reject: (error) => settlers.at(-1)?.reject(error),
  };
}

function passing(name: string): PluginScorer {
  return { name, version: '1.0.0', score: () => ({ outcome: 'pass', message: `${name} passed` }) };
}

function digestOf(name: string, version: string): string {
  return sha256HexSync(JSON.stringify({ identity: { name, version } }));
}

function detailOf(harnessUnderTest: Harness, index = 0): Record<string, unknown> {
  const record = harnessUnderTest.records[index];
  if (record === undefined) throw new Error(`no audit record at ${index}`);
  return record.detail;
}

// ── The matrix ───────────────────────────────────────────────────────

interface Row {
  readonly row: number;
  readonly title: string;
  readonly run: () => Promise<void>;
}

const rows: Row[] = [];
function row(number: number, title: string, run: () => Promise<void>): void {
  rows.push({ row: number, title, run });
}

const OUTCOMES: readonly PluginScore['outcome'][] = [
  'pass',
  'fail',
  'error',
  'unavailable',
  'canceled',
  'indeterminate',
];

// Rows 1-9: what a returned score records and when it alerts.

row(1, 'pass with no score records outcome and message only, and does not alert', async () => {
  const h = harness({ list: [returning({ outcome: 'pass', message: 'matched' })] });
  h.complete();
  await h.sampler.flush();
  expect(h.records[0]?.type).toBe('eval.sample.recorded');
  expect(h.records[0]?.runId).toBe('run-1');
  expect(detailOf(h)).toEqual({
    judgeName: 'judge',
    judgeVersion: '1.0.0',
    judgeDigest: digestOf('judge', '1.0.0'),
    outcome: 'pass',
    message: 'matched',
  });
  expect(Object.hasOwn(detailOf(h), 'pass')).toBe(false);
  expect(Object.hasOwn(detailOf(h), 'score')).toBe(false);
  expect(h.alerts).toHaveLength(0);
});

row(2, 'pass with a score at the threshold does not alert', async () => {
  const h = harness({
    list: [returning({ outcome: 'pass', message: 'fine', score: 0.5 }, { alertThreshold: 0.5 })],
  });
  h.complete();
  await h.sampler.flush();
  expect(detailOf(h)['score']).toBe(0.5);
  expect(h.alerts).toHaveLength(0);
});

row(3, 'pass with a score below the threshold alerts with outcome and digest', async () => {
  const h = harness({
    list: [
      returning(
        { outcome: 'pass', message: 'quality dropped', score: 0.2 },
        { name: 'quality-judge', alertThreshold: 0.5 },
      ),
    ],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.alerts).toHaveLength(1);
  expect(h.alerts[0]?.detail).toEqual({
    judgeName: 'quality-judge',
    judgeVersion: '1.0.0',
    judgeDigest: digestOf('quality-judge', '1.0.0'),
    outcome: 'pass',
    score: 0.2,
    threshold: 0.5,
  });
  expect(Object.hasOwn(h.alerts[0]!.detail, 'message')).toBe(false);
});

row(4, 'fail with no threshold alerts', async () => {
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'did not match', score: 0.9 })],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.alerts).toHaveLength(1);
  expect(h.alerts[0]?.trigger).toBe('eval.threshold-breached');
});

row(5, 'fail with a score at or above the threshold still alerts', async () => {
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'no', score: 0.9 }, { alertThreshold: 0.5 })],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.alerts).toHaveLength(1);
});

row(6, 'fail with no score alerts and leaves the score out of the alert', async () => {
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'no' }, { alertThreshold: 0.5 })],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.alerts).toHaveLength(1);
  expect(Object.hasOwn(h.alerts[0]!.detail, 'score')).toBe(false);
  expect(h.alerts[0]?.detail['outcome']).toBe('fail');
});

for (const outcome of ['error', 'unavailable', 'canceled', 'indeterminate'] as const) {
  row(7, `${outcome} with no score is recorded as ${outcome} and does not alert`, async () => {
    const h = harness({ list: [returning({ outcome, message: `scorer says ${outcome}` })] });
    h.complete();
    await h.sampler.flush();
    expect(detailOf(h)['outcome']).toBe(outcome);
    expect(detailOf(h)['message']).toBe(`scorer says ${outcome}`);
    expect(h.alerts).toHaveLength(0);
  });
}

for (const outcome of OUTCOMES) {
  row(8, `${outcome} with a score below the threshold alerts`, async () => {
    const h = harness({
      list: [returning({ outcome, message: 'low', score: 0.1 }, { alertThreshold: 0.5 })],
    });
    h.complete();
    await h.sampler.flush();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.detail['outcome']).toBe(outcome);
  });
}

row(9, 'a score with no threshold alerts only on fail', async () => {
  const h = harness({
    list: [
      returning({ outcome: 'pass', message: 'low but passing', score: 0.1 }, { name: 'a' }),
      returning({ outcome: 'error', message: 'broke', score: 0 }, { name: 'b' }),
      returning({ outcome: 'fail', message: 'failed', score: 1 }, { name: 'c' }),
    ],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.records).toHaveLength(3);
  expect(h.alerts.map((alert) => alert.detail['judgeName'])).toEqual(['c']);
});

// Rows 10-12: a throw and a plugin that needs setup.

row(
  10,
  'a scorer that throws or rejects records error, with no score, and does not alert',
  async () => {
    const h = harness({
      list: [
        {
          name: 'sync',
          version: '1.0.0',
          score: () => {
            throw new Error('judge exploded');
          },
        },
        {
          name: 'async',
          version: '1.0.0',
          score: async () => Promise.reject(new Error('rejected')),
        },
        { name: 'odd', version: '1.0.0', score: () => Promise.reject('a string') },
      ],
    });
    h.complete();
    await h.sampler.flush();
    expect(h.records).toHaveLength(3);
    expect(h.records.map((record) => record.detail['outcome'])).toEqual([
      'error',
      'error',
      'error',
    ]);
    expect(h.records.map((record) => record.detail['message'])).toEqual([
      'Judge threw: judge exploded',
      'Judge threw: rejected',
      'Judge threw: a string',
    ]);
    for (const record of h.records) expect(Object.hasOwn(record.detail, 'score')).toBe(false);
    expect(h.alerts).toHaveLength(0);
  },
);

row(
  11,
  'a scorer of a plugin that needs setup records unavailable through the real gate',
  async () => {
    let secret: string | undefined;
    const gate = await createPluginSecretGate('kit', ['KIT_KEY'], {
      get: async () => secret,
      watch: () => () => undefined,
    });
    let ran = 0;
    const gated = gatedContributions(
      {
        scorers: [
          {
            name: 'judge',
            version: '1',
            score: () => {
              ran += 1;
              return { outcome: 'pass' as const, message: 'ran' };
            },
          },
        ],
      },
      gate,
      (name) => `kit:${name}`,
      () => undefined,
    );
    const h = harness({ list: gated.scorers ?? [] });
    h.complete();
    await h.sampler.flush();
    expect(ran).toBe(0);
    expect(detailOf(h)['outcome']).toBe('unavailable');
    expect(detailOf(h)['message']).toBe(
      '"kit:judge" is not available: plugin "kit" needs setup, because the secret "KIT_KEY" is not set.',
    );
    expect(Object.hasOwn(detailOf(h), 'score')).toBe(false);
    expect(h.alerts).toHaveLength(0);

    // Once the secret is set the same scorer runs.
    secret = 'value';
    const ready = await createPluginSecretGate('kit', ['KIT_KEY'], {
      get: async () => secret,
      watch: () => () => undefined,
    });
    const available = gatedContributions(
      {
        scorers: [
          { name: 'judge', version: '1', score: () => ({ outcome: 'pass', message: 'ran' }) },
        ],
      },
      ready,
      (name) => `kit:${name}`,
      () => undefined,
    );
    const second = harness({ list: available.scorers ?? [] });
    second.complete();
    await second.sampler.flush();
    expect(detailOf(second)['outcome']).toBe('pass');
  },
);

row(12, 'the gate table names score and the unavailable record, not evaluate', async () => {
  const source = readFileSync(resolve(import.meta.dir, 'plugins/plugin-secret-gate.ts'), 'utf8');
  const scorerRow = source.split('\n').find((line) => line.startsWith(' * | scorer ('));
  expect(scorerRow).toContain('scorer (`score`)');
  expect(scorerRow).toContain('unavailable');
  expect(scorerRow).not.toContain('evaluate');
});

// Rows 13-23: the signal, the deadline and shutdown.

row(
  13,
  'a scorer still running at 30,000 milliseconds is canceled and the next scorer runs',
  async () => {
    const hung = controlled('hung');
    const h = harness({ list: [hung.scorer, passing('second')] });
    h.complete();
    await waitUntil(() => hung.calls() === 1, { message: 'the scorer to start' });
    expect(h.clock.pending()).toBe(1);

    h.clock.advance(DEADLINE - 1);
    expect(hung.signals[0]?.aborted).toBe(false);
    expect(h.records).toHaveLength(0);

    h.clock.advance(1);
    expect(hung.signals[0]?.aborted).toBe(true);
    expect((hung.signals[0]!.reason as Error).name).toBe('TimeoutError');
    await h.sampler.flush();

    expect(h.records.map((record) => record.detail['judgeName'])).toEqual(['hung', 'second']);
    expect(detailOf(h)).toEqual({
      judgeName: 'hung',
      judgeVersion: '1.0.0',
      judgeDigest: digestOf('hung', '1.0.0'),
      outcome: 'canceled',
      message: DEADLINE_MESSAGE,
    });
    expect(detailOf(h, 1)['outcome']).toBe('pass');
    expect(h.alerts).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
  },
);

row(
  14,
  'a scorer that ignores its signal is abandoned at the deadline and its late result discarded',
  async () => {
    const stubborn = controlled('stubborn');
    const h = harness({ list: [stubborn.scorer, passing('after')] });
    h.complete();
    await waitUntil(() => stubborn.calls() === 1, { message: 'the scorer to start' });
    h.clock.advance(DEADLINE);
    await h.sampler.flush();
    expect(h.records.map((record) => record.detail['outcome'])).toEqual(['canceled', 'pass']);

    stubborn.resolve({ outcome: 'fail', message: 'too late', score: 0 });
    await h.sampler.flush();
    expect(h.records).toHaveLength(2);
    expect(h.alerts).toHaveLength(0);
    await h.sampler.dispose();
  },
);

row(15, 'a scorer that rejects once the deadline fired is canceled, not an error', async () => {
  for (const reaction of ['reason', 'plain-error'] as const) {
    const h = harness({
      list: [
        {
          name: 'cooperative',
          version: '1.0.0',
          score: (_run, signal) =>
            new Promise<PluginScore>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(reaction === 'reason' ? signal.reason : new Error('stopped')),
                { once: true },
              );
            }),
        },
      ],
    });
    h.complete();
    await waitUntil(() => h.clock.pending() === 1, { message: 'the deadline to be armed' });
    h.clock.advance(DEADLINE);
    await h.sampler.flush();
    expect(detailOf(h)['outcome']).toBe('canceled');
    expect(detailOf(h)['message']).toBe(DEADLINE_MESSAGE);
    expect(h.alerts).toHaveLength(0);
  }
});

row(
  16,
  'a scorer that settles before the deadline is recorded and the deadline never fires later',
  async () => {
    const quick = controlled('quick');
    const h = harness({ list: [quick.scorer], ownerSignal: false });
    h.complete();
    await waitUntil(() => quick.calls() === 1, { message: 'the scorer to start' });
    expect(quick.signals[0]?.aborted).toBe(false);
    quick.resolve({ outcome: 'pass', message: 'in time', score: 0.8 });
    await h.sampler.flush();
    expect(detailOf(h)['outcome']).toBe('pass');
    expect(h.clock.pending()).toBe(0);

    h.clock.advance(DEADLINE * 2);
    expect(quick.signals[0]?.aborted).toBe(false);
    expect(h.records).toHaveLength(1);
  },
);

row(
  17,
  'the deadline and the scorer settling in the same turn record exactly one outcome',
  async () => {
    const racing = controlled('racing');
    const h = harness({ list: [racing.scorer] });
    h.complete();
    await waitUntil(() => racing.calls() === 1, { message: 'the scorer to start' });
    racing.resolve({ outcome: 'pass', message: 'just in time' });
    h.clock.advance(DEADLINE);
    await h.sampler.flush();
    expect(h.records).toHaveLength(1);
    expect(['pass', 'canceled']).toContain(detailOf(h)['outcome'] as string);
    expect(h.alerts).toHaveLength(0);
  },
);

row(
  18,
  'an owner abort mid-scoring aborts the scorer signal, records nothing and skips later scorers',
  async () => {
    const running = controlled('running');
    let secondCalled = false;
    const h = harness({
      list: [
        running.scorer,
        {
          name: 'second',
          version: '1.0.0',
          score: () => {
            secondCalled = true;
            return { outcome: 'pass', message: '' };
          },
        },
      ],
    });
    h.complete();
    await waitUntil(() => running.calls() === 1, { message: 'the scorer to start' });
    expect(running.signals[0]?.aborted).toBe(false);
    h.owner.abort(new Error('shutting down'));
    expect(running.signals[0]?.aborted).toBe(true);
    expect((running.signals[0]!.reason as Error).message).toBe('shutting down');
    await h.sampler.flush();
    expect(secondCalled).toBe(false);
    expect(h.records).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);

    // The abandoned scorer settling later does not resurrect the evaluation.
    running.resolve({ outcome: 'fail', message: 'late', score: 0 });
    await h.sampler.flush();
    expect(h.records).toHaveLength(0);
    expect(h.alerts).toHaveLength(0);
  },
);

row(
  19,
  'an owner abort and the deadline in the same turn record nothing, in either order',
  async () => {
    for (const order of ['owner-first', 'deadline-first'] as const) {
      const hung = controlled('hung');
      const h = harness({ list: [hung.scorer] });
      h.complete();
      await waitUntil(() => hung.calls() === 1, { message: 'the scorer to start' });
      if (order === 'owner-first') {
        h.owner.abort(new Error('shutdown'));
        h.clock.advance(DEADLINE);
      } else {
        h.clock.advance(DEADLINE);
        h.owner.abort(new Error('shutdown'));
      }
      await h.sampler.flush();
      expect(h.records).toHaveLength(0);
      expect(h.alerts).toHaveLength(0);
    }
  },
);

row(20, 'an owner abort while the audit write is in flight suppresses the alert', async () => {
  let release: (() => void) | undefined;
  const written: AuditEntry[] = [];
  const auditTrail: AuditTrail = {
    record(entry) {
      written.push(entry as AuditEntry);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async query() {
      return [];
    },
    async prune() {
      return undefined;
    },
    async redact() {
      return 0;
    },
    async dispose() {},
  };
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'breach' })],
    auditTrail,
  });
  h.complete();
  await waitUntil(() => written.length === 1, { message: 'the audit write to start' });
  h.owner.abort(new Error('shutting down mid audit write'));
  release?.();
  await h.sampler.flush();
  expect(h.alerts).toHaveLength(0);
});

row(21, 'a signal already aborted when evaluation starts never invokes the scorer', async () => {
  let invoked = false;
  const h = harness({
    list: [
      {
        name: 'tracked',
        version: '1.0.0',
        score: () => {
          invoked = true;
          return { outcome: 'pass', message: '' };
        },
      },
    ],
  });
  h.owner.abort(new Error('before evaluation'));
  h.complete();
  await h.sampler.flush();
  expect(invoked).toBe(false);
  expect(h.records).toHaveLength(0);
  expect(h.clock.pending()).toBe(0);
});

row(
  22,
  'a scorer that aborts the owner signal as a side effect settles at once with no record',
  async () => {
    const owner = new AbortController();
    const bureau = stubBureau();
    const records: AuditEntry[] = [];
    const clock = deadlineClock();
    const auditTrail: AuditTrail = {
      async record(entry) {
        records.push(entry as AuditEntry);
      },
      async query() {
        return [];
      },
      async prune() {
        return undefined;
      },
      async redact() {
        return 0;
      },
      async dispose() {},
    };
    const sampler = createScorerSampler(bureau.bureau, auditTrail, undefined, {
      list: [
        {
          name: 'self-aborting',
          version: '1.0.0',
          score: () => {
            owner.abort(new Error('aborted by the scorer itself'));
            return new Promise<PluginScore>(() => {});
          },
        },
      ],
      sampleRate: 1,
      rng: () => 0,
      signal: owner.signal,
      clock,
    });
    cleanups.push(() => sampler.dispose());
    bureau.emit({
      sequence: 1,
      type: 'run.completed',
      runId: 'run-1',
      detail: runResult(),
      timestamp: 1,
    });
    await sampler.flush();
    expect(records).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  },
);

row(
  23,
  'dispose() awaits scoring in flight, and a hung scorer holds it only until its deadline',
  async () => {
    // A scorer that settles while dispose() waits is recorded before dispose() resolves.
    const settling = controlled('settling');
    const h = harness({ list: [settling.scorer] });
    h.complete();
    await waitUntil(() => settling.calls() === 1, { message: 'the scorer to start' });
    const disposed = h.sampler.dispose();
    settling.resolve({ outcome: 'pass', message: 'released' });
    await disposed;
    expect(h.records).toHaveLength(1);

    // A scorer that never settles and ignores the signal ends at its deadline, not never.
    const hung = controlled('hung');
    const second = harness({ list: [hung.scorer], ownerSignal: false });
    second.complete();
    await waitUntil(() => hung.calls() === 1, { message: 'the scorer to start' });
    const secondDisposed = second.sampler.dispose();
    second.clock.advance(DEADLINE);
    await secondDisposed;
    expect(detailOf(second)['outcome']).toBe('canceled');
  },
);

row(24, 'records written before this change are never read or migrated', async () => {
  // The harness's audit trail throws from `query`: a sample that reads any record back fails.
  const h = harness({ list: [passing('judge')] });
  h.complete();
  await h.sampler.flush();
  expect(h.records).toHaveLength(1);
});

// Rows 25-28: a malformed return.

const MALFORMED_RETURNS: readonly [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'pass'],
  ['a number', 1],
  ['an array', []],
  ['an object with no outcome', { message: 'x' }],
  ['a legacy pass/score return', { pass: true, score: 1, message: 'legacy' }],
  ['an unknown outcome', { outcome: 'passed', message: 'x' }],
  ['an empty outcome', { outcome: '', message: 'x' }],
  ['an outcome named for an object member', { outcome: 'constructor', message: 'x' }],
  ['a non-string outcome', { outcome: 1, message: 'x' }],
  ['a missing message', { outcome: 'pass' }],
  ['a null message', { outcome: 'pass', message: null }],
  ['a numeric message', { outcome: 'pass', message: 42 }],
  ['a NaN score', { outcome: 'pass', message: 'x', score: Number.NaN }],
  ['an infinite score', { outcome: 'pass', message: 'x', score: Number.POSITIVE_INFINITY }],
  ['a negative score', { outcome: 'pass', message: 'x', score: -0.1 }],
  ['a score above one', { outcome: 'pass', message: 'x', score: 1.1 }],
  ['a string score', { outcome: 'pass', message: 'x', score: '0.5' }],
  ['a null score', { outcome: 'pass', message: 'x', score: null }],
];

const malformedRows: ReadonlyMap<string, number> = new Map([
  ['null', 25],
  ['undefined', 25],
  ['a string', 25],
  ['a number', 25],
  ['an array', 25],
  ['an object with no outcome', 27],
  ['a legacy pass/score return', 28],
  ['an unknown outcome', 27],
  ['an empty outcome', 27],
  ['an outcome named for an object member', 27],
  ['a non-string outcome', 27],
  ['a missing message', 27],
  ['a null message', 27],
  ['a numeric message', 27],
  ['a NaN score', 26],
  ['an infinite score', 26],
  ['a negative score', 26],
  ['a score above one', 26],
  ['a string score', 26],
  ['a null score', 26],
]);

for (const [title, value] of MALFORMED_RETURNS) {
  row(
    malformedRows.get(title) ?? 25,
    `${title} records error "${MALFORMED}", no score, no alert, and scoring moves on`,
    async () => {
      const h = harness({
        list: [returning(value, { name: 'malformed', alertThreshold: 0.5 }), passing('next')],
      });
      h.complete();
      await h.sampler.flush();
      expect(h.records).toHaveLength(2);
      expect(detailOf(h)).toEqual({
        judgeName: 'malformed',
        judgeVersion: '1.0.0',
        judgeDigest: digestOf('malformed', '1.0.0'),
        outcome: 'error',
        message: MALFORMED,
      });
      expect(detailOf(h, 1)['outcome']).toBe('pass');
      expect(h.alerts).toHaveLength(0);
    },
  );
}

row(26, 'a score of exactly 0 or 1 is well formed and recorded as returned', async () => {
  const h = harness({
    list: [
      returning({ outcome: 'pass', message: 'top', score: 1 }, { name: 'one' }),
      returning({ outcome: 'indeterminate', message: 'bottom', score: 0 }, { name: 'zero' }),
    ],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.records.map((record) => record.detail['score'])).toEqual([1, 0]);
  expect(h.records.map((record) => record.detail['outcome'])).toEqual(['pass', 'indeterminate']);
});

// Rows 29-39: the run, and sampling.

row(29, 'a run the RNG roll skips is observed and not sampled', async () => {
  // `harness` samples every run at rate 1, so build a half-rate sampler by hand.
  const bureau = stubBureau();
  const records: AuditEntry[] = [];
  const sampler = createScorerSampler(
    bureau.bureau,
    {
      async record(entry: unknown) {
        records.push(entry as AuditEntry);
      },
    } as unknown as AuditTrail,
    undefined,
    { list: [passing('judge')], sampleRate: 0.5, rng: () => 0.9, clock: deadlineClock() },
  );
  cleanups.push(() => sampler.dispose());
  bureau.emit({
    sequence: 1,
    type: 'run.completed',
    runId: 'run-1',
    detail: runResult(),
    timestamp: 1,
  });
  await sampler.flush();
  expect(sampler.observedCount()).toBe(1);
  expect(sampler.sampledCount()).toBe(0);
  expect(records).toHaveLength(0);
});

row(30, 'a detail that is not a RunResult is skipped', async () => {
  const h = harness({ list: [passing('judge')] });
  h.complete('run-1', { not: 'a run result' });
  await h.sampler.flush();
  expect(h.sampler.observedCount()).toBe(1);
  expect(h.sampler.sampledCount()).toBe(0);
  expect(h.records).toHaveLength(0);
});

row(31, 'a run that ends in error or tripwire is scored like any run.completed', async () => {
  const h = harness({ list: [passing('judge')] });
  h.complete('run-error', runResult({ finishReason: 'error' as never }));
  h.complete('run-tripwire', runResult({ finishReason: 'tripwire' as never }));
  await h.sampler.flush();
  expect(h.records.map((record) => record.runId)).toEqual(['run-error', 'run-tripwire']);
});

row(32, 'a run.aborted action is not sampled', async () => {
  const bureau = stubBureau();
  const h = harness({ list: [passing('judge')], bureau });
  bureau.emit({
    sequence: 1,
    type: 'run.aborted',
    runId: 'run-1',
    detail: runResult(),
    timestamp: 1,
  });
  await h.sampler.flush();
  expect(h.sampler.observedCount()).toBe(0);
  expect(h.records).toHaveLength(0);
});

row(33, 'a run.completed dispatched twice is scored once', async () => {
  const h = harness({ list: [passing('judge')] });
  h.complete('run-1');
  h.complete('run-1');
  await h.sampler.flush();
  expect(h.sampler.observedCount()).toBe(1);
  expect(h.records).toHaveLength(1);
});

row(
  34,
  'scoring goes on after the run settles, and each scorer has its own 30 second deadline',
  async () => {
    const first = controlled('first');
    const second = controlled('second');
    const h = harness({ list: [first.scorer, second.scorer] });
    h.complete('run-7');
    await waitUntil(() => first.calls() === 1, { message: 'the first scorer to start' });
    h.clock.advance(DEADLINE - 10_000);
    first.resolve({ outcome: 'pass', message: 'first' });
    await waitUntil(() => second.calls() === 1, { message: 'the second scorer to start' });

    // The second scorer started 20,000 milliseconds into the first's window; its own clock starts there.
    h.clock.advance(DEADLINE - 1);
    expect(second.signals[0]?.aborted).toBe(false);
    h.clock.advance(1);
    expect(second.signals[0]?.aborted).toBe(true);
    await h.sampler.flush();
    expect(h.records.map((record) => record.runId)).toEqual(['run-7', 'run-7']);
    expect(h.records.map((record) => record.detail['outcome'])).toEqual(['pass', 'canceled']);
  },
);

row(
  35,
  'the scorer receives the sampler own RunResult, so retention cannot take it away',
  async () => {
    const seen = controlled('seen');
    const h = harness({ list: [seen.scorer] });
    const detail = runResult();
    h.complete('run-1', detail);
    await waitUntil(() => seen.calls() === 1, { message: 'the scorer to start' });
    expect(seen.runs[0]).toBe(detail);
    seen.resolve({ outcome: 'pass', message: 'ok' });
    await h.sampler.flush();
    expect(h.records[0]?.runId).toBe('run-1');
  },
);

row(36, 'error, unavailable and canceled each move on to the next scorer', async () => {
  const hung = controlled('hung');
  const h = harness({
    list: [
      {
        name: 'throws',
        version: '1.0.0',
        score: () => {
          throw new Error('boom');
        },
      },
      hung.scorer,
      {
        name: 'setup',
        version: '1.0.0',
        score: () => {
          throw new PluginNeedsSetupError('kit', 'kit:setup', ['KEY']);
        },
      },
      passing('last'),
    ],
  });
  h.complete();
  await waitUntil(() => hung.calls() === 1, { message: 'the second scorer to start' });
  h.clock.advance(DEADLINE);
  await h.sampler.flush();
  expect(h.records.map((record) => record.detail['judgeName'])).toEqual([
    'throws',
    'hung',
    'setup',
    'last',
  ]);
  expect(h.records.map((record) => record.detail['outcome'])).toEqual([
    'error',
    'canceled',
    'unavailable',
    'pass',
  ]);
  expect(h.alerts).toHaveLength(0);
});

row(37, 'a run reattached after a restart is scored by the new sampler', async () => {
  const records: AuditEntry[] = [];
  const restarted = harness({ list: [passing('judge')], records });
  restarted.complete('recovered-run');
  await restarted.sampler.flush();
  expect(records.map((record) => record.runId)).toEqual(['recovered-run']);
});

row(38, 'scoring in flight when the process dies leaves no record and no canceled', async () => {
  const records: AuditEntry[] = [];
  const hung = controlled('hung');
  const before = harness({ list: [hung.scorer], records });
  before.complete('run-1');
  await waitUntil(() => hung.calls() === 1, { message: 'the scorer to start' });

  // The process dies: nothing replays the evaluation, and nothing wrote a record for it.
  const after = harness({ list: [passing('judge')], records });
  await after.sampler.flush();
  expect(records).toHaveLength(0);
  before.owner.abort(new Error('the process is gone'));
  await before.sampler.flush();
  expect(records).toHaveLength(0);
});

row(39, 'the once-per-run guard is in memory: a new sampler scores a run again', async () => {
  const records: AuditEntry[] = [];
  const first = harness({ list: [passing('judge')], records });
  first.complete('run-1');
  await first.sampler.flush();
  const second = harness({ list: [passing('judge')], records });
  second.complete('run-1');
  await second.sampler.flush();
  expect(records).toHaveLength(2);
});

// Rows 40-44: what the record and the alert carry.

row(
  40,
  'a declared determinism is recorded, and absent when undeclared or not one of the two',
  async () => {
    const h = harness({
      list: [
        returning({ outcome: 'pass', message: 'a' }, { name: 'a', determinism: 'deterministic' }),
        returning({ outcome: 'pass', message: 'b' }, { name: 'b', determinism: 'stochastic' }),
        returning({ outcome: 'pass', message: 'c' }, { name: 'c' }),
        returning({ outcome: 'pass', message: 'd' }, { name: 'd', determinism: 'random' as never }),
      ],
    });
    h.complete();
    await h.sampler.flush();
    expect(detailOf(h, 0)['determinism']).toBe('deterministic');
    expect(detailOf(h, 1)['determinism']).toBe('stochastic');
    expect(Object.hasOwn(detailOf(h, 2), 'determinism')).toBe(false);
    expect(Object.hasOwn(detailOf(h, 3), 'determinism')).toBe(false);
  },
);

row(
  41,
  'the digest is the host hash of the name and version, whatever the plugin supplies',
  async () => {
    const h = harness({
      list: [
        returning({ outcome: 'pass', message: 'ok', judgeDigest: 'from-the-result' }, {
          name: 'kit:judge',
          version: '3.2.1',
          judgeDigest: 'from-the-plugin',
          digest: 'x',
        } as never),
      ],
    });
    h.complete();
    await h.sampler.flush();
    expect(detailOf(h)['judgeDigest']).toBe(digestOf('kit:judge', '3.2.1'));
    expect(detailOf(h)['judgeDigest']).toBe(
      sha256HexSync(JSON.stringify({ identity: { name: 'kit:judge', version: '3.2.1' } })),
    );
    expect(Object.keys(detailOf(h)).toSorted()).toEqual(
      ['judgeDigest', 'judgeName', 'judgeVersion', 'message', 'outcome'].toSorted(),
    );
  },
);

row(42, 'the alert carries the outcome and digest and no score when there is none', async () => {
  const h = harness({
    list: [
      returning(
        { outcome: 'fail', message: 'broken' },
        { name: 'judge', determinism: 'stochastic' },
      ),
    ],
  });
  h.complete();
  await h.sampler.flush();
  expect(Object.keys(h.alerts[0]!.detail).toSorted()).toEqual(
    ['judgeDigest', 'judgeName', 'judgeVersion', 'outcome', 'threshold'].toSorted(),
  );
});

row(43, 'the alert subject id is unchanged', async () => {
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'no' }, { name: 'quality-judge' })],
  });
  h.complete();
  await h.sampler.flush();
  expect(h.alerts[0]?.subjectId).toBe('eval:run-1:quality-judge@1.0.0');
  expect(h.alerts[0]?.runId).toBe('run-1');
});

row(44, 'a breach with no notifier is recorded and not delivered', async () => {
  const h = harness({
    list: [returning({ outcome: 'fail', message: 'bad', score: 0.1 }, { alertThreshold: 0.5 })],
    notifier: false,
  });
  h.complete();
  await h.sampler.flush();
  expect(h.records).toHaveLength(1);
  expect(h.alerts).toHaveLength(0);
});

// Rows 45-46: the contract and the stale names.

row(
  45,
  'the contract is score(run, signal) returning an outcome, checked by the compiler',
  async () => {
    const scorer = {
      name: 'judge',
      version: '1',
      score: (_run: RunResult, _signal: AbortSignal): PluginScore => ({
        outcome: 'pass',
        message: '',
      }),
    } satisfies PluginScorer;
    expect(Object.hasOwn(scorer, 'evaluate')).toBe(false);
    expect(typeof scorer.score).toBe('function');
  },
);

row(46, 'no source names a helper that does not exist', async () => {
  const stale = [['match', 'CustomAssertion'].join(''), ['create', 'LLMJudge'].join('')];
  const files = [
    resolve(import.meta.dir, 'scorers.ts'),
    resolve(import.meta.dir, 'plugins/plugin-secret-gate.ts'),
    resolve(import.meta.dir, '../../interborough-plugin/src/scorer.ts'),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const name of stale) expect(source).not.toContain(name);
  }
});

describe('COR-2199 outcome matrix', () => {
  for (const entry of rows) {
    it(`row ${entry.row}: ${entry.title}`, entry.run);
  }

  it('has at least one test for every row of the matrix', () => {
    const covered = new Set(rows.map((entry) => entry.row));
    for (let number = 1; number <= 46; number += 1) expect(covered.has(number)).toBe(true);
    expect([...covered].every((number) => number >= 1 && number <= 46)).toBe(true);
  });
});
