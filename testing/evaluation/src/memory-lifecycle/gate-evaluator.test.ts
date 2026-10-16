import { describe, expect, test } from 'bun:test';

import { runReleaseGate } from '../release-gate';
import { COMMITTED_GATES_DIRECTORY, GATE_ACTOR, memoryHistory } from '../release-gate.test-support';
import { replayGateDecision } from '../replay';
import buildGateEvaluator from './gate-evaluator';
import { MEMORY_LIFECYCLE_GATE_ID } from './release';

describe('the memory-lifecycle gate evaluator module', () => {
  test('builds the lifecycle architecture in the deterministic lane', () => {
    const definition = buildGateEvaluator();
    expect(definition.configuration).toMatchObject({
      name: 'memory-lifecycle',
      environment: { name: 'memory-lifecycle/lifecycle' },
      repetitions: 1,
    });
  });

  test('passes the committed gate against the committed best simpler baseline, and replays', async () => {
    const { history } = memoryHistory();
    const result = await runReleaseGate({
      gatesDirectory: COMMITTED_GATES_DIRECTORY,
      gateId: MEMORY_LIFECYCLE_GATE_ID,
      history,
      actor: GATE_ACTOR,
    });
    expect(result.decision).toBe('pass');
    if (result.decision === 'configuration-error') return;
    const { record } = result.historical;
    expect(record.baseline?.source).toMatchObject({
      kind: 'evaluation-run',
      path: 'src/memory-lifecycle/best-simpler-baseline-run.json',
    });
    expect(record.eligibility).toEqual({ contaminationChecked: true, judge: null });
    const action = result.comparison!.criteria.find((entry) => entry.name === 'action-success')!;
    expect(action.passFraction.delta).toBeGreaterThanOrEqual(0.1);
    expect(
      await replayGateDecision({ gateId: MEMORY_LIFECYCLE_GATE_ID }, { history }),
    ).toMatchObject({
      result: 'match',
      decision: 'pass',
    });
  });
});
