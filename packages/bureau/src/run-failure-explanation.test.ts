/**
 * COR-2532 — the explanation of a failed run is a pure function of the facts stored about it: one
 * sentence from a template per category and kind, a remediation per category, and the `interborough`
 * commands that read the run.
 */
import { describe, expect, it } from 'bun:test';

import {
  classifyAgentRunFailure,
  explainRunFailure,
  nextCommandsFor,
  RUN_FAILURE_CATEGORIES,
  RUN_FAILURE_KINDS,
  type RunFailureFacts,
  summarizeRunFailure,
} from './run-failure-explanation.ts';

function factsOf(overrides: Partial<RunFailureFacts> = {}): RunFailureFacts {
  return {
    kind: 'agent',
    runId: 'run-1',
    category: 'application',
    code: 'UNKNOWN',
    errorKind: 'tool',
    step: { index: 2, label: 'charge-card' },
    tries: 3,
    verdicts: [],
    ...overrides,
  };
}

describe('summary (AC3)', () => {
  it('is one sentence that names the step and the cause, for every category and every kind', () => {
    const summaries = new Set<string>();
    for (const category of [...RUN_FAILURE_CATEGORIES, null]) {
      for (const errorKind of [...RUN_FAILURE_KINDS, null, 'not-a-kind']) {
        const summary = summarizeRunFailure({
          category,
          errorKind,
          step: { index: 1, label: 'charge-card' },
        });
        expect([category, errorKind, summary.startsWith('The step "charge-card" failed ')]).toEqual(
          [category, errorKind, true],
        );
        expect(summary.endsWith('.')).toBe(true);
        expect(summary.slice(0, -1)).not.toContain('.');
        expect(summary).not.toContain('\n');
        summaries.add(summary);
      }
    }
    // Six causes by eight kind clauses (the seven kinds, and no clause for null or an unknown kind).
    expect(summaries.size).toBe(6 * (RUN_FAILURE_KINDS.length + 1));
  });

  it('gives each category its own clause, and an unclassified failure its own', () => {
    const clauses = [...RUN_FAILURE_CATEGORIES, null].map((category) =>
      summarizeRunFailure({ category, errorKind: null, step: { index: 0, label: 'step' } }),
    );
    expect(new Set(clauses).size).toBe(6);
    expect(clauses[1]).toBe('The step "step" failed because it ran past its deadline.');
    expect(clauses[5]).toBe('The step "step" failed for a reason that could not be classified.');
  });

  it('names the run when no step was recorded, and flattens a label to one line', () => {
    expect(summarizeRunFailure({ category: 'system', errorKind: null, step: null })).toBe(
      'The run failed because of a fault in the server, its storage or a worker.',
    );
    expect(
      summarizeRunFailure({
        category: 'timeout',
        errorKind: 'generate',
        step: { index: 0, label: 'two\nlines\t here' },
      }),
    ).toBe(
      'The step "two lines here" failed because it ran past its deadline while asking the model for a reply.',
    );
  });

  it('adds no clause for a kind it does not know', () => {
    expect(
      summarizeRunFailure({
        category: 'application',
        errorKind: 'constructor',
        step: { index: 0, label: 'x' },
      }),
    ).toBe('The step "x" failed because the code it ran raised an error.');
  });
});

describe('classifyAgentRunFailure', () => {
  it.each([
    ['timed-out', null, 'timeout'],
    ['deadline-exceeded', null, 'timeout'],
    ['owner-lost', null, 'system'],
    ['budget-exceeded', null, 'resource'],
    ['maximum-steps', null, 'resource'],
    ['error', 'tool', 'application'],
    ['error', null, 'application'],
    ['error', 'abort', 'cancellation'],
    ['tripwire', 'policy', 'application'],
    ['elicitation-denied', null, 'application'],
    ['something-new', 'tool', null],
    [null, 'tool', null],
  ] as const)('reads finish reason %s and kind %s as %s', (finishReason, errorKind, expected) => {
    expect(classifyAgentRunFailure({ finishReason, errorKind })).toBe(expected);
  });
});

describe('explainRunFailure', () => {
  it('answers the same for the same facts (AC2)', () => {
    expect(explainRunFailure(factsOf())).toEqual(explainRunFailure(factsOf()));
  });

  it('carries the cause, the step, the tries and the verdicts as they are stored (AC1, AC4)', () => {
    const verdicts = [
      { name: 'pii', kind: 'tripwire', outcome: 'tripwire', step: 0 },
      { name: 'tone', kind: 'guardrail', outcome: 'warn', step: null },
    ] as const;
    const explanation = explainRunFailure(factsOf({ verdicts }));
    expect(explanation).toMatchObject({
      cause: { category: 'application', code: 'UNKNOWN', kind: 'tool' },
      step: { index: 2, label: 'charge-card' },
      tries: 3,
      verdicts,
    });
    expect(Object.keys(explanation).toSorted()).toEqual(
      ['cause', 'nextCommands', 'remediation', 'step', 'summary', 'tries', 'verdicts'].toSorted(),
    );
  });

  it('has a remediation for every category, and says so for a tripwire', () => {
    const remediations = [...RUN_FAILURE_CATEGORIES, null].map(
      (category) => explainRunFailure(factsOf({ category })).remediation,
    );
    expect(new Set(remediations).size).toBe(6);
    const halted = explainRunFailure(
      factsOf({ verdicts: [{ name: 'pii', kind: 'tripwire', outcome: 'tripwire', step: 0 }] }),
    ).remediation;
    expect(halted).toContain('A guardrail halted this run');
    const warned = explainRunFailure(
      factsOf({ verdicts: [{ name: 'tone', kind: 'guardrail', outcome: 'warn', step: 0 }] }),
    ).remediation;
    expect(warned).not.toContain('halted');
  });
});

describe('nextCommands (AC5)', () => {
  it('reads a run with `runs get`, naming its kind', () => {
    expect(nextCommandsFor('agent', 'run-1')).toEqual(['interborough runs get --kind task run-1']);
    expect(nextCommandsFor('workflow', 'run-1')).toEqual([
      'interborough runs get --kind workflow run-1',
    ]);
  });

  it('quotes an identifier the shell would split or expand', () => {
    expect(nextCommandsFor('agent', "it's a run; rm")).toEqual([
      `interborough runs get --kind task 'it'\\''s a run; rm'`,
    ]);
  });
});
