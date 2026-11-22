/**
 * A failed run's explanation as `bureau.tasks.explain` answers it (COR-2533), for the tests that
 * read the Run page's failure section and Chat's link to it.
 */
import type { RunFailureExplanation } from '../../../lib/bureau-tasks.ts';

/** Every part of an explanation: a sentence, a cause, a step, tries, a guardrail and a remediation. */
export const FAILED_RUN_EXPLANATION: RunFailureExplanation = {
  summary:
    'The step "charge-card" failed because the code it ran raised an error while running a tool.',
  cause: { category: 'application', code: 'UNKNOWN', kind: 'tool' },
  step: { index: 1, label: 'charge-card' },
  tries: 3,
  verdicts: [{ name: 'sentinel-card', kind: 'tripwire', outcome: 'tripwire', step: 1 }],
  remediation:
    'Read the run’s failure message, fix the input or the code the step ran, and start the run again. A guardrail halted this run: review the guardrail named in `verdicts` before starting it again.',
  nextCommands: ['interborough runs get --kind task run-1'],
};

/** The answer for `bureau.tasks.explain`, for a stub of the Bureau. */
export function explainAnswers(
  explanation: RunFailureExplanation = FAILED_RUN_EXPLANATION,
): Record<string, () => unknown> {
  return { 'bureau.tasks.explain': () => explanation };
}
