/**
 * Guard for COR-1672: a Gemini-issued call id (`providerCallId`) must survive every projection a
 * parsed call and its result pass through, because Gemini echoes it as `functionResponse.id` and
 * two calls to one function pair only by it. Each case below drives the real path: Operative's
 * step (`materializeToolCalls`, the toolbox, the conversation), an approval resume, an idempotency
 * cache hit, the toolbox `complete` event, and a Conversationalist append.
 */
import {
  createTool,
  createToolbox,
  createToolResultCache,
  formatGeminiToolResults,
  parseGeminiToolCalls,
  type SignedPendingToolApproval,
  type ToolExecutionResult,
  withToolboxIdempotency,
} from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, materializeToolCalls, toGeminiMessages } from 'conversationalist';
import { z } from 'zod';

import { HookRegistry } from '@lostgradient/lifecycle';
import { noToolCalls } from './conditions/predicates';

import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import { sealDanglingToolCalls } from './run-step-support';
import type { GenerateResponse } from './types';

const requestContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-a',
  runId: 'run-a',
};

function memoryStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) =>
      [...map.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
  };
}

const lookup = createTool({
  name: 'lookup',
  version: '1.0.0',
  description: 'Looks something up',
  input: z.object({ q: z.string() }),
  idempotencyKey: (input: unknown) => JSON.stringify(input),
  execute: async ({ q }) => ({ q }),
});

function geminiCalls() {
  return parseGeminiToolCalls([
    { functionCall: { id: 'gem-1', name: 'lookup', args: { q: 'first' } } },
    { functionCall: { id: 'gem-2', name: 'lookup', args: { q: 'second' } } },
  ]);
}

function echoedIds(results: readonly ToolExecutionResult[]): Array<string | undefined> {
  return formatGeminiToolResults([...results]).map((part) => part.functionResponse.id);
}

describe('Gemini providerCallId provenance', () => {
  it('survives Operative step execution, the complete event, and a conversation append', async () => {
    const toolbox = createToolbox([lookup]);
    const completed: Array<string | undefined> = [];
    toolbox.addEventListener('complete', (event) => {
      completed.push((event as unknown as { result: ToolExecutionResult }).result.providerCallId);
    });
    let step = 0;
    const result = await executeLoop({
      generate: async (): Promise<GenerateResponse> =>
        step++ === 0
          ? { content: '', toolCalls: geminiCalls() }
          : { content: 'done', toolCalls: [] },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });
    expect(result.finishReason).toBe('stop-condition');
    expect(completed.toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual([
      'gem-1',
      'gem-2',
    ]);

    const stored = result.conversation
      .getMessages()
      .flatMap((message) => (message.toolResult ? [message.toolResult] : []));
    expect(stored.map((toolResult) => toolResult.providerCallId)).toEqual(['gem-1', 'gem-2']);
    const storedCalls = result.conversation
      .getMessages()
      .flatMap((message) => (message.toolCall ? [message.toolCall] : []));
    expect(storedCalls.map((toolCall) => toolCall.providerCallId)).toEqual(['gem-1', 'gem-2']);
    expect(formatGeminiToolResults(stored).map((part) => part.functionResponse.id)).toEqual([
      'gem-1',
      'gem-2',
    ]);
  });

  it('survives materializeToolCalls and an explicit conversation append', async () => {
    const toolbox = createToolbox([lookup]);
    const calls = materializeToolCalls(geminiCalls());
    expect(calls.map((call) => call.providerCallId)).toEqual(['gem-1', 'gem-2']);
    const results = await toolbox.execute(calls);
    const conversation = new Conversation();
    conversation.appendToolCalls(calls);
    conversation.appendToolResults(results);
    const stored = conversation
      .getMessages()
      .flatMap((message) => (message.toolResult ? [message.toolResult] : []));
    expect(stored.map((toolResult) => toolResult.providerCallId)).toEqual(['gem-1', 'gem-2']);
  });

  it('survives an approval resume', async () => {
    const approvalSecret = 'secret';
    const toolbox = createToolbox([lookup], {
      approvalSecret,
      policy: {
        beforeExecute: (context) =>
          (context.params as { confirmed?: boolean } | undefined)?.confirmed === true
            ? { allow: true }
            : {
                allow: false,
                status: 'needs_approval',
                reason: 'approval required',
                action: { message: 'Approve' },
              },
      },
    });
    const [call] = parseGeminiToolCalls([
      { functionCall: { id: 'gem-9', name: 'lookup', args: { q: 'held' } } },
    ]);
    const paused = await toolbox.execute(call!, { requestContext });
    expect(paused.outcome).toBe('action_required');
    expect(paused.providerCallId).toBe('gem-9');
    expect(paused.pendingApproval?.providerCallId).toBe('gem-9');
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        arguments: { q: 'held', confirmed: true },
        requestContext,
      },
    );
    expect(resumed.outcome).toBe('success');
    expect(echoedIds([resumed])).toEqual(['gem-9']);
  });

  it('survives an idempotency cache hit', async () => {
    const toolbox = withToolboxIdempotency(createToolbox([lookup]), {
      cache: createToolResultCache({ store: memoryStore(), defaultTTL: 60_000 }),
      tenantId: 'tenant-a',
    });
    const [first] = parseGeminiToolCalls([
      { functionCall: { id: 'gem-a', name: 'lookup', args: { q: 'same' } } },
    ]);
    const [second] = parseGeminiToolCalls([
      { functionCall: { id: 'gem-b', name: 'lookup', args: { q: 'same' } } },
    ]);
    const executed = await toolbox.execute(first!, { requestContext });
    const replayed = await toolbox.execute(second!, { requestContext });
    expect(echoedIds([executed])).toEqual(['gem-a']);
    expect(echoedIds([replayed])).toEqual(['gem-b']);
  });

  it('survives the onError skip result and sealed dangling-call results', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onError', async () => 'skip');
    hooks.on('beforeToolExecution', () => {
      throw new Error('hook failed');
    });
    let step = 0;
    const result = await executeLoop({
      generate: async (): Promise<GenerateResponse> =>
        step++ === 0
          ? { content: '', toolCalls: geminiCalls() }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      runId: 'run-1',
    });
    const skipped = result.conversation
      .getMessages()
      .flatMap((message) => (message.toolResult ? [message.toolResult] : []));
    expect(skipped.map((toolResult) => toolResult.providerCallId)).toEqual(['gem-1', 'gem-2']);

    const conversation = new Conversation();
    const calls = materializeToolCalls(geminiCalls());
    conversation.appendToolCalls(calls);
    const sealed = await sealDanglingToolCalls(conversation, false, 'cancelled', calls);
    expect(sealed.map((toolResult) => toolResult.providerCallId)).toEqual(['gem-1', 'gem-2']);
    expect(echoedIds(sealed)).toEqual(['gem-1', 'gem-2']);
  });

  it('emits functionCall.id and functionResponse.id on the second model request', async () => {
    let step = 0;
    let secondRequest: ReturnType<typeof toGeminiMessages> | undefined;
    await executeLoop({
      generate: async (context): Promise<GenerateResponse> => {
        if (step++ === 0) return { content: '', toolCalls: geminiCalls() };
        secondRequest = toGeminiMessages(context.conversation.current);
        return { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([lookup]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runId: 'run-1',
    });
    const parts = (secondRequest?.contents ?? []).flatMap((content) => content.parts);
    const idsOf = (key: 'functionCall' | 'functionResponse') =>
      parts.flatMap((part) => {
        const body: unknown = Reflect.get(part, key);
        return body === undefined ? [] : [Reflect.get(Object(body), 'id') as string | undefined];
      });
    expect(idsOf('functionCall')).toEqual(['gem-1', 'gem-2']);
    expect(
      idsOf('functionResponse').toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    ).toEqual(['gem-1', 'gem-2']);
  });
});
