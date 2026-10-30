/**
 * The agent the end-to-end suite uses for every case that needs a run still in progress when
 * Playwright acts: its first step waits on a barrier until the test releases it, so no case depends
 * on timing. The suite reads how many steps are waiting, releases them, and a run that was stopped
 * while it waited ends as the Bureau ends any aborted step.
 *
 * `createBarrierAgents` makes two agents over one barrier:
 *
 * - `barrier` answers its first step once released, and answers any input the run delivers with a
 *   second step, so the run that was waiting takes a follow-up and answers it.
 * - `barrier-short` is allowed one step, so a follow-up sent during it cannot be answered by the
 *   same run: the Bureau cancels the input when the run ends and the client sends it again.
 */
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';

/** The names the e2e host serves the barrier agents under. */
export const BARRIER_AGENT_NAME = 'barrier';
export const BARRIER_SHORT_AGENT_NAME = 'barrier-short';

/** What the first step of each barrier run says once it is released, and what a later step says. */
export const BARRIER_FIRST_REPLY = 'The barrier opened.';
export const BARRIER_FOLLOW_UP_REPLY = 'The follow-up was delivered.';

export type Barrier = {
  /** How many steps are waiting on the barrier right now. */
  waiting(): number;
  /** Let every waiting step go. A step that arrives later waits for the next release. */
  release(): void;
  /** The generate each barrier agent uses. */
  readonly generate: GenerateFunction;
};

export function createBarrier(): Barrier {
  const waiters = new Set<() => void>();
  const generate: GenerateFunction = async ({ step, signal }) => {
    if (step > 0) {
      return { content: BARRIER_FOLLOW_UP_REPLY, toolCalls: [] };
    }
    await new Promise<void>((resolve, reject) => {
      const release = (): void => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = (): void => {
        waiters.delete(release);
        reject(new Error('The barrier step was aborted.'));
      };
      waiters.add(release);
      signal?.addEventListener('abort', abort, { once: true });
    });
    return { content: BARRIER_FIRST_REPLY, toolCalls: [] };
  };
  return {
    waiting: () => waiters.size,
    release() {
      const releasing = [...waiters];
      waiters.clear();
      for (const release of releasing) release();
    },
    generate,
  };
}

export function createBarrierAgents(barrier: Barrier) {
  return {
    [BARRIER_AGENT_NAME]: createAgent({
      name: BARRIER_AGENT_NAME,
      description: 'Waits on a barrier before it answers.',
      generate: barrier.generate,
      stopWhen: stopWhen.noToolCalls(),
    }),
    [BARRIER_SHORT_AGENT_NAME]: createAgent({
      name: BARRIER_SHORT_AGENT_NAME,
      description: 'Waits on a barrier, and has one step.',
      generate: barrier.generate,
      stopWhen: stopWhen.noToolCalls(),
      maximumSteps: 1,
    }),
  };
}
