import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import {
  Conversation,
  defineMessagePlugin,
  type MessageInput,
  withMessageId,
} from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import {
  assistantMessageIdentifier,
  assistantRowIdentifierForAttempt,
  signalMessageIdentifier,
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

describe('assistantRowIdentifierForAttempt', () => {
  const assistant = (conversation: Conversation, id: string) =>
    conversation.appendMessages(withMessageId({ role: 'assistant', content: 'first attempt' }, id));

  it('keeps an id nothing holds, and replaces the earlier attempt’s row when it is the last', () => {
    const conversation = new Conversation();
    expect(assistantRowIdentifierForAttempt(conversation, 'run-1:step:0')).toBe('run-1:step:0');
    assistant(conversation, 'run-1:step:0');

    expect(assistantRowIdentifierForAttempt(conversation, 'run-1:step:0')).toBe('run-1:step:0');
    expect(rowIds(conversation)).toEqual([]);
    expect(assistantRowIdentifierForAttempt(conversation, undefined)).toBeUndefined();
  });

  it('fails loudly when the row is held anywhere but last, rather than minting an id', () => {
    const conversation = new Conversation();
    assistant(conversation, 'run-1:step:0');
    conversation.appendUserMessage('and then something else');

    expect(() => assistantRowIdentifierForAttempt(conversation, 'run-1:step:0')).toThrow(
      'is not its last row',
    );
  });
});

describe('signalMessageIdentifier', () => {
  it('names a delivery by the run, the signal, and the run’s count of parks', () => {
    expect(signalMessageIdentifier('run-1', 'human-response', 0)).toBe(
      'run-1:signal:human-response:0',
    );
    expect(signalMessageIdentifier('run-1', 'human-response', 3)).toBe(
      'run-1:signal:human-response:3',
    );
  });

  it('names nothing for a run with no id', () => {
    expect(signalMessageIdentifier(undefined, 'human-response', 0)).toBeUndefined();
  });
});

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

  it('still runs conversation plugins over the rows it names', async () => {
    const shout = defineMessagePlugin(
      { id: 'shout', revision: 1 },
      (input: MessageInput): MessageInput => ({
        ...input,
        content: typeof input.content === 'string' ? input.content.toUpperCase() : input.content,
      }),
    );
    const conversation = new Conversation(undefined, { plugins: [shout] });

    await executeLoop({
      generate: async () => ({ content: 'hello', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });

    const [row] = conversation.getMessages({ includeHidden: true });
    expect(row?.id).toBe('run-1:step:0');
    expect(row?.content).toBe('HELLO');
  });

  it('commits one row under the derived id when a step is retried after its streamed row was finalized', async () => {
    const conversation = new Conversation();
    const hooks = new HookRegistry<OperativeHookMap>();
    let failures = 0;
    hooks.on('afterGenerate', async () => {
      if (failures++ === 0) throw new Error('afterGenerate rejected the first response');
    });
    hooks.on('onError', async () => 'retry');

    const result = await executeLoop({
      generate: withStreaming(async (context) => {
        context.streaming.update('hello');
        return { content: 'hello', toolCalls: [] };
      }),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      hooks,
      runId: 'run-1',
    });

    expect(result.finishReason).not.toBe('error');
    expect(rowIds(conversation)).toEqual(['run-1:step:0']);
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
