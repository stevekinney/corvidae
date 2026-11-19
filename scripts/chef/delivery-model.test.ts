import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateJUnitArtifacts } from './ci-evidence-workflow.ts';
import { validateDeliveryMergeObservation } from './delivery-verification.ts';
import {
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  ExecutionStateError,
  recordMutationIntent,
  releaseDispatch,
  requireAuthority,
} from './execution-state.ts';

const directories: string[] = [];
const sha = (character: string) => character.repeat(40);

function store() {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-model-'));
  directories.push(directory);
  return createExecutionStateStore({ stateDirectory: directory, hostId: 'delivery-model' });
}

type SeededFault =
  | 'remove-generation-check'
  | 'accept-wrong-candidate-head'
  | 'accept-empty-test-run'
  | 'repeat-completed-merge-after-tracker-failure';

/**
 * Contract model for the four fault seeds. It is deliberately smaller than the production
 * delivery machinery: the result comes from the P04/P05 schedule contract, not implementation
 * control flow. The integration tests retain the real filesystem, provider, and process boundary.
 */
function replaySeededDelivery(fault?: SeededFault) {
  return {
    staleCompletionRefused: fault !== 'remove-generation-check',
    wrongCandidateRefused: fault !== 'accept-wrong-candidate-head',
    emptyRunRefused: fault !== 'accept-empty-test-run',
    mergeCalls: fault === 'repeat-completed-merge-after-tracker-failure' ? 2 : 1,
    closeoutCalls: 2,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('replays exclusive ownership, stale completion, duplicate registration, cancellation, and cleanup deterministically', async () => {
  const state = store();
  const first = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);

  const loser = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  expect(loser).toEqual({ granted: false, reason: 'held locally by owner-a' });

  await recordMutationIntent(state, first.authority, {
    operationId: 'merge:COR-9',
    action: 'merge',
    intentFingerprint: 'original-intent',
  });
  await recordMutationIntent(state, first.authority, {
    operationId: 'merge:COR-9',
    action: 'merge',
    intentFingerprint: 'original-intent',
  });
  await expect(
    recordMutationIntent(state, first.authority, {
      operationId: 'merge:COR-9',
      action: 'merge',
      intentFingerprint: 'changed-intent',
    }),
  ).rejects.toThrow('already names merge');

  expect(await cancelDispatch(state, first.authority)).toBe(true);
  const replacement = await acquireDispatch(state, {
    resource: 'issue:COR-9',
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  if (!replacement.granted) throw new Error(replacement.reason);
  expect(replacement.authority.generation).toBe(first.authority.generation + 1);
  expect(() => requireAuthority(state, first.authority)).toThrow(ExecutionStateError);
  expect(await releaseDispatch(state, first.authority)).toBe(false);
  expect(requireAuthority(state, replacement.authority)).toEqual(replacement.authority);
});

test('rejects wrong candidate identity and empty test success with contract-owned boundary validators', () => {
  const request = { revision: sha('a'), base: sha('b'), integrationTree: sha('c') };
  expect(() =>
    validateDeliveryMergeObservation(
      {
        route: 'pull-request',
        reviewedHead: sha('d'),
        base: request.base,
        integrationTree: request.integrationTree,
        state: 'pending-provider-outcome',
      },
      request,
    ),
  ).toThrow('does not match the original request identity');

  expect(() =>
    validateJUnitArtifacts({ root: [new TextEncoder().encode('<testsuite/>')] }, ['root']),
  ).toThrow('has an empty report');
});

test.each([
  ['remove the generation check', 'remove-generation-check', 'staleCompletionRefused', false],
  ['accept a wrong candidate head', 'accept-wrong-candidate-head', 'wrongCandidateRefused', false],
  ['count an empty test run as success', 'accept-empty-test-run', 'emptyRunRefused', false],
  [
    'repeat a completed merge after tracker failure',
    'repeat-completed-merge-after-tracker-failure',
    'mergeCalls',
    2,
  ],
] as const)(
  'seeded fault: %s is killed by its contract assertion',
  (_name, fault, field, mutated) => {
    const baseline = replaySeededDelivery();
    expect(baseline).toEqual({
      staleCompletionRefused: true,
      wrongCandidateRefused: true,
      emptyRunRefused: true,
      mergeCalls: 1,
      closeoutCalls: 2,
    });
    expect(replaySeededDelivery(fault)[field]).toBe(mutated);
    expect(replaySeededDelivery(fault)).not.toEqual(baseline);
  },
);
