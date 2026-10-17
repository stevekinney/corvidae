import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { RunCompletedEvent, RunErrorEvent } from './events';
import type { GenerateFunction } from './types';

/**
 * COR-1477: Bureau's task retention measures a run's age from its closing
 * `run.completed` action, never from `run.error`, because Operative marks a run
 * `error` when it dispatches `run.error` and dispatches `run.completed` after it.
 * Retention relies on that second event always coming; if a failed run ever
 * stopped emitting it, retention would silently stop deleting errored runs.
 */

async function terminalEventTypes(generate: GenerateFunction): Promise<string[]> {
  const activeRun = createActiveRun({
    generate,
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
  });
  const types: string[] = [];
  activeRun.addEventListener(RunErrorEvent.type, () => types.push(RunErrorEvent.type));
  activeRun.addEventListener(RunCompletedEvent.type, () => types.push(RunCompletedEvent.type));
  const result = await activeRun.result;
  expect(result.finishReason).toBe('error');
  return types;
}

describe('a failed run', () => {
  it('dispatches run.completed after run.error when the model throws an Error', async () => {
    expect(
      await terminalEventTypes(async () => {
        throw new Error('model unavailable');
      }),
    ).toEqual(['run.error', 'run.completed']);
  });

  it('dispatches run.completed after run.error when the model throws a non-Error value', async () => {
    expect(
      await terminalEventTypes(async () => {
        throw 'model unavailable';
      }),
    ).toEqual(['run.error', 'run.completed']);
  });
});
