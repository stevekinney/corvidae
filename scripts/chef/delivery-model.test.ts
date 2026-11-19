import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
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
  expect(
    await throwingRejectionOf(
      recordMutationIntent(state, first.authority, {
        operationId: 'merge:COR-9',
        action: 'merge',
        intentFingerprint: 'changed-intent',
      }),
    ),
  ).toThrow('already names merge');

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
