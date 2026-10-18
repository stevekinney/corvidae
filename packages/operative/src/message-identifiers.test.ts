import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { executeLoop } from './loop';
import {
  assistantMessageIdentifier,
  toolCallMessageIdentifiers,
  toolResultMessageIdentifier,
} from './message-identifiers';
import { withStreaming } from './streaming';
import type { GenerateResponse } from './types';

const lookup = createTool({
  name: 'lookup',
  description: 'look something up',
  input: z.object({}),
  execute: async () => 'found',
});

function rowIds(conversation: Conversation): string[] {
  return conversation.getMessages({ includeHidden: true }).map((message) => message.id);
}

describe('message identifiers', () => {
  it('derives the assistant and tool-result ids from the run id and step', () => {
    expect(assistantMessageIdentifier('run-1', 3)).toBe('run-1:step:3');
    expect(toolResultMessageIdentifier('run-1', 3, 'call-9')).toBe('run-1:step:3:result:call-9');
  });

  it('derives nothing without a run id', () => {
    expect(assistantMessageIdentifier(undefined, 0)).toBeUndefined();
    expect(toolResultMessageIdentifier(undefined, 0, 'call-9')).toBeUndefined();
  });

  it('derives call rows from the assistant row when it exists, else the first call takes its id', () => {
    const calls = [{ id: 'a' }, { id: 'b' }];
    expect(toolCallMessageIdentifiers('run-1:step:0', calls, true)).toEqual([
      'run-1:step:0:call:a',
      'run-1:step:0:call:b',
    ]);
    expect(toolCallMessageIdentifiers('run-1:step:0', calls, false)).toEqual([
      'run-1:step:0',
      'run-1:step:0:call:b',
    ]);
  });
});

describe('a run with a run id commits deterministic row ids', () => {
  it('names the assistant text row of a step after the run and step', async () => {
    const conversation = new Conversation();

    await executeLoop({
      generate: async () => ({ content: 'hello', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });

    expect(rowIds(conversation)).toEqual(['run-1:step:0']);
  });

  it('names the call rows and the result rows of a step that calls a tool', async () => {
    const conversation = new Conversation();
    let calls = 0;

    await executeLoop({
      generate: async (): Promise<GenerateResponse> =>
        calls++ === 0
          ? {
              content: 'looking',
              toolCalls: [
                { id: 'call-a', name: 'lookup', arguments: {} },
                { id: 'call-b', name: 'lookup', arguments: {} },
              ],
            }
          : { content: 'done', toolCalls: [] },
      toolbox: createTestToolbox([lookup]),
      conversation,
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });

    expect(rowIds(conversation)).toEqual([
      'run-1:step:0',
      'run-1:step:0:call:call-a',
      'run-1:step:0:call:call-b',
      'run-1:step:0:result:call-a',
      'run-1:step:0:result:call-b',
      'run-1:step:1',
    ]);
  });

  it('gives the first call of a text-less step the id of the step', async () => {
    const conversation = new Conversation();
    let calls = 0;

    await executeLoop({
      generate: async (): Promise<GenerateResponse> =>
        calls++ === 0
          ? { content: '', toolCalls: [{ id: 'call-a', name: 'lookup', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createTestToolbox([lookup]),
      conversation,
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });

    expect(rowIds(conversation).slice(0, 2)).toEqual([
      'run-1:step:0',
      'run-1:step:0:result:call-a',
    ]);
  });

  it('names the row a streaming generate function appends', async () => {
    const conversation = new Conversation();

    await executeLoop({
      generate: withStreaming(async (context) => {
        context.streaming.update('hel');
        return { content: 'hello', toolCalls: [] };
      }),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });

    expect(rowIds(conversation)).toEqual(['run-1:step:0']);
  });

  it('names the row onMaximumSteps appends after the last step', async () => {
    const conversation = new Conversation();

    await executeLoop({
      generate: async () => ({
        content: 'again',
        toolCalls: [{ id: 'call-a', name: 'lookup', arguments: {} }],
      }),
      toolbox: createTestToolbox([lookup]),
      conversation,
      maximumSteps: 1,
      onMaximumSteps: async () => 'out of steps',
      runId: 'run-1',
    });

    expect(rowIds(conversation).at(-1)).toBe('run-1:step:1');
  });

  it('mints ids as before when the run has no run id', async () => {
    const conversation = new Conversation();

    await executeLoop({
      generate: async () => ({ content: 'hello', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(rowIds(conversation)[0]).not.toContain(':step:');
  });
});
