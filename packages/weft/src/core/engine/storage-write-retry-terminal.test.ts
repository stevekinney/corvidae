/**
 * COR-1626, review round 1: what a retried terminal or checkpoint write sends, reads and settles.
 *
 * A terminal write is never sent again once the record holds its own bytes, and never over another
 * writer's change; a completion that landed settles its waiter from the stored outcome even when
 * every retry is refused; the retry carries the conditions of the first attempt; it runs under
 * `ownership: 'lease'`; disposal during an attempt starts no further attempt; and the error's message
 * never carries the storage adapter's text.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { yieldToPortableEventLoop } from '../../testing/event-loop.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode, encode } from '../codec/api.ts';
import type { WorkflowState } from '../types.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { EngineDisposedError } from './errors.ts';
import { WorkflowHandle } from './handles.ts';
import { getInternals } from './internals.ts';
import {
  putsCheckpoint,
  putsWorkflowStatus,
  REFUSED_WRITE_MESSAGE,
} from './storage-write-refusal.test-support.ts';
import {
  ATTEMPTS,
  failsAfterSignal,
  readState,
  startParked,
  statusOf,
  steps,
} from './storage-write-retry.test-support.ts';

/** The conditions of one write attempt, as `key` strings, for a compact comparison. */
function conditionKeys(conditions: readonly { key: string }[] | undefined): string[] {
  return (conditions ?? []).map((condition) => condition.key);
}

describe('a terminal write that landed is never sent again', () => {
  it('reads the record, finds its own bytes, and sends the completion once', async () => {
    const run = await startParked(steps, 'landed-once');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-once', 'completed'),
      mode: 'land-then-throw',
      times: 1,
    });

    await engine.signal('landed-once', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    // The storage's own call sequence: one completion write, which landed, and no second one.
    expect(
      run.refusing
        .attemptsMatching(putsWorkflowStatus('landed-once', 'completed'))
        .map((attempt) => attempt.outcome),
    ).toEqual(['land-then-throw']);
  });

  it('sends a failure once when it landed', async () => {
    const run = await startParked(failsAfterSignal, 'landed-failure-once');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-failure-once', 'failed'),
      mode: 'land-then-throw',
      times: 1,
    });

    await engine.signal('landed-failure-once', 'go', 'x');

    expect((await rejectionOf(run.result)) as Error).toHaveProperty(
      'message',
      'the workflow body failed',
    );
    expect(
      run.refusing
        .attemptsMatching(putsWorkflowStatus('landed-failure-once', 'failed'))
        .map((attempt) => attempt.outcome),
    ).toEqual(['land-then-throw']);
  });
});

describe('a terminal write never overwrites another writer', () => {
  /** Another writer replaces the workflow record at the moment the completion's first attempt fails. */
  async function interferedCompletion(workflowId: string, change: (state: WorkflowState) => void) {
    const run = await startParked(steps, workflowId);
    const key = KEYS.workflow(workflowId);
    let othersBytes: Uint8Array | undefined;
    run.refusing.refuse({
      matches: putsWorkflowStatus(workflowId, 'completed'),
      times: 1,
      before: async () => {
        const state = decode((await run.refusing.base.get(key))!) as WorkflowState;
        change(state);
        othersBytes = encode(state);
        await run.refusing.base.put(key, othersBytes);
      },
    });
    await run.engine.signal(workflowId, 'go', 'x');
    await run.refusing.whenAttempts(1, putsWorkflowStatus(workflowId, 'completed'));
    // The retry reads the record and finds a change that is not its own; give it every turn it needs.
    for (let turn = 0; turn < 5; turn += 1) await yieldToPortableEventLoop();
    return { run, key, othersBytes: othersBytes! };
  }

  it('leaves a change another writer made between the attempts', async () => {
    const { run, key, othersBytes } = await interferedCompletion('interfered', (state) => {
      state.updatedAt += 1;
    });
    await using engine = run.engine;

    expect(await run.refusing.base.get(key)).toEqual(othersBytes);
    // Only the first attempt was made: the retry read the record and sent nothing over the change.
    expect(
      run.refusing.attemptsMatching(putsWorkflowStatus('interfered', 'completed')),
    ).toHaveLength(1);
    expect(engine).toBeDefined();
  });

  it('does not mistake another writer’s record with the same status for its own write', async () => {
    const { run, key, othersBytes } = await interferedCompletion('look-alike', (state) => {
      state.status = 'completed';
      state.result = 'another engine’s result';
    });
    await using engine = run.engine;

    // A record that says `completed` but is not this batch's bytes is not this write landing: the
    // waiter does not settle with this run's value, and the other writer's record stands.
    const settled = await Promise.race([
      run.result.then(() => 'settled' as const),
      yieldToPortableEventLoop().then(() => 'pending' as const),
    ]);
    expect(settled).toBe('pending');
    expect(await run.refusing.base.get(key)).toEqual(othersBytes);
    expect(engine).toBeDefined();
  });
});

describe('a completion that landed, followed by refused retries', () => {
  it('settles the in-flight and a late result() from the stored outcome', async () => {
    const run = await startParked(steps, 'landed-then-refused');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-then-refused', 'completed'),
      mode: 'land-then-throw',
      times: 1,
    });
    run.refusing.refuse({ matches: putsWorkflowStatus('landed-then-refused', 'completed') });

    await engine.signal('landed-then-refused', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    const late = new WorkflowHandle('landed-then-refused', getInternals(engine).engine);
    expect(await late.result()).toBe('x:a:b');
    expect(await statusOf(run.refusing, 'landed-then-refused')).toBe('completed');
  });

  it('settles from the stored outcome when the retries could not even read the record', async () => {
    const run = await startParked(steps, 'landed-then-unreadable');
    await using engine = run.engine;
    const key = KEYS.workflow('landed-then-unreadable');
    run.refusing.refuse({
      matches: putsWorkflowStatus('landed-then-unreadable', 'completed'),
      mode: 'land-then-throw',
      times: 1,
      // The four retries each read the record first; none of those reads is answered.
      before: () => run.refusing.refuseReads(key, ATTEMPTS - 1),
    });

    await engine.signal('landed-then-unreadable', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    expect(await statusOf(run.refusing, 'landed-then-unreadable')).toBe('completed');
  });
});

describe('a retry carries the conditions of the first attempt', () => {
  it('resends the checkpoint batch under the same conditions, a compare-and-swap among them', async () => {
    const run = await startParked(steps, 'same-conditions');
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsCheckpoint('same-conditions'), times: 2 });

    await engine.signal('same-conditions', 'go', 'x');
    await run.result;

    const [first, second, third] = run.refusing.attemptsMatching(putsCheckpoint('same-conditions'));
    expect(conditionKeys(first?.conditions)).toContain(KEYS.checkpoint('same-conditions'));
    expect(second?.conditions).toEqual(first?.conditions);
    expect(third?.conditions).toEqual(first?.conditions);
  });

  it('resends a failure write under the same conditions', async () => {
    const run = await startParked(failsAfterSignal, 'same-failure-conditions');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsWorkflowStatus('same-failure-conditions', 'failed'),
      times: 2,
    });

    await engine.signal('same-failure-conditions', 'go', 'x');
    await rejectionOf(run.result);

    const attempts = run.refusing.attemptsMatching(
      putsWorkflowStatus('same-failure-conditions', 'failed'),
    );
    expect(attempts).toHaveLength(3);
    expect(conditionKeys(attempts[0]?.conditions)).toContain(
      KEYS.workflow('same-failure-conditions'),
    );
    expect(attempts[1]?.conditions).toEqual(attempts[0]?.conditions);
    expect(attempts[2]?.conditions).toEqual(attempts[0]?.conditions);
  });

  it('resends a completion under its conditions plus a guard on the record it just read', async () => {
    const run = await startParked(steps, 'guarded-completion');
    await using engine = run.engine;
    const key = KEYS.workflow('guarded-completion');
    let heldRecord: Uint8Array | null = null;
    run.refusing.refuse({
      matches: putsWorkflowStatus('guarded-completion', 'completed'),
      times: 1,
      before: async () => {
        heldRecord = await run.refusing.base.get(key);
      },
    });

    await engine.signal('guarded-completion', 'go', 'x');
    await run.result;

    const [first, second] = run.refusing.attemptsMatching(
      putsWorkflowStatus('guarded-completion', 'completed'),
    );
    expect(second?.outcome).toBe('passed');
    // Everything the first attempt was conditioned on, and the record's bytes as they stood.
    for (const condition of first?.conditions ?? []) {
      expect(second?.conditions).toContainEqual(condition);
    }
    expect(second?.conditions).toContainEqual({ key, expectedValue: heldRecord });
  });
});

describe("under ownership: 'lease'", () => {
  it('absorbs a transient refusal of the checkpoint batch, fenced on the lease epoch each time', async () => {
    const run = await startParked(steps, 'lease-transient', { ownership: 'lease' });
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsCheckpoint('lease-transient'), times: 2 });

    await engine.signal('lease-transient', 'go', 'x');

    expect(await run.result).toBe('x:a:b');
    const batches = run.refusing.attemptsMatching(putsCheckpoint('lease-transient'));
    expect(batches.slice(0, 3).map((attempt) => attempt.outcome)).toEqual([
      'refused',
      'refused',
      'passed',
    ]);
    for (const attempt of batches.slice(0, 3)) {
      expect(conditionKeys(attempt.conditions)).toContain(KEYS.leaseEpoch());
    }
  });

  it('ends the run as a system failure when the checkpoint stays refused', async () => {
    const run = await startParked(steps, 'lease-persistent', { ownership: 'lease' });
    await using engine = run.engine;
    run.refusing.refuse({ matches: putsCheckpoint('lease-persistent') });

    await engine.signal('lease-persistent', 'go', 'x');
    const reason = await rejectionOf(run.result);

    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect(run.refusing.attemptsMatching(putsCheckpoint('lease-persistent'))).toHaveLength(
      ATTEMPTS,
    );
    const state = await readState(run.refusing, 'lease-persistent');
    expect(state.status).toBe('failed');
    expect(state.failureCategory).toBe('system');
  });
});

describe('disposal during an attempt', () => {
  it('starts no further attempt and settles the waiter', async () => {
    const run = await startParked(steps, 'dispose-in-flight');
    const reachedAttempt = Promise.withResolvers<void>();
    const releaseAttempt = Promise.withResolvers<void>();
    let heldOnce = false;
    run.refusing.refuse({
      matches: putsCheckpoint('dispose-in-flight'),
      before: async () => {
        // The second attempt, the first retry, is held in flight.
        if (run.refusing.attemptsMatching(putsCheckpoint('dispose-in-flight')).length !== 1) return;
        if (heldOnce) return;
        heldOnce = true;
        reachedAttempt.resolve();
        await releaseAttempt.promise;
      },
    });

    await run.engine.signal('dispose-in-flight', 'go', 'x');
    await reachedAttempt.promise;
    run.engine[Symbol.dispose]();
    releaseAttempt.resolve();

    expect(await rejectionOf(run.result)).toBeInstanceOf(EngineDisposedError);
    await yieldToPortableEventLoop();
    // The attempt in flight when the engine was disposed was the last.
    expect(run.refusing.attemptsMatching(putsCheckpoint('dispose-in-flight'))).toHaveLength(2);
    expect(await statusOf(run.refusing, 'dispose-in-flight')).toBe('running');
  });
});

describe('the error message', () => {
  it('is a fixed sentence, and the storage text stays on cause', async () => {
    const run = await startParked(steps, 'generic-message');
    await using engine = run.engine;
    run.refusing.refuse({
      matches: putsCheckpoint('generic-message'),
      error: () => new Error('relation "wf_secret_table" violates constraint at /var/db/store'),
    });

    await engine.signal('generic-message', 'go', 'x');
    const reason = (await rejectionOf(run.result)) as CheckpointCommitFailedError;

    expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
    expect(reason.message).toBe(
      'Workflow "generic-message" checkpoint write was refused by storage on all 5 attempts.',
    );
    expect(reason.message).not.toContain('wf_secret_table');
    expect((reason.cause as Error).message).toContain('wf_secret_table');
    // The durable failure record carries the message, so it is clean too.
    const state = await readState(run.refusing, 'generic-message');
    expect(state.error).toBe(reason.message);
    expect(state.error).not.toContain(REFUSED_WRITE_MESSAGE);
  });
});
