import { describe, expect, test } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing';
import type { CheckpointState, CheckpointSummary, WorkflowReplay } from '@lostgradient/weft';

import {
  checkpointAtQueryKey,
  checkpointsListQueryKey,
  type CheckpointsOperationsClient,
  getCheckpointAt,
  listCheckpoints,
  replayQueryKey,
  replayWorkflow,
} from './checkpoints-data.ts';

describe('query keys', () => {
  test('are namespaced and stable', () => {
    expect(checkpointsListQueryKey('wf-1')).toEqual(['workflows', 'checkpoints', 'wf-1']);
    expect(checkpointAtQueryKey('wf-1', 5)).toEqual(['workflows', 'checkpoints', 'wf-1', 5]);
    expect(replayQueryKey('wf-1', 5)).toEqual(['workflows', 'replay', 'wf-1', 5]);
  });
});

describe('listCheckpoints', () => {
  test('calls weft.workflows.checkpoints.list with the workflow id', async () => {
    const summaries: CheckpointSummary[] = [{ step: 3, timestamp: 1_000, sizeBytes: 128 }];
    const received: { input: unknown } = { input: null };
    const client: CheckpointsOperationsClient = {
      operations: {
        'weft.workflows.checkpoints.list': async (input) => {
          received.input = input;
          return summaries;
        },
        'weft.workflows.checkpoints.get': async () => ({
          step: 0,
          locals: {},
          searchAttributes: {},
          version: '1',
          createdAt: 0,
        }),
      },
    };

    const result = await listCheckpoints(client, 'wf-1');

    expect(received.input).toEqual({ workflowId: 'wf-1' });
    expect(result).toBe(summaries);
  });
});

describe('getCheckpointAt', () => {
  test('calls weft.workflows.checkpoints.get with the workflow id and step', async () => {
    const checkpoint: CheckpointState = {
      step: 5,
      locals: { sandboxId: 'sbx_1' },
      searchAttributes: {},
      version: '1',
      createdAt: 1_000,
    };
    const received: { input: unknown } = { input: null };
    const client: CheckpointsOperationsClient = {
      operations: {
        'weft.workflows.checkpoints.list': async () => [],
        'weft.workflows.checkpoints.get': async (input) => {
          received.input = input;
          return checkpoint;
        },
      },
    };

    const result = await getCheckpointAt(client, 'wf-1', 5);

    expect(received.input).toEqual({ workflowId: 'wf-1', step: 5 });
    expect(result).toBe(checkpoint);
  });
});

describe('replayWorkflow', () => {
  test('preserves the replay fields returned by the generated operation', async () => {
    const replay: WorkflowReplay = {
      checkpoint: { step: 2, locals: {}, searchAttributes: {}, version: '1', createdAt: 1_000 },
      accumulatedResults: [],
      events: [],
    };
    const received: unknown[] = [];
    const client = {
      operations: {
        'weft.workflows.replay': async (input: { workflowId: string; step: number }) => {
          received.push(input);
          return { ...replay, compactedBefore: 3, revision: 'revision-a' };
        },
      },
    };

    const result = await replayWorkflow(client, 'wf-1', 2);

    expect(received).toEqual([{ workflowId: 'wf-1', step: 2 }]);
    expect(result).toEqual({ ...replay, compactedBefore: 3, revision: 'revision-a' });
  });

  test('rejects malformed replay data and preserves the legitimate empty answer', async () => {
    const empty = await replayWorkflow(
      { operations: { 'weft.workflows.replay': async () => null } },
      'wf-1',
      2,
    );
    expect(empty).toBeNull();
    const problem = await throwingRejectionOf(
      replayWorkflow(
        { operations: { 'weft.workflows.replay': async () => ({ events: [] }) } },
        'wf-1',
        2,
      ),
    );
    expect(problem).toThrow('weft.workflows.replay returned an unexpected shape');
  });
});
