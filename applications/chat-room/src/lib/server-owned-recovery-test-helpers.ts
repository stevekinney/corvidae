import type { AgentRun } from '@corvidae/operative';
import { createAgent, SessionRecoverEvent } from '@corvidae/operative';
import { expect, spyOn } from 'bun:test';
import {
  classifyRecovery,
  describeRecoveryError,
  disposeRecoveredRunWhenSettled,
  recoveryFailureLog,
  withRecoveryLock,
  type RecoverableSessionHandle,
} from './server-owned-recovery.ts';

export {
  classifyRecovery,
  createAgent,
  describeRecoveryError,
  disposeRecoveredRunWhenSettled,
  recoveryFailureLog,
  SessionRecoverEvent,
  spyOn,
  withRecoveryLock,
};
export type { AgentRun, RecoverableSessionHandle };

class RecoverableTestEventTarget extends EventTarget {
  dispatch(event: Event): boolean {
    return this.dispatchEvent(event);
  }
}

/**
 * A handle that dispatches the real `SessionRecoverEvent` during `recover()`.
 *
 * Operative's own event class, not a hand-rolled stand-in: the whole point of
 * this module is reading a field off that event, so a fake event with the same
 * field name would test the fake rather than the contract. Constructing the
 * published class means a rename upstream fails this suite instead of passing
 * against a shape that no longer exists.
 *
 * It also caught the constructor being POSITIONAL rather than an options bag,
 * which a hand-rolled event would have hidden completely.
 */
export function handleThatRecovers(options: {
  returns: AgentRun | null;
  failures?: readonly { runId: string; error: unknown }[];
  throws?: unknown;
}): RecoverableSessionHandle & { listenerCount: () => number } {
  const emitter = new RecoverableTestEventTarget();
  let listeners = 0;
  const add = emitter.addEventListener.bind(emitter);
  const remove = emitter.removeEventListener.bind(emitter);

  const handle = {
    id: 'session-under-test',
    emitter: Object.assign(emitter, {
      addEventListener: (...args: Parameters<typeof add>) => {
        listeners += 1;
        add(...args);
      },
      removeEventListener: (...args: Parameters<typeof remove>) => {
        listeners -= 1;
        remove(...args);
      },
    }),
    recover: async () => {
      // Dispatched DURING the call, which is what makes listener ordering
      // load-bearing rather than incidental.
      // POSITIONAL — `(sessionId, runId, failures)`, not an options bag.
      // Passing an object puts it in `sessionId` and leaves `failures` at
      // its `[]` default, so the classifier reports every orphan as
      // "nothing to resume": the benign answer, silently. This test caught
      // exactly that, and only because it asserts the FAILURE branch — a
      // suite that checked the happy path would have shipped it.
      emitter.dispatchEvent(
        new SessionRecoverEvent(
          'session-under-test',
          'session-under-test:1',
          options.failures ?? [],
        ),
      );
      if (options.throws !== undefined) throw options.throws;
      return options.returns;
    },
    listenerCount: () => listeners,
  };

  return handle;
}

export async function expectRejectsWith(
  promise: Promise<unknown>,
  check: (error: unknown) => void,
): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    check(error);
  }
  expect(rejected).toBe(true);
}
