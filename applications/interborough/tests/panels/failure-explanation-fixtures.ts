/**
 * What `bureau.tasks.explain` answers for the failure explanation's browser specs (COR-2543): the
 * explanation of a failed fixture run, with every part of it stored, and the Bureau's refusal for a
 * run that did not fail, as the MCP transport carries it (an error result whose structured content
 * is the fault).
 */

/** The explanation of a failed run: a sentence, a cause, a step, tries, a guardrail and a remediation. */
export const FAILED_FIXTURE_RUN = {
  summary:
    'The step "charge-card" failed because the code it ran raised an error while running a tool.',
  cause: { category: 'application', code: 'UNKNOWN', kind: 'tool' },
  step: { index: 1, label: 'charge-card' },
  tries: 3,
  verdicts: [{ name: 'sentinel-card', kind: 'tripwire', outcome: 'tripwire', step: 1 }],
  remediation:
    'Read the run’s failure message, fix the input or the code the step ran, and start the run again. A guardrail halted this run. Review the guardrail listed above before starting it again.',
  nextCommands: ['interborough runs get --kind task run-1'],
} as const;

/** A failure nothing classifies, with no step, no tries and no guardrail stored. */
export const UNCLASSIFIED_FIXTURE_RUN = {
  summary: 'The run failed for a reason that could not be classified.',
  cause: { category: null, code: null, kind: null },
  step: null,
  tries: null,
  verdicts: [],
  remediation: 'Read the run’s failure message to find the cause, fix it, and start the run again.',
  nextCommands: ['interborough runs get --kind task run-1'],
} as const;

/** The refusal the Bureau answers for a run that did not fail. */
export const NOT_FAILED_FAULT = {
  isError: true,
  content: [{ type: 'text', text: '{"code":"Unprocessable"}' }],
  structuredContent: {
    code: 'Unprocessable',
    message:
      'Run "run-1" has not failed (its status is "completed"), so there is no failure to explain',
    data: { reason: 'run-not-failed' },
    retryable: false,
    remediation:
      'Explain a run only after it has failed; read the run to see its status, and wait for a run that is still going to settle.',
  },
};

/** An explanation as the host answers the tool: the text of the result, and its structured content. */
export function explained(explanation: object): {
  content: { type: 'text'; text: string }[];
  structuredContent: object;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(explanation) }],
    structuredContent: explanation,
  };
}
