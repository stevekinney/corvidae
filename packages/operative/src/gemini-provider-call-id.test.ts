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
import { Conversation, materializeToolCalls } from 'conversationalist';
import { z } from 'zod';
import { createGatedExecute } from './active-skill-tool-gate';

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

  it('survives the active-skill refusal', async () => {
    const toolbox = createToolbox([lookup]);
    const gated = createGatedExecute(
      toolbox,
      (calls, options) => toolbox.execute(calls as never, options as never),
      () => [],
    );
    const results = (await gated(geminiCalls())) as ToolExecutionResult[];
    expect(results.map((result) => result.error?.code)).toEqual([
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
    ]);
    expect(echoedIds(results)).toEqual(['gem-1', 'gem-2']);
  });
});
