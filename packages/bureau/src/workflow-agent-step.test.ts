/**
 * COR-1527 — how an `agent` step turns its run into a result or a failure, and the run id a step
 * is known by across a restart.
 */
import type { WorkflowState } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  agentStepResultFromRun,
  agentStepResultFromState,
  workflowStepRunId,
} from './workflow-agent-step';
import { WorkflowAgentStepError } from './workflow-host';

function run(finishReason: string, extra: Record<string, unknown> = {}) {
  return { content: 'text', finishReason, steps: [], ...extra } as never;
}

function stateOf(status: string, extra: Record<string, unknown> = {}): WorkflowState {
  return { status, ...extra } as never;
}

function thrown(work: () => unknown): WorkflowAgentStepError {
  try {
    work();
  } catch (error) {
    return error as WorkflowAgentStepError;
  }
  throw new Error('expected a throw');
}

describe('workflowStepRunId', () => {
  it('is the same for the same instance and step, and different for another of either', () => {
    expect(workflowStepRunId('run-1', 2)).toBe(workflowStepRunId('run-1', 2));
    expect(workflowStepRunId('run-1', 2)).not.toBe(workflowStepRunId('run-1', 3));
    expect(workflowStepRunId('run-1', 2)).not.toBe(workflowStepRunId('run-2', 2));
    expect(workflowStepRunId('run-1', 12)).not.toBe(workflowStepRunId('run-11', 2));
  });

  it('is a fixed length that fits Weft’s id limit however long the workflow id is', () => {
    const id = workflowStepRunId('w'.repeat(128), 1);
    expect(id).toMatch(/^workflow-agent-[0-9a-f]{32}$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('does not start with the prefix of a task’s run', () => {
    expect(workflowStepRunId('run-1', 0).startsWith('agent-run-')).toBe(false);
  });
});

describe('agentStepResultFromRun', () => {
  describe('a tool call that needed an approval (COR-1913)', () => {
    const stepOf = (...results: Array<Record<string, unknown>>) => ({ steps: [{ results }] });

    it('fails the step when a call ended action_required, naming the tool and the way out', () => {
      const failure = thrown(() =>
        agentStepResultFromRun(
          'writer',
          run(
            'stop-condition',
            stepOf(
              { outcome: 'success', toolName: 'read' },
              { outcome: 'action_required', toolName: 'refund' },
            ),
          ),
        ),
      );
      expect(failure).toBeInstanceOf(WorkflowAgentStepError);
      expect(failure.code).toBe('agent-run-failed');
      expect(failure.message).toContain('"refund"');
      expect(failure.message).toContain('toolApproval');
    });

    it('fails the step when Armorer could not issue the approval, as in a run with no requester', () => {
      const failure = thrown(() =>
        agentStepResultFromRun(
          'writer',
          run(
            'stop-condition',
            stepOf({
              outcome: 'error',
              toolName: 'settings-update',
              error: {
                message:
                  'Approval authorization requires request principal, tenant, audience, agentId, and runId.',
              },
            }),
          ),
        ),
      );
      expect(failure.message).toContain('"settings-update"');
    });

    it('leaves a step whose tool errors were ordinary errors, or were refused outright, as it was', () => {
      const result = agentStepResultFromRun(
        'writer',
        run(
          'stop-condition',
          stepOf(
            { outcome: 'error', toolName: 'read', error: { message: 'not found' } },
            {
              outcome: 'error',
              toolName: 'refund',
              error: { code: 'POLICY_DENIED', message: 'blocked' },
            },
          ),
        ),
      );
      expect(result.finishReason).toBe('stop-condition');
    });

    it('reports the run’s own failure first', () => {
      const failure = thrown(() =>
        agentStepResultFromRun(
          'writer',
          run('error', {
            error: new Error('boom'),
            ...stepOf({ outcome: 'action_required', toolName: 'refund' }),
          }),
        ),
      );
      expect(failure.message).toContain('boom');
    });
  });

  it('returns content, output, and finish reason, with null for an absent output', () => {
    expect(agentStepResultFromRun('writer', run('stop-condition'))).toEqual({
      content: 'text',
      output: null,
      finishReason: 'stop-condition',
    });
    expect(agentStepResultFromRun('writer', run('stop-condition', { output: { a: 1 } }))).toEqual({
      content: 'text',
      output: { a: 1 },
      finishReason: 'stop-condition',
    });
  });

  it('fails the step for every failure finish reason and for an aborted run', () => {
    for (const reason of [
      'error',
      'tripwire',
      'maximum-steps',
      'elicitation-denied',
      'budget-exceeded',
    ]) {
      const error = thrown(() =>
        agentStepResultFromRun('writer', run(reason, { error: new Error('boom') })),
      );
      expect(error).toBeInstanceOf(WorkflowAgentStepError);
      expect(error.code).toBe('agent-run-failed');
      expect(error.message).toContain('Agent "writer" failed');
      expect(error.message).toContain(reason);
    }
    const aborted = thrown(() => agentStepResultFromRun('writer', run('aborted')));
    expect(aborted.code).toBe('agent-run-aborted');
    expect(aborted.message).toContain('was aborted');
  });

  it('carries the run’s error text in the failure', () => {
    const error = thrown(() =>
      agentStepResultFromRun('writer', run('error', { error: new Error('model unavailable') })),
    );
    expect(error.message).toContain('model unavailable');
  });
});

describe('agentStepResultFromState', () => {
  it('fails a finished run whose summary names a tool that needed an approval (COR-1913)', () => {
    const state = stateOf('completed', {
      result: { content: 'done', finishReason: 'stop-condition', toolNeedingApproval: 'refund' },
    });
    const failure = thrown(() => agentStepResultFromState('writer', state));
    expect(failure.code).toBe('agent-run-failed');
    expect(failure.message).toContain('"refund"');
    // A summary that names none is a success, as before.
    expect(
      agentStepResultFromState(
        'writer',
        stateOf('completed', { result: { content: 'done', finishReason: 'stop-condition' } }),
      ).finishReason,
    ).toBe('stop-condition');
  });

  it('reads the summary the agentRun workflow recorded', () => {
    expect(
      agentStepResultFromState(
        'writer',
        stateOf('completed', {
          result: { content: 'done', finishReason: 'stop-condition', output: [1] },
        }),
      ),
    ).toEqual({ content: 'done', output: [1], finishReason: 'stop-condition' });
    expect(
      agentStepResultFromState(
        'writer',
        stateOf('completed', { result: { content: 'done', finishReason: 'stop-condition' } }),
      ).output,
    ).toBeNull();
  });

  it('fails the step for a cancelled, failed, or timed-out run, and for a run that recorded a failure result', () => {
    expect(thrown(() => agentStepResultFromState('writer', stateOf('cancelled'))).code).toBe(
      'agent-run-aborted',
    );
    expect(
      thrown(() => agentStepResultFromState('writer', stateOf('failed', { error: 'bad' }))).message,
    ).toContain('bad');
    expect(thrown(() => agentStepResultFromState('writer', stateOf('timed-out'))).code).toBe(
      'agent-run-failed',
    );
    expect(
      thrown(() =>
        agentStepResultFromState(
          'writer',
          stateOf('completed', { result: { content: '', finishReason: 'error' } }),
        ),
      ).code,
    ).toBe('agent-run-failed');
  });

  it('fails the step for a run with no record or no result', () => {
    expect(thrown(() => agentStepResultFromState('writer', null)).code).toBe('agent-run-failed');
    expect(thrown(() => agentStepResultFromState('writer', stateOf('completed'))).code).toBe(
      'agent-run-failed',
    );
  });
});
