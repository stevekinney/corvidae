import { describe, expect, test } from 'bun:test';

import {
  explainWorkerBinding,
  overrideEligibility,
  readWorkflowWorkerState,
  type WorkerBindingReading,
} from './workflow-worker-binding.ts';

const BINDING = {
  workflowId: 'wf-1',
  workflowType: 'order',
  deploymentName: 'orders',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  manifestDigest: 'sha256:manifest-1',
  routingGeneration: 3,
  workflowRevision: 'rev-a',
  workflowContractHash: 'wch-1',
  activityContracts: { charge: 'ach-1' },
  activityName: 'charge',
  activityContractHash: 'ach-1',
  boundAt: 1_700_000_000_000,
  checkpointId: 'wf-1',
};

const COMPATIBILITY = {
  deploymentName: 'orders',
  buildId: 'build-2',
  artifactDigest: 'sha256:artifact-2',
  manifestDigest: 'sha256:manifest-2',
  workflowRevision: 'rev-a',
  activityContractHash: 'ach-1',
};

function bound(
  policy: unknown,
  history: unknown[] = [],
  status = 'completed',
): Record<string, unknown> {
  return {
    id: 'wf-1',
    type: 'order',
    status,
    workerVersioningPolicy: policy,
    workerBinding: { current: BINDING, history },
  };
}

function boundReading(reading: WorkerBindingReading) {
  if (reading.kind !== 'bound') throw new Error(`expected bound, got ${reading.kind}`);
  return reading;
}

describe('readWorkflowWorkerState', () => {
  test('a record with neither a policy nor a binding is absent', () => {
    expect(readWorkflowWorkerState({ id: 'wf-1', status: 'running' })).toEqual({ kind: 'absent' });
  });

  test('reads a pinned policy and its binding', () => {
    const reading = boundReading(readWorkflowWorkerState(bound({ mode: 'pinned' })));
    expect(reading.policy).toEqual({ mode: 'pinned' });
    expect(reading.record.current.buildId).toBe('build-1');
    expect(reading.record.history).toEqual([]);
  });

  test('a policy with no mode is pinned', () => {
    const reading = boundReading(readWorkflowWorkerState(bound({ maxBindingHistory: 4 })));
    expect(explainWorkerBinding(reading)).toContain('Pinned');
    expect(overrideEligibility(reading, 'completed').eligible).toBe(false);
  });

  test('reads an auto-upgrade policy with its compatibility fields and history', () => {
    const earlier = { ...BINDING, buildId: 'build-0', routingGeneration: 1 };
    const reading = boundReading(
      readWorkflowWorkerState(
        bound({ mode: 'auto-upgrade', compatibility: COMPATIBILITY }, [earlier]),
      ),
    );
    expect(reading.policy.mode).toBe('auto-upgrade');
    expect(reading.policy.mode === 'auto-upgrade' && reading.policy.compatibility.buildId).toBe(
      'build-2',
    );
    expect(reading.record.history.map((entry) => entry.buildId)).toEqual(['build-0']);
  });

  test.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
  ])('%s is malformed', (_label, value) => {
    expect(readWorkflowWorkerState(value).kind).toBe('malformed');
  });

  test('a binding without a policy is malformed', () => {
    const state = bound({ mode: 'pinned' });
    delete state['workerVersioningPolicy'];
    expect(readWorkflowWorkerState(state).kind).toBe('malformed');
  });

  test('a policy without a binding is malformed', () => {
    const state = bound({ mode: 'pinned' });
    delete state['workerBinding'];
    expect(readWorkflowWorkerState(state).kind).toBe('malformed');
  });

  test('a policy whose binding history limit is not a number is malformed, and says so', () => {
    expect(readWorkflowWorkerState(bound({ mode: 'pinned', maxBindingHistory: '4' }))).toEqual({
      kind: 'malformed',
      reason: 'workerVersioningPolicy.maxBindingHistory is not a number',
    });
  });

  test('an unknown policy mode is malformed', () => {
    expect(readWorkflowWorkerState(bound({ mode: 'eager' })).kind).toBe('malformed');
  });

  test('an auto-upgrade policy missing a compatibility field is malformed', () => {
    const { artifactDigest: _omitted, ...incomplete } = COMPATIBILITY;
    expect(
      readWorkflowWorkerState(bound({ mode: 'auto-upgrade', compatibility: incomplete })).kind,
    ).toBe('malformed');
  });

  test('a binding with a mistyped field is malformed and names the field', () => {
    const state = bound({ mode: 'pinned' });
    state['workerBinding'] = { current: { ...BINDING, routingGeneration: '3' }, history: [] };
    const reading = readWorkflowWorkerState(state);
    expect(reading.kind).toBe('malformed');
    expect(reading.kind === 'malformed' && reading.reason).toContain('routingGeneration');
  });

  test('a history entry that fails the binding guard is malformed', () => {
    expect(readWorkflowWorkerState(bound({ mode: 'pinned' }, [{ buildId: 'x' }])).kind).toBe(
      'malformed',
    );
  });

  test('an activityContracts map with a non-string value is malformed', () => {
    const state = bound({ mode: 'pinned' });
    state['workerBinding'] = {
      current: { ...BINDING, activityContracts: { charge: 1 } },
      history: [],
    };
    expect(readWorkflowWorkerState(state).kind).toBe('malformed');
  });
});

describe('explainWorkerBinding', () => {
  test('pinned: states the run stays on its build and names it', () => {
    const text = explainWorkerBinding(
      boundReading(readWorkflowWorkerState(bound({ mode: 'pinned' }))),
    );
    expect(text).toContain('Pinned');
    expect(text).toContain('build-1');
    expect(text).toContain('orders');
    expect(text).toContain('never moves');
  });

  test('auto-upgrade: names the compatibility target and the checkpoint boundary', () => {
    const text = explainWorkerBinding(
      boundReading(
        readWorkflowWorkerState(bound({ mode: 'auto-upgrade', compatibility: COMPATIBILITY })),
      ),
    );
    expect(text).toContain('Auto-upgrade');
    expect(text).toContain('build-2');
    expect(text).toContain('checkpoint');
    expect(text).toContain('build-1');
  });

  test('auto-upgrade: says how many earlier bindings the history holds', () => {
    const earlier = { ...BINDING, buildId: 'build-0' };
    const text = explainWorkerBinding(
      boundReading(
        readWorkflowWorkerState(
          bound({ mode: 'auto-upgrade', compatibility: COMPATIBILITY }, [earlier]),
        ),
      ),
    );
    expect(text).toContain('1 earlier binding');
  });
});

describe('overrideEligibility', () => {
  test('a terminal auto-upgrade run is eligible', () => {
    const reading = readWorkflowWorkerState(
      bound({ mode: 'auto-upgrade', compatibility: COMPATIBILITY }, [], 'failed'),
    );
    expect(overrideEligibility(reading, 'failed')).toEqual({ eligible: true });
  });

  test('a pinned run is not eligible and the reason names the pin', () => {
    const result = overrideEligibility(
      readWorkflowWorkerState(bound({ mode: 'pinned' })),
      'completed',
    );
    expect(result.eligible).toBe(false);
    expect(!result.eligible && result.reason).toContain('pinned');
    expect(!result.eligible && result.reason).toContain('cannot be overridden');
  });

  test('a running auto-upgrade run is not eligible and the reason says terminal', () => {
    const reading = readWorkflowWorkerState(
      bound({ mode: 'auto-upgrade', compatibility: COMPATIBILITY }, [], 'running'),
    );
    const result = overrideEligibility(reading, 'running');
    expect(result.eligible).toBe(false);
    expect(!result.eligible && result.reason).toContain('terminal');
  });

  test('a run with no worker binding is not eligible', () => {
    const result = overrideEligibility({ kind: 'absent' }, 'completed');
    expect(result.eligible).toBe(false);
    expect(!result.eligible && result.reason).toContain('no worker version');
  });

  test('a malformed reading is not eligible', () => {
    expect(overrideEligibility({ kind: 'malformed', reason: 'x' }, 'completed').eligible).toBe(
      false,
    );
  });
});
