/**
 * COR-1903 — a managed goal's controller writes nothing to the event history once
 * `shutdown({ policy: 'detach' })` has returned.
 *
 * One row per state the goal's controller can be in when the bureau shuts down. Every row holds
 * the controller there, starts the shutdown, lets a quiet window pass, then releases everything
 * and asserts the same rule: a history write that was in flight lands before shutdown returns
 * (so shutdown does not return while it is held), and none is attempted after it returns.
 *
 * Writes reach `trace` below Bureau's storage fence, so a write the fence refuses after shutdown
 * shows as a goal diagnostic instead; both are asserted empty.
 */
import type { Validator } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { quietFor } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createCheckValidator,
  createDiagnostics,
  createLatch,
  createTestDatabase,
  createUnsetTestDatabase,
  goalRequest,
  type Latch,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { bootOver } from './testing/goal-recovery-fixtures.test-support';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createUnsetTestDatabase();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

/** The goal event history keeps a dedupe marker beside each event it appends. */
const HISTORY_MARKER = 'outbox-dedupe:';

interface WriteTrace {
  /** Holds the first history write whose marker names `kind`, until `release()`. */
  hold(kind: string): {
    readonly reached: Promise<void>;
    readonly release: () => void;
    /** Fails the held write instead of letting it through. */
    readonly fail: () => void;
  };
  /** Writes that began after `markReturned()`. */
  readonly afterReturn: string[];
  markReturned(): void;
  /** Writes that finished, in order, tagged `done:<kind>`; `returned` marks shutdown's return. */
  readonly order: string[];
}

/** A view of `storage` that traces writes, and holds one history write on request. */
function traceWrites(storage: Storage): { storage: Storage; trace: WriteTrace } {
  let returned = false;
  let held: { kind: string; reached: Latch; gate: Latch; failing: boolean } | undefined;
  const afterReturn: string[] = [];
  const order: string[] = [];

  async function onWrite(keys: readonly string[]): Promise<void> {
    if (returned) afterReturn.push(...keys);
    const marker = keys.find((key) => key.startsWith(HISTORY_MARKER));
    if (held !== undefined && marker?.includes(`:${held.kind}:`) === true) {
      const gate = held;
      held = undefined;
      gate.reached.release();
      await gate.gate.promise;
      if (gate.failing) throw new Error('the held history write failed');
    }
  }

  const traced = new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...parameters: unknown[]) => unknown;
      if (property === 'put') {
        return async (key: string, bytes: Uint8Array) => {
          await onWrite([key]);
          return method.call(target, key, bytes);
        };
      }
      if (property === 'batch' || property === 'conditionalBatch') {
        return async (...parameters: unknown[]) => {
          const operations = (property === 'batch' ? parameters[0] : parameters[1]) as Array<{
            key: string;
          }>;
          await onWrite(operations.map((operation) => operation.key));
          const result = await method.apply(target, parameters);
          const marker = operations.find((operation) => operation.key.startsWith(HISTORY_MARKER));
          if (marker !== undefined) order.push(`done:${marker.key}`);
          return result;
        };
      }
      return method.bind(target);
    },
  });

  return {
    storage: traced,
    trace: {
      hold(kind) {
        const entry = { kind, reached: createLatch(), gate: createLatch(), failing: false };
        held = entry;
        return {
          reached: entry.reached.promise,
          release: entry.gate.release,
          fail: () => {
            entry.failing = true;
            entry.gate.release();
          },
        };
      },
      afterReturn,
      order,
      markReturned() {
        returned = true;
        order.push('returned');
      },
    },
  };
}

async function bootTraced(agent: ReturnType<typeof workerAgent>, validator: Validator) {
  database = createTestDatabase('detach-matrix');
  const { storage, trace } = traceWrites(database.open());
  const diagnostics = createDiagnostics();
  const { bureau } = await bootOver({
    storage,
    agents: { worker: agent },
    validators: [validator],
    diagnostics,
  });
  cleanups.push(() => bureau.dispose());
  await bureau.recovery();
  return { bureau, trace, diagnostics };
}

type Policy = 'detach' | 'drain' | 'abort';

/** Where the controller is held when the shutdown starts. */
interface Row {
  readonly state: string;
  readonly policies: readonly Policy[];
  /** Starts a goal and holds it; `undefined` starts none. */
  readonly hold?:
    | { readonly at: 'agent' }
    | { readonly at: 'validator' }
    | { readonly at: 'history'; readonly kind: string; readonly rejects?: true };
  /** Diagnostics the goal scope reports, by message fragment. */
  readonly diagnostics: readonly string[];
}

const ALL_POLICIES: readonly Policy[] = ['detach', 'drain', 'abort'];

const ROWS: readonly Row[] = [
  { state: 'idle (no goal running)', policies: ALL_POLICIES, diagnostics: [] },
  { state: 'attempt running', policies: ['detach'], hold: { at: 'agent' }, diagnostics: [] },
  { state: 'validator running', policies: ['detach'], hold: { at: 'validator' }, diagnostics: [] },
  {
    state: 'attempt validated, its history write in flight',
    policies: ALL_POLICIES,
    hold: { at: 'history', kind: 'goal.attempt.validated' },
    diagnostics: [],
  },
  {
    state: 'success decided, its history write in flight',
    policies: ALL_POLICIES,
    hold: { at: 'history', kind: 'goal.succeeded' },
    diagnostics: [],
  },
  {
    state: 'a history write that rejects during shutdown',
    policies: ['detach'],
    hold: { at: 'history', kind: 'goal.attempt.validated', rejects: true },
    diagnostics: ['Could not record goal.attempt.validated'],
  },
];

const answerDone = () => workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] }));

describe('shutdown against a goal controller', () => {
  for (const row of ROWS) {
    for (const policy of row.policies) {
      it(`${policy}: ${row.state}`, async () => {
        const agentGate = createLatch();
        const validatorGate = createLatch();
        const reached = createLatch();
        const agent =
          row.hold?.at === 'agent'
            ? workerAgent(async () => {
                reached.release();
                await agentGate.promise;
                return { content: 'done', toolCalls: [] };
              })
            : answerDone();
        const validator = createCheckValidator({
          before: async () => {
            if (row.hold?.at !== 'validator') return;
            reached.release();
            await validatorGate.promise;
          },
        });
        const { bureau, trace, diagnostics } = await bootTraced(agent, validator);
        const held = row.hold?.at === 'history' ? trace.hold(row.hold.kind) : undefined;
        if (row.hold !== undefined) await bureau.goals.create(goalRequest());
        if (held !== undefined) await held.reached;
        else if (row.hold !== undefined) await reached.promise;

        let returned = false;
        const shutdown = bureau.shutdown({ policy }).then(() => {
          returned = true;
          trace.markReturned();
        });
        // Shutdown must not return while a history write it has to wait for is held.
        await quietFor(150);
        if (held !== undefined) expect(returned).toBe(false);

        agentGate.release();
        validatorGate.release();
        if (row.hold?.at === 'history' && row.hold.rejects === true) held?.fail();
        else held?.release();
        await shutdown;

        // What shutdown returned with: a held write landed before it, a rejected one was reported.
        const goalErrors = () =>
          diagnostics
            .scope('goals')
            .filter((diagnostic) => diagnostic.level === 'error')
            .map((diagnostic) => diagnostic.message);
        const rejects = row.hold?.at === 'history' && row.hold.rejects === true;
        if (row.hold?.at === 'history' && !rejects) {
          const kind = row.hold.kind;
          const written = trace.order.findIndex((entry) => entry.includes(`:${kind}:`));
          expect(written).toBeGreaterThanOrEqual(0);
          expect(written).toBeLessThan(trace.order.indexOf('returned'));
        }
        const atReturn = goalErrors();
        expect(atReturn.map((message) => row.diagnostics.some((f) => message.includes(f)))).toEqual(
          row.diagnostics.map(() => true),
        );

        // Anything the controller still means to write has had its chance.
        await quietFor(150);
        expect(trace.afterReturn).toEqual([]);
        expect(goalErrors()).toEqual(atReturn);
      });
    }
  }
});
