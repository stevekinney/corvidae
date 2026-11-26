/**
 * COR-2185 and COR-2186 — what governed memory does when its active embedder fails: every failure
 * crossed with every gate that embeds. Each row is a test below; the columns say what `main` did,
 * what COR-2185 (every embed is bounded and cancellable) requires, and what COR-2186 (an outage
 * degrades admission and recall) requires on top of it.
 *
 * "hangs" is a promise that never settles: the embedder ignores its signal, so the bound is the
 * only thing that ends the wait. Time is driven by hand (`runtime.advance`), never by a deadline.
 *
 * | Gate      | Failure         | main                                  | COR-2185                                  | COR-2186                                       |
 * | --------- | --------------- | ------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
 * | admission | throws          | the write rejects with the error      | same                                      | `admitted`, queued; a later advance embeds it  |
 * | admission | times out       | the write hangs                       | rejects with the bound's `TimeoutError`   | `admitted`, queued, as for a throw             |
 * | admission | caller aborts   | not applicable: a write has no signal | same                                      | same                                           |
 * | admission | wrong dimension | rejects, `MemoryVectorDimensionError` | same                                      | same                                           |
 * | admission | empty vector    | rejects, `MemoryVectorDimensionError` | same                                      | same                                           |
 * | recall    | throws          | stop reason `failed`, no evidence     | same                                      | text-scored evidence, `semantic` unavailable   |
 * | recall    | times out       | the recall hangs                      | `failed` (an embedder error, as for throw)| degraded as for a throw: the embed is bounded by the smaller of the bound and half the latency budget left |
 * | recall    | caller aborts   | the recall waits on the embedder      | `canceled`, no evidence, no embedder fault| same                                           |
 * | recall    | wrong dimension | stop reason `failed`, no evidence     | same                                      | same                                           |
 * | recall    | empty vector    | stop reason `failed`, no evidence     | same                                      | same                                           |
 * | advance   | throws          | the switch ends `failed` with error   | same                                      | same; the error is the code `embedder-failed` (COR-2188), never the embedder's text |
 * | advance   | times out       | the advance hangs                     | the switch ends `failed`, error names the bound | same; the code `embedder-timeout`       |
 * | advance   | caller aborts   | not applicable: no signal on advance  | same                                      | same                                           |
 * | advance   | wrong dimension | the switch ends `failed` with error   | same                                      | same; `embedder-failed`                        |
 * | advance   | empty vector    | the switch ends `failed` with error   | same                                      | same; `embedder-failed`                        |
 * | search    | throws          | the search rejects with the error     | same                                      | same: COR-2186 names admission and recall only |
 * | search    | times out       | the search hangs                      | rejects with the bound's `TimeoutError`   | same                                           |
 *
 * A recall's latency budget (`maxLatencyMilliseconds`, 5 seconds by default) is checked before each
 * candidate is admitted, so an embed that used all of it would leave nothing to admit with. Each
 * recall embed is therefore bounded by the smaller of the embed bound and half of the budget that
 * is left, the other half being the headroom the scoring and admission that follow run in.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Embedder } from 'armorer/testing';
import { describe, expect, expectTypeOf, it } from 'bun:test';

import { createEmbedderRegistry, HASHING_EMBEDDER_ID } from '../../src/embedder-registry';
import type {
  GovernedWriteOptions,
  MemoryEmbeddingAdvanceOptions,
  MemoryEvidenceBundle,
  MemoryWriteReceipt,
} from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  createMemoryVectorStore,
  type MemoryEmbeddingFailure,
  type MemoryEmbeddingProfile,
  MemoryVectorDimensionError,
} from '../../src/memory-vector-store';
import { createTestEmbedders, TEST_EMBEDDER_ID, TEST_EMBEDDER_MODEL } from '../../src/test/index';
import {
  createGovernedFixture,
  type GovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const DIMENSION = 8;
/** What an embed may take before the bound ends it; time is advanced by hand to reach it. */
const BOUND = 6000;
const ONE_HOT = Array.from({ length: DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
/** The profile the fixture's embedder makes vectors in, and the scope the notes are stored under. */
const PROFILE: MemoryEmbeddingProfile = {
  embedderId: TEST_EMBEDDER_ID,
  dimension: DIMENSION,
  generation: 1,
  model: TEST_EMBEDDER_MODEL,
};
const NOTES_SCOPE = {
  tenantId: principalA.tenantId,
  namespace: collectionNamespace('private', principalA.ownerId, 'notes'),
};

/** How an embedder misbehaves. `works` is the healthy embedder the records were written with. */
type Failure = 'throws' | 'times out' | 'caller aborts' | 'wrong dimension' | 'empty vector';

/** An embedder that misbehaves as told, and records every call and the signal it was given. */
function misbehaving(failure: Failure | 'works') {
  const calls: { readonly texts: string[]; readonly signal: AbortSignal | undefined }[] = [];
  const embed: Embedder = (texts, options) => {
    calls.push({ texts, signal: options?.signal });
    switch (failure) {
      case 'works':
        return texts.map(() => ONE_HOT);
      case 'throws':
        return Promise.reject(new Error('embedder offline'));
      case 'wrong dimension':
        return texts.map(() => [1, 2, 3]);
      case 'empty vector':
        return texts.map(() => []);
      case 'times out':
      case 'caller aborts':
        // The embedder ignores its signal, so only the bound or the caller ends the wait.
        return new Promise<number[][]>(() => undefined);
    }
  };
  return { embed, calls };
}

/** What a promise came to, read without waiting on it. */
function observe<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; reason?: unknown } = { settled: false };
  promise.then(
    (value) => {
      outcome.settled = true;
      outcome.value = value;
    },
    (reason: unknown) => {
      outcome.settled = true;
      outcome.reason = reason;
    },
  );
  return outcome;
}

async function fixtureWith(embedder: Embedder): Promise<GovernedFixture> {
  return createGovernedFixture('in-memory', {
    governed: { ...createTestEmbedders(embedder, DIMENSION), embedTimeoutMilliseconds: BOUND },
  });
}

const write = (fixture: GovernedFixture | { memory: GovernedFixture['memory'] }, content: string) =>
  fixture.memory.write(principalA, content, { collection: 'notes', source: 'conversation' });

const list = (memory: GovernedFixture['memory']) =>
  memory.list(principalA, { collection: 'notes' });

/** The timers a fixture holds: an embed leaves none behind once it has settled, whichever way. */
const timersOf = (fixture: GovernedFixture) => fixture.runtime.pendingTimers().length;

describe('an embedder that fails at admission', () => {
  /**
   * The write was admitted and stored, with its embed queued for the active profile (COR-2186); a
   * later advance with a healthy embedder embeds it, and the queue is empty after.
   */
  async function expectQueuedThenEmbedded(
    fixture: GovernedFixture,
    outcome: ReturnType<typeof observe>,
  ) {
    expect(outcome.reason).toBeUndefined();
    const receipt = outcome.value as MemoryWriteReceipt;
    expect(receipt.status).toBe('admitted');
    const stored = await list(fixture.memory);
    expect(stored.map((record) => record.id)).toEqual([receipt.recordId!]);
    const vectors = createMemoryVectorStore(fixture.durable);
    const queued = await vectors.listQueuedEmbeds(PROFILE, 10);
    expect(queued.map((entry) => entry.reference.id)).toEqual([receipt.recordId!]);
    const before = await vectors.getMany(PROFILE, NOTES_SCOPE, [receipt.recordId!]);
    expect(before.size).toBe(0);

    const healthy = fixture.restart(createTestEmbedders(misbehaving('works').embed, DIMENSION));
    await healthy.embedding.advance();

    expect(await vectors.listQueuedEmbeds(PROFILE, 10)).toEqual([]);
    const held = await vectors.getMany(PROFILE, NOTES_SCOPE, [receipt.recordId!]);
    expect(Array.from(held.get(receipt.recordId!)?.vector ?? [])).toEqual(ONE_HOT);
  }

  const rows: {
    failure: Failure;
    /** What the write does, driven to the point where it must have settled. */
    expectOutcome: (fixture: GovernedFixture, outcome: ReturnType<typeof observe>) => Promise<void>;
  }[] = [
    { failure: 'throws', expectOutcome: expectQueuedThenEmbedded },
    { failure: 'times out', expectOutcome: expectQueuedThenEmbedded },
    {
      failure: 'wrong dimension',
      expectOutcome: async (fixture, outcome) => {
        expect(outcome.reason).toBeInstanceOf(MemoryVectorDimensionError);
        expect(await list(fixture.memory)).toEqual([]);
      },
    },
    {
      failure: 'empty vector',
      expectOutcome: async (fixture, outcome) => {
        expect(outcome.reason).toBeInstanceOf(MemoryVectorDimensionError);
        expect(await list(fixture.memory)).toEqual([]);
      },
    },
  ];

  it.each(rows)('$failure (COR-2185, COR-2186)', async ({ failure, expectOutcome }) => {
    const embedder = misbehaving(failure);
    const fixture = await fixtureWith(embedder.embed);
    const timersBefore = timersOf(fixture);

    const outcome = observe(write(fixture, 'The user prefers an aisle seat.'));
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    if (failure === 'times out') {
      // Held until the bound: the embed has not ended, and it holds one timer.
      expect(outcome.settled).toBe(false);
      expect(timersOf(fixture)).toBe(timersBefore + 1);
      await fixture.runtime.advance(BOUND);
    }
    await waitUntil(() => outcome.settled, { message: `the write to settle (${failure})` });

    await expectOutcome(fixture, outcome);
    // Whichever way the embed ended, it cleared its timer and its signal reached the embedder.
    expect(timersOf(fixture)).toBe(timersBefore);
    expect(embedder.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('caller aborts: a write has no signal, so there is nothing to abort', () => {
    expectTypeOf<GovernedWriteOptions>().not.toHaveProperty('signal');
  });

  it('leaves no unhandled rejection when the embedder fails after the bound gave up on it', async () => {
    let rejectLate!: (reason: Error) => void;
    const calls: number[] = [];
    const late: Embedder = () => {
      calls.push(1);
      return new Promise<number[][]>((_resolve, reject) => {
        rejectLate = reject;
      });
    };
    const fixture = await fixtureWith(late);
    const outcome = observe(write(fixture, 'The user prefers an aisle seat.'));
    await waitUntil(() => calls.length > 0);
    await fixture.runtime.advance(BOUND);
    await waitUntil(() => outcome.settled);

    // The embedder answers, with a failure, after the embed gave up on it.
    rejectLate(new Error('too late'));
    await waitUntil(() => timersOf(fixture) === 0);
    expect((outcome.value as MemoryWriteReceipt).status).toBe('admitted');
  });
});

describe('an embedder that fails at recall', () => {
  /** A fixture holding one record, written healthy, and the same memory restarted on `failure`. */
  async function recallingWith(failure: Failure | 'works') {
    const healthy = await fixtureWith(misbehaving('works').embed);
    const stored = await recordIdOf(write(healthy, 'The user prefers an aisle seat.'));
    const embedder = misbehaving(failure);
    const restarted = healthy.restart(createTestEmbedders(embedder.embed, DIMENSION));
    return { fixture: healthy, memory: restarted, embedder, stored };
  }

  /** A recall whose latency budget outlasts the bound, so only the embedder is what is on trial. */
  const recall = (
    memory: GovernedFixture['memory'],
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryEvidenceBundle> =>
    memory.recallForModel(principalA, 'seat', {
      collection: 'notes',
      plan: { budgets: { maxLatencyMilliseconds: BOUND * 10 } },
      ...options,
    });

  /** The recall carried on by the text of its candidates (COR-2186), and said why. */
  const expectScoredByText = (bundle: MemoryEvidenceBundle) => {
    expect(bundle.stopReason).not.toBe('failed');
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.stages.find(({ stage }) => stage === 'semantic')).toEqual({
      stage: 'semantic',
      status: 'unavailable',
      detail: 'the active embedder failed, so candidates were scored by their text',
    });
    expect(bundle.candidates.map(({ selection }) => selection)).toEqual(['selected']);
    // One unit for the query's embed that failed, and one for the recall guardrail.
    expect(bundle.spent.cost).toBe(2);
  };

  const rows: { failure: Failure; expectBundle: (bundle: MemoryEvidenceBundle) => void }[] = [
    { failure: 'throws', expectBundle: expectScoredByText },
    { failure: 'times out', expectBundle: expectScoredByText },
    {
      failure: 'wrong dimension',
      expectBundle: (bundle) => {
        expect(bundle).toMatchObject({ evidence: [], rendered: '', stopReason: 'failed' });
      },
    },
    {
      failure: 'empty vector',
      expectBundle: (bundle) => {
        expect(bundle).toMatchObject({ evidence: [], rendered: '', stopReason: 'failed' });
      },
    },
  ];

  it.each(rows)('$failure (COR-2185, COR-2186)', async ({ failure, expectBundle }) => {
    const { fixture, memory, embedder } = await recallingWith(failure);
    const timersBefore = timersOf(fixture);

    const outcome = observe(recall(memory));
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    if (failure === 'times out') {
      expect(outcome.settled).toBe(false);
      await fixture.runtime.advance(BOUND);
    }
    await waitUntil(() => outcome.settled, { message: `the recall to settle (${failure})` });

    expectBundle(outcome.value as MemoryEvidenceBundle);
    expect(timersOf(fixture)).toBe(timersBefore);
    expect(embedder.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks a failing embedder once, however many reformulation passes follow (COR-2186)', async () => {
    const { memory, embedder } = await recallingWith('throws');

    const bundle = await memory.recallForModel(principalA, 'what about the seat', {
      collection: 'notes',
      plan: {
        stages: ['exact-lexical', 'semantic', 'rank-fusion', 'reformulation'],
        minimumScore: 1,
      },
    });

    // The first pass fell below the minimum, so a reformulated query ran: by text, without asking.
    expect(bundle.spent.iterations).toBe(2);
    expect(bundle.reformulations).toEqual(['seat']);
    expect(bundle.evidence).toHaveLength(1);
    expect(embedder.calls).toHaveLength(1);
  });

  it('a text-search provider that throws still fails the recall closed (COR-2186)', async () => {
    const { fixture } = await recallingWith('works');
    const broken = fixture.restart({
      ...createTestEmbedders(misbehaving('works').embed, DIMENSION),
      textSearchProvider: {
        init: async () => undefined,
        close: async () => undefined,
        index: async () => undefined,
        remove: async () => undefined,
        clear: async () => undefined,
        search: () => Promise.reject(new Error('index offline')),
      },
    });

    const bundle = await recall(broken);

    expect(bundle).toMatchObject({ evidence: [], rendered: '', stopReason: 'failed' });
  });

  /** The time until the one timer a hung embed holds is due, read without moving the clock. */
  function untilBoundFires(fixture: GovernedFixture): number {
    const timers = fixture.runtime.pendingTimers();
    expect(timers).toHaveLength(1);
    return timers[0]!.dueAt - fixture.runtime.monotonic.now();
  }

  it('bounds a recall’s embed by half the latency budget that is left, so a hung embedder still yields text-scored evidence (COR-2186)', async () => {
    const { fixture, memory, embedder } = await recallingWith('times out');
    const budget = 5000; // The default plan's `maxLatencyMilliseconds`, which the bound exceeds.
    expect(BOUND).toBeGreaterThan(budget);

    const outcome = observe(
      memory.recallForModel(principalA, 'seat', { collection: 'notes', plan: {} }),
    );
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    // The embed was given less than the budget: a bound equal to it would leave nothing to admit
    // with, and a lockstep clock would hide that, so the test reads the bound and does not trust
    // the outcome alone.
    const cap = untilBoundFires(fixture);
    expect(cap).toBe(budget / 2);
    await fixture.runtime.advance(cap);
    await waitUntil(() => outcome.settled, { message: 'the recall to settle' });

    const bundle = outcome.value as MemoryEvidenceBundle;
    // (`exhausted` is also what a recall that ran out of candidates reports, so the evidence and
    // the time spent say it was not the budget that ended it.)
    expectScoredByText(bundle);
    expect(bundle.spent.latencyMilliseconds).toBe(cap);
    expect(bundle.spent.latencyMilliseconds).toBeLessThan(budget);
  });

  it('keeps the configured bound when the latency budget outlasts it (COR-2186)', async () => {
    const { fixture, memory, embedder } = await recallingWith('times out');

    const outcome = observe(recall(memory));
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    expect(untilBoundFires(fixture)).toBe(BOUND);
    await fixture.runtime.advance(BOUND);
    await waitUntil(() => outcome.settled, { message: 'the recall to settle' });

    expectScoredByText(outcome.value as MemoryEvidenceBundle);
  });

  it('bounds each embed of a recall that embeds twice by what is left of its budget (COR-2186)', async () => {
    const healthy = await fixtureWith(misbehaving('works').embed);
    await write(healthy, 'The user prefers an aisle seat.');
    const calls: number[] = [];
    // The first embed answers after two seconds; the reformulated query's embed never answers.
    const slowThenHung: Embedder = async (texts) => {
      calls.push(1);
      if (calls.length > 1) return new Promise<number[][]>(() => undefined);
      await healthy.runtime.advance(2000);
      return texts.map(() => ONE_HOT);
    };
    const memory = healthy.restart(createTestEmbedders(slowThenHung, DIMENSION));

    const outcome = observe(
      memory.recallForModel(principalA, 'what about the seat', {
        collection: 'notes',
        plan: {
          stages: ['exact-lexical', 'semantic', 'rank-fusion', 'reformulation'],
          minimumScore: 1,
        },
      }),
    );
    await waitUntil(() => calls.length === 2, { message: 'the second embed to start' });
    // 3 seconds are left of the 5 the plan has, so the second embed gets half of them.
    const cap = untilBoundFires(healthy);
    expect(cap).toBe(1500);
    await healthy.runtime.advance(cap);
    await waitUntil(() => outcome.settled, { message: 'the recall to settle' });

    const bundle = outcome.value as MemoryEvidenceBundle;
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.spent.iterations).toBe(2);
    expect(bundle.spent.latencyMilliseconds).toBe(3500);
  });

  it('caller aborts: ends as canceled, with no evidence, and without blaming the embedder (COR-2185)', async () => {
    const { fixture, memory, embedder } = await recallingWith('caller aborts');
    const controller = new AbortController();
    const timersBefore = timersOf(fixture);

    const outcome = observe(recall(memory, { signal: controller.signal }));
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    expect(outcome.settled).toBe(false);
    // The embedder was handed a signal that follows the caller's.
    expect(embedder.calls[0]?.signal?.aborted).toBe(false);
    controller.abort();
    await waitUntil(() => outcome.settled, { message: 'the recall to stop' });

    const bundle = outcome.value as MemoryEvidenceBundle;
    expect(bundle).toMatchObject({ evidence: [], rendered: '', stopReason: 'canceled' });
    expect(embedder.calls[0]?.signal?.aborted).toBe(true);
    expect(JSON.stringify(bundle.stages)).not.toContain('embedder');
    expect(timersOf(fixture)).toBe(timersBefore);
  });
});

describe('an embedder that fails during a switch', () => {
  /** A fixture whose records were hashed, and a switch to an embedder that fails as told. */
  async function switchingWith(failure: Failure) {
    const embedder = misbehaving(failure);
    const registry = createEmbedderRegistry([
      { id: 'fake', embedder: embedder.embed, dimension: DIMENSION, model: 'fake-model' },
    ]);
    const fixture = await createGovernedFixture('in-memory', {
      governed: {
        embedders: registry,
        initialEmbedder: HASHING_EMBEDDER_ID,
        embedTimeoutMilliseconds: BOUND,
      },
    });
    await write(fixture, 'The user prefers an aisle seat.');
    const started = await fixture.memory.embedding.switchTo('fake');
    expect(started.outcome).toBe('started');
    return { fixture, embedder };
  }

  // The error is a code and never the embedder's text (COR-2188): `embedder offline` is not in it.
  const rows: { failure: Failure; error: MemoryEmbeddingFailure }[] = [
    { failure: 'throws', error: 'embedder-failed' },
    { failure: 'times out', error: 'embedder-timeout' },
    { failure: 'wrong dimension', error: 'embedder-failed' },
    { failure: 'empty vector', error: 'embedder-failed' },
  ];

  it.each(rows)('$failure (COR-2185)', async ({ failure, error }) => {
    const { fixture, embedder } = await switchingWith(failure);
    const timersBefore = timersOf(fixture);

    const outcome = observe(fixture.memory.embedding.advance());
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    if (failure === 'times out') {
      expect(outcome.settled).toBe(false);
      await fixture.runtime.advance(BOUND);
    }
    await waitUntil(() => outcome.settled, { message: `the advance to settle (${failure})` });

    const status = await fixture.memory.embedding.status();
    expect(status.job).toMatchObject({ target: 'fake', state: 'failed' });
    expect(status.job?.error).toBe(error);
    expect(timersOf(fixture)).toBe(timersBefore);
    expect(embedder.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('caller aborts: an advance has no signal, so there is nothing to abort', () => {
    expectTypeOf<MemoryEmbeddingAdvanceOptions>().not.toHaveProperty('signal');
  });
});

describe('an embedder that fails at search', () => {
  // `memory.search` is neither admission nor recall: COR-2186 does not degrade it, so a failure
  // reaches its caller as it did on main, and a hung embedder is ended by the bound (COR-2185).
  async function searchingWith(failure: Failure | 'works') {
    const healthy = await fixtureWith(misbehaving('works').embed);
    await write(healthy, 'The user prefers an aisle seat.');
    const embedder = misbehaving(failure);
    const memory = healthy.restart(createTestEmbedders(embedder.embed, DIMENSION));
    return { fixture: healthy, memory, embedder };
  }

  it('throws: rejects with the embedder’s error', async () => {
    const { memory } = await searchingWith('throws');
    const failure = await rejectionOf(memory.search(principalA, 'seat', { collection: 'notes' }));
    expect(failure).toEqual(new Error('embedder offline'));
  });

  it('times out: rejects with the bound’s TimeoutError, and holds no timer (COR-2185)', async () => {
    const { fixture, memory, embedder } = await searchingWith('times out');
    const timersBefore = timersOf(fixture);

    const outcome = observe(memory.search(principalA, 'seat', { collection: 'notes' }));
    await waitUntil(() => embedder.calls.length > 0, { message: 'the embedder to be called' });
    expect(outcome.settled).toBe(false);
    await fixture.runtime.advance(BOUND);
    await waitUntil(() => outcome.settled, { message: 'the search to settle' });

    expect(outcome.reason).toMatchObject({ name: 'TimeoutError' });
    expect(timersOf(fixture)).toBe(timersBefore);
  });
});

describe('the bound every embed has', () => {
  it('defaults to two minutes, set through the runtime’s timers', async () => {
    const embedder = misbehaving('times out');
    const fixture = await createGovernedFixture('in-memory', {
      governed: createTestEmbedders(embedder.embed, DIMENSION),
    });
    expect(fixture.runtime.pendingTimers()).toEqual([]);
    const outcome = observe(write(fixture, 'The user prefers an aisle seat.'));
    await waitUntil(() => embedder.calls.length > 0);
    const [timer] = fixture.runtime.pendingTimers();
    expect(timer?.dueAt).toBe(fixture.runtime.monotonic.now() + 120_000);
    await fixture.runtime.advance(120_000);
    await waitUntil(() => outcome.settled);
    // The embed was abandoned by its bound, and the admission carried on without a vector.
    expect(embedder.calls[0]?.signal?.aborted).toBe(true);
    expect((outcome.value as MemoryWriteReceipt).status).toBe('admitted');
  });
});
