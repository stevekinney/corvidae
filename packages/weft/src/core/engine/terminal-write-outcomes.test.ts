/**
 * COR-1626, review round 2: every exit from the terminal-write path ends the run's waiter.
 *
 * The invariant is stated once and held by a matrix: eight behaviours of the storage and of another
 * writer, each crossed with the two terminal writes (a completion and a failure). Every cell asserts
 * the same five things:
 *
 * - the in-flight `result()` settles;
 * - a `result()` requested afterwards on a fresh handle settles;
 * - the durable record is terminal, except in the one ruled abandon case: a failure write refused
 *   on every attempt, which leaves the record `running` for the next boot;
 * - no change another writer made is overwritten;
 * - nothing the engine held for the run is left behind (the result waiter, the checkpoint), and
 *   the leak guard that runs after every test sees no timer left armed.
 *
 * A hang in any cell fails it by the test runner's own timeout.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec/api.ts';
import { WorkflowCompletedEvent } from '../events.ts';
import type { WorkflowState } from '../types.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { abandonedExecutionAttemptCount } from './execution-attempts.ts';
import { WorkflowHandle } from './handles.ts';
import { getInternals } from './internals.ts';
import { putsWorkflowStatus } from './storage-write-refusal.test-support.ts';
import {
  failsAfterSignal,
  startParked,
  steps,
  type Run,
} from './storage-write-retry.test-support.ts';

type Kind = 'completion' | 'failure';

/** How one settled `result()` ended, in terms every cell can compare. */
type Settlement =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'rejection'; readonly error: unknown };

async function settlementOf(promise: Promise<unknown>): Promise<Settlement> {
  try {
    return { kind: 'value', value: await promise };
  } catch (error) {
    return { kind: 'rejection', error };
  }
}

/** What a cell expects of its `result()` calls. */
type Outcome =
  /** The run's own: the completion's value, or the failure's error. */
  | 'own'
  /** The typed commit failure, for the write named. */
  | { readonly commitFailed: Kind }
  /** The outcome another writer's terminal record holds. */
  | 'another writer’s outcome'
  /** A newer run took the id: the waiter was told, and a later result() reads the newer run. */
  | 'replaced';

const ANOTHER_WRITERS_RESULT = 'another writer’s result';
const REPLACEMENT_RESULT = 'the replacement’s result';

/** What a cell does to the storage, and what it leaves to be checked afterwards. */
type Arming = {
  /** The bytes another writer left in `wf:<id>`, when it left any. */
  readonly othersBytes: () => Uint8Array | undefined;
  /** Whether the record keeps what another writer changed, when it only changed part of it. */
  readonly keepsTheChange?: (record: WorkflowState) => boolean;
};

type Behaviour = {
  readonly name: string;
  readonly arm: (run: Run, id: string, kind: Kind) => Arming;
  readonly outcome: (kind: Kind) => Outcome;
  /** The ruled abandon case is the only one that leaves the record `running`. */
  readonly leavesRunning?: (kind: Kind) => boolean;
  /** Writes of the terminal record the storage should have seen, when the cell pins them. */
  readonly terminalWrites?: number;
};

const terminalPut = (id: string, kind: Kind) =>
  putsWorkflowStatus(id, kind === 'completion' ? 'completed' : 'failed');

/** Another writer replaces `wf:<id>` at the moment the first terminal attempt fails. */
function otherWriterChanges(run: Run, id: string, change: (record: WorkflowState) => void) {
  let bytes: Uint8Array | undefined;
  return {
    before: async () => {
      const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
      change(record);
      bytes = encode(record);
      await run.refusing.base.put(KEYS.workflow(id), bytes);
    },
    bytes: () => bytes,
  };
}

const edited = 'edited-elsewhere';
const addTag = (record: WorkflowState): void => {
  record.tags = [...(record.tags ?? []), edited];
};

const behaviours: readonly Behaviour[] = [
  {
    name: 'lands, then reports failure',
    terminalWrites: 1,
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind), mode: 'land-then-throw', times: 1 });
      return { othersBytes: () => undefined };
    },
    outcome: () => 'own',
  },
  {
    name: 'refused on every attempt',
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind) });
      return { othersBytes: () => undefined };
    },
    outcome: (kind) => ({ commitFailed: kind }),
    leavesRunning: (kind) => kind === 'failure',
  },
  {
    name: 'another writer changes updatedAt between attempts, then writes pass',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.updatedAt += 1;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: () => undefined };
    },
    outcome: () => 'own',
  },
  {
    name: 'another writer adds a tag between attempts, then writes pass',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, addTag);
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return {
        othersBytes: () => undefined,
        keepsTheChange: (r) => r.tags?.includes(edited) === true,
      };
    },
    outcome: () => 'own',
  },
  {
    name: 'another writer leaves a look-alike completed record',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.status = 'completed';
        record.result = ANOTHER_WRITERS_RESULT;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: other.bytes };
    },
    outcome: () => 'another writer’s outcome',
  },
  {
    name: 'a compare-and-swap is lost between the read and the send',
    arm: (run, id, kind) => {
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1 });
      const other = otherWriterChanges(run, id, addTag);
      // The retry reads the record as it decided, and sends: the other writer's change lands just
      // before that send reaches the store.
      run.refusing.refuse({
        matches: terminalPut(id, kind),
        mode: 'pass',
        times: 1,
        before: other.before,
      });
      return {
        othersBytes: () => undefined,
        keepsTheChange: (r) => r.tags?.includes(edited) === true,
      };
    },
    outcome: () => 'own',
  },
  {
    name: 'reads are refused as well as writes',
    arm: (run, id, kind) => {
      let armedReads = false;
      run.refusing.refuse({
        matches: terminalPut(id, kind),
        before: () => {
          if (armedReads) return;
          armedReads = true;
          // Each of the four retries reads the record first, and none of those reads is answered.
          run.refusing.refuseReads(KEYS.workflow(id), 4);
        },
      });
      return { othersBytes: () => undefined };
    },
    outcome: (kind) => ({ commitFailed: kind }),
    leavesRunning: (kind) => kind === 'failure',
  },
  {
    name: 'a record from another generation',
    arm: (run, id, kind) => {
      const other = otherWriterChanges(run, id, (record) => {
        record.workflowExecutionToken = 'another-generation';
        record.status = 'completed';
        record.result = REPLACEMENT_RESULT;
      });
      run.refusing.refuse({ matches: terminalPut(id, kind), times: 1, before: other.before });
      return { othersBytes: other.bytes };
    },
    outcome: () => 'replaced',
  },
];

function expectOutcome(settlement: Settlement, outcome: Outcome, kind: Kind, late: boolean): void {
  if (outcome === 'own') {
    if (kind === 'completion') {
      expect(settlement).toEqual({ kind: 'value', value: 'x:a:b' });
    } else {
      expect(settlement).toMatchObject({
        kind: 'rejection',
        error: { message: 'the workflow body failed' },
      });
    }
  } else if (outcome === 'another writer’s outcome') {
    expect(settlement).toEqual({ kind: 'value', value: ANOTHER_WRITERS_RESULT });
  } else if (outcome === 'replaced') {
    // The waiter that was waiting is told its run was replaced. A result() asked for afterwards
    // reads the run that holds the id now.
    if (late) {
      expect(settlement).toEqual({ kind: 'value', value: REPLACEMENT_RESULT });
    } else {
      expect(settlement).toMatchObject({
        kind: 'rejection',
        error: { message: expect.stringContaining('was replaced by a newer run') },
      });
    }
  } else {
    expect(settlement.kind).toBe('rejection');
    const error = (settlement as { error: Error }).error;
    expect(error.message).toContain(`${outcome.commitFailed} write was not committed after`);
    // The typed error reaches a waiter the engine rejected; a record read back carries its message.
    if (!late) expect(error).toBeInstanceOf(CheckpointCommitFailedError);
  }
}

describe('every exit from a terminal write settles the run', () => {
  for (const kind of ['completion', 'failure'] as const) {
    for (const [index, behaviour] of behaviours.entries()) {
      it(`${kind}: ${behaviour.name}`, async () => {
        const id = `outcome-${kind}-${String(index)}`;
        const run = await startParked(kind === 'completion' ? steps : failsAfterSignal, id);
        await using engine = run.engine;
        const arming = behaviour.arm(run, id, kind);

        await engine.signal(id, 'go', 'x');
        const outcome = behaviour.outcome(kind);

        // 1. The in-flight result() settles.
        expectOutcome(await settlementOf(run.result), outcome, kind, false);

        // 2. A result() requested afterwards, on a fresh handle, settles too.
        const lateHandle = new WorkflowHandle(id, getInternals(engine).engine);
        const abandoned = behaviour.leavesRunning?.(kind) === true;
        const late = await settlementOf(lateHandle.result());
        expectOutcome(late, outcome, kind, !abandoned);

        // 3. The record is terminal, or is the ruled abandon.
        const record = decode((await run.refusing.base.get(KEYS.workflow(id)))!) as WorkflowState;
        if (abandoned) {
          expect(record.status).toBe('running');
          expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(1);
        } else {
          expect(['completed', 'failed']).toContain(record.status);
        }

        // 4. Nothing another writer changed is overwritten.
        const othersBytes = arming.othersBytes();
        if (othersBytes !== undefined) {
          expect(await run.refusing.base.get(KEYS.workflow(id))).toEqual(othersBytes);
        }
        if (arming.keepsTheChange !== undefined) expect(arming.keepsTheChange(record)).toBe(true);
        if (behaviour.terminalWrites !== undefined) {
          expect(run.refusing.attemptsMatching(terminalPut(id, kind))).toHaveLength(
            behaviour.terminalWrites,
          );
        }

        // 5. Nothing the engine held for the run is left behind.
        const internals = getInternals(engine);
        expect(internals.resultResolvers.has(id)).toBe(false);
        if (!abandoned) expect(internals.checkpoints.has(id)).toBe(false);
      });
    }
  }
});

describe("a run settled from a record another writer left, under ownership: 'workflow-lease'", () => {
  /** Another writer ends the run with a completed record, which `committedBy` may stamp. */
  async function settledFromLookAlike(id: string, committedBy: (own: string) => string) {
    const run = await startParked(steps, id, { ownership: 'workflow-lease' });
    const internals = getInternals(run.engine);
    const registry = internals.workflowClaimRegistry!;
    const completions: unknown[] = [];
    run.engine.addEventListener(WorkflowCompletedEvent.type, (event) => completions.push(event));
    expect(registry.currentEpoch(id)).not.toBeNull();
    const other = otherWriterChanges(run, id, (record) => {
      record.status = 'completed';
      record.result = ANOTHER_WRITERS_RESULT;
      record.terminalCommittedBy = committedBy(registry.engineId);
    });
    run.refusing.refuse({ matches: terminalPut(id, 'completion'), times: 1, before: other.before });
    await run.engine.signal(id, 'go', 'x');
    expect(await run.result).toBe(ANOTHER_WRITERS_RESULT);
    return { run, internals, registry, completions, bytes: other.bytes() };
  }

  it('releases the ownership claim and what the run held, and announces its own write', async () => {
    const id = 'own-stamp';
    const { run, internals, registry, completions, bytes } = await settledFromLookAlike(
      id,
      (own) => own,
    );
    await using engine = run.engine;

    expect(registry.currentEpoch(id)).toBeNull();
    expect(internals.checkpoints.has(id)).toBe(false);
    expect(completions).toHaveLength(1);
    expect(await run.refusing.base.get(KEYS.workflow(id))).toEqual(bytes ?? null);
    expect(engine).toBeDefined();
  });

  it('announces nothing for a run another engine ended, and still releases the claim', async () => {
    const id = 'other-stamp';
    const { run, internals, registry, completions } = await settledFromLookAlike(
      id,
      () => 'another-engine',
    );
    await using engine = run.engine;

    expect(registry.currentEpoch(id)).toBeNull();
    expect(internals.checkpoints.has(id)).toBe(false);
    expect(completions).toEqual([]);
    expect(engine).toBeDefined();
  });
});
