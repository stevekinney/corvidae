/**
 * The demo plugin's two goal validators. The Bureau registers them as `demo:accepts-any-answer`
 * and `demo:never-passes`.
 *
 * @module validators
 */

import type { Validator } from '@lostgradient/operative';

/** The validator the seeded goal names. */
export const ACCEPTS_ANY_ANSWER = { name: 'accepts-any-answer', version: '1' } as const;

/**
 * A validator that never passes, for a goal that is made to be cancelled: it waits on the attempt's
 * answer for as long as it is allowed to, so the goal stays `evaluating` until an operator cancels
 * it, and cancelling aborts it, which ends the goal as `canceled`. No goal names it until somebody
 * creates one, so nothing runs against it on a fresh host.
 */
export const NEVER_PASSING = { name: 'never-passes', version: '1' } as const;

/** The two validators, named without the plugin's prefix. */
export function createDemoValidators(): Validator[] {
  return [
    {
      identity: ACCEPTS_ANY_ANSWER,
      determinism: 'deterministic',
      validate: async (input) => ({
        kind: 'pass',
        evidence: [{ source: 'seed', detail: { content: input.result.content } }],
      }),
    },
    {
      identity: NEVER_PASSING,
      determinism: 'deterministic',
      // It answers only when the goal is cancelled, and then as cancelled, never as a pass.
      validate: (_input, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ kind: 'canceled' });
            return;
          }
          signal.addEventListener('abort', () => resolve({ kind: 'canceled' }), { once: true });
        }),
    },
  ];
}
