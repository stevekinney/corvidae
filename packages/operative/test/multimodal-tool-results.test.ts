import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { toolContent, type ToolResultPart } from 'armorer/protocol';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createContextAssembler } from '../src/context/assembly.ts';
import { createTokenBudget } from '../src/context/token-budget.ts';
import { createAgent } from '../src/create-agent';
import { createActiveRun } from '../src/create-run';
import { createSubagentTool, subagentToolContent } from '../src/create-subagent-tool';
import { ToolSettledBubbleEvent } from '../src/events';
import type { OperativeHookMap } from '../src/hooks';
import {
  buildAnthropicRow,
  buildGeminiRow,
  buildOpenAIRow,
} from '../src/providers/model-catalog-rows';
import { describeInputMedia, evaluateInputMedia } from '../src/providers/selection';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import { createScriptedMediaAdmitter } from '../src/testing/generated-media.test-support';
import { retainToolResultMedia } from '../src/tool-result-media';
import type { GenerateResponse, RunOptions } from '../src/types';

/**
 * COR-792: a tool's media reaches the conversation as managed assets, never as
 * the bytes or URLs the tool handed back, and no event shows its bytes.
 */
const BYTES = 'VU5JUVVFVE9PTEJZVEVT'; // "UNIQUETOOLBYTES"

const inlineImage: ToolResultPart = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: BYTES, encoding: 'base64' },
};

function chartTool(parts: readonly ToolResultPart[]) {
  return createTool({
    name: 'chart',
    description: 'Draws a chart',
    input: z.object({}),
    async execute() {
      return toolContent(parts, { value: { drawn: true } });
    },
  });
}

/** Serializes for a bytes-leak check: skips live conversations and survives cycles. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, nested: unknown) => {
    if (key === 'conversation') return undefined;
    if (typeof nested === 'object' && nested !== null) {
      if (seen.has(nested)) return undefined;
      seen.add(nested);
    }
    return nested;
  });
}

let counter = 0;
const chartCall = () => ({ id: `chart-${++counter}`, name: 'chart', arguments: {} });

function runWith(parts: readonly ToolResultPart[], extra: Partial<RunOptions> = {}) {
  const active = createActiveRun({
    generate: createMockGenerate([
      { content: '', toolCalls: [chartCall()] },
      { content: 'Done', toolCalls: [] },
    ]),
    toolbox: createTestToolbox([chartTool(parts)]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    runId: 'run-tool-media',
    ...extra,
  } as Parameters<typeof createActiveRun>[0]);
  return active;
}

function toolResultRow(conversation: Conversation) {
  return conversation.getMessages().find((message) => message.role === 'tool-result');
}

describe('tool-result media admission', () => {
  it('admits inline and data-URL media as managed assets, in order, before the row is kept', async () => {
    const admitter = createScriptedMediaAdmitter();
    const parts: ToolResultPart[] = [
      { type: 'text', text: 'Here:' },
      inlineImage,
      {
        type: 'document',
        mimeType: 'application/pdf',
        source: { kind: 'data-url', url: `data:application/pdf;base64,${BYTES}` },
      },
    ];
    const result = await runWith(parts, { generatedMediaAdmitter: admitter.port }).result;
    const row = toolResultRow(result.conversation);
    expect(row?.id).toBe(`run-tool-media:step:0:result:${row?.toolResult?.callId}`);
    expect(row?.toolResult?.content).toEqual({ drawn: true });
    expect(row?.toolResult?.parts).toEqual([
      { type: 'text', text: 'Here:' },
      { ...inlineImage, source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } },
      {
        type: 'document',
        mimeType: 'application/pdf',
        source: { kind: 'managed-asset', assetId: 'asset-2', revision: 1 },
      },
    ]);
    expect(admitter.admissions.map((record) => record.request.messageId)).toEqual([
      row?.id,
      row?.id,
    ]);
    expect(admitter.admissions[1]?.request.part.source).toEqual({
      kind: 'inline',
      data: BYTES,
      encoding: 'base64',
    });
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });

  it('keeps managed-asset and MCP-resource references without admitting them', async () => {
    const admitter = createScriptedMediaAdmitter();
    const parts: ToolResultPart[] = [
      { type: 'image', source: { kind: 'managed-asset', assetId: 'existing', revision: 4 } },
      { type: 'file', source: { kind: 'mcp-resource', serverId: 'files', uri: 'file:///a' } },
    ];
    const result = await runWith(parts, { generatedMediaAdmitter: admitter.port }).result;
    expect(toolResultRow(result.conversation)?.toolResult?.parts).toEqual(parts);
    expect(admitter.admissions).toHaveLength(0);
  });

  it('refuses a remote URL a tool hands back, as an error result the model sees', async () => {
    const admitter = createScriptedMediaAdmitter();
    const result = await runWith(
      [{ type: 'image', source: { kind: 'remote-url', url: 'https://example.com/secret.png' } }],
      { generatedMediaAdmitter: admitter.port },
    ).result;
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.outcome).toBe('error');
    expect(toolResult?.error?.code).toBe('TOOL_RESULT_MEDIA_NOT_ADMITTED');
    expect(toolResult?.error?.message).toContain('remote-url');
    expect(toolResult?.parts).toBeUndefined();
    expect(JSON.stringify(toolResult)).not.toContain('secret.png');
  });

  it('turns media into an error result when the run has no admitter', async () => {
    const result = await runWith([inlineImage]).result;
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.outcome).toBe('error');
    expect(toolResult?.error?.code).toBe('TOOL_RESULT_MEDIA_NOT_ADMITTED');
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });

  it('turns a refused admission into an error result', async () => {
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const result = await runWith([inlineImage], { generatedMediaAdmitter: admitter.port }).result;
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.outcome).toBe('error');
    expect(toolResult?.error?.message).toContain('per-part-limit-exceeded');
  });

  it('settles an admission aborted by the run, leaving no bytes behind', async () => {
    const admitter = createScriptedMediaAdmitter({
      mode: 'manual',
      onAdmit: () => active.abort('stop'),
    });
    const active = runWith([inlineImage], { generatedMediaAdmitter: admitter.port });
    const result = await active.result;
    expect(admitter.admissions[0]?.aborted).toBe(true);
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });

  it('shows events the media type and size, never the bytes', async () => {
    const admitter = createScriptedMediaAdmitter();
    const active = runWith([{ type: 'text', text: 'chart' }, inlineImage], {
      generatedMediaAdmitter: admitter.port,
    });
    const recorder = createRunRecorder(active);
    await active.result;
    expect(recorder.events.length).toBeGreaterThan(0);
    for (const { type, detail } of recorder.events) {
      expect({ type, leaked: safeStringify(detail).includes(BYTES) }).toEqual({
        type,
        leaked: false,
      });
    }
    const settled = recorder.events.find(({ type }) => type === ToolSettledBubbleEvent.type);
    expect((settled?.detail as ToolSettledBubbleEvent | undefined)?.result).toMatchObject({
      parts: [
        { type: 'text', text: 'chart' },
        { type: 'image', mimeType: 'image/png', redacted: true },
      ],
    });
  });
});

describe('tool-result media review fixes', () => {
  it('retains the managed assets a committed tool-result row references', async () => {
    const admitter = createScriptedMediaAdmitter({ retention: 'record' });
    const result = await runWith([inlineImage], { generatedMediaAdmitter: admitter.port }).result;
    const row = toolResultRow(result.conversation);
    expect(admitter.retained).toEqual([
      {
        runId: 'run-tool-media',
        messageId: row?.id ?? '',
        parts: [
          { ...inlineImage, source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } },
        ],
      },
    ]);
  });

  it('retains the admitted media of a row committed after a validateToolResult hook throws', async () => {
    const admitter = createScriptedMediaAdmitter({ retention: 'record' });
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async () => {
      throw new Error('validation failed');
    });
    const result = await runWith([inlineImage], {
      generatedMediaAdmitter: admitter.port,
      hooks,
    }).result;
    const row = toolResultRow(result.conversation);
    expect(row?.toolResult?.parts?.[0]).toMatchObject({ source: { kind: 'managed-asset' } });
    expect(admitter.retained).toEqual([
      {
        runId: 'run-tool-media',
        messageId: row?.id ?? '',
        parts: [
          { ...inlineImage, source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } },
        ],
      },
    ]);
  });

  it('admits media a validateToolResult hook adds by mutating the result in place', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (toolResult) => {
      Object.assign(toolResult, {
        parts: [{ type: 'text', text: 'see image' }, inlineImage] satisfies ToolResultPart[],
      });
    });
    const result = await runWith([{ type: 'text', text: 'ok' }], {
      generatedMediaAdmitter: admitter.port,
      hooks,
    }).result;
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.parts?.[1]).toMatchObject({ source: { kind: 'managed-asset' } });
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });

  it('admits media a hook adds in place before throwing, before the row is kept', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (toolResult) => {
      Object.assign(toolResult, {
        parts: [{ type: 'text', text: 'see image' }, inlineImage] satisfies ToolResultPart[],
      });
      throw new Error('validation failed');
    });
    const result = await runWith([{ type: 'text', text: 'ok' }], {
      generatedMediaAdmitter: admitter.port,
      hooks,
    }).result;
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.parts?.[1]).toMatchObject({ source: { kind: 'managed-asset' } });
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });

  it('retains the managed assets of a tool-result row a plugin hid', async () => {
    const managed = {
      ...inlineImage,
      source: { kind: 'managed-asset' as const, assetId: 'asset-9', revision: 1 },
    };
    const conversation = new Conversation();
    conversation.appendToolCall({ id: 'call-hidden', name: 'chart', arguments: {} });
    conversation.appendToolResult(
      { callId: 'call-hidden', outcome: 'success', content: null, parts: [managed] },
      { hidden: true },
    );
    const retained: string[] = [];
    await retainToolResultMedia(
      {
        admitter: {
          admit: async () => {
            throw new Error('not used');
          },
          retainCommitted: async ({ messageId }) => {
            retained.push(messageId);
          },
        },
        runId: 'run-hidden',
        conversation,
      },
      [
        {
          callId: 'call-hidden',
          toolCallId: 'call-hidden',
          toolName: 'chart',
          outcome: 'success',
          content: null,
          result: null,
          parts: [managed],
        },
      ],
    );
    expect(retained).toHaveLength(1);
  });

  it('admits media a validateToolResult hook adds, on any outcome, before the event shows it', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (toolResult) => ({
      ...toolResult,
      outcome: 'error' as const,
      content: 'failed',
      result: 'failed',
      parts: [{ type: 'text' as const, text: 'see image' }, inlineImage],
    }));
    const active = runWith([{ type: 'text', text: 'ok' }], {
      generatedMediaAdmitter: admitter.port,
      hooks,
    });
    const recorder = createRunRecorder(active);
    const result = await active.result;
    for (const { type, detail } of recorder.events) {
      expect({ type, leaked: safeStringify(detail).includes(BYTES) }).toEqual({
        type,
        leaked: false,
      });
    }
    const toolResult = toolResultRow(result.conversation)?.toolResult;
    expect(toolResult?.outcome).toBe('error');
    expect(toolResult?.parts?.[1]).toMatchObject({ source: { kind: 'managed-asset' } });
    expect(JSON.stringify(result.conversation.getMessages())).not.toContain(BYTES);
  });
});

describe('tool-result media capability', () => {
  const freshness = '2026-10-22T00:00:00.000Z';
  const [imageInToolResult] = describeInputMedia([
    {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'inline', data: BYTES, encoding: 'base64' },
    },
  ]).map((requirement) => ({ ...requirement, inToolResult: true as const }));

  it('admits tool-result media only on a backend that advertises it', () => {
    if (imageInToolResult === undefined) throw new Error('no requirement');
    expect(
      evaluateInputMedia(buildAnthropicRow('claude-sonnet-5-5', freshness), [imageInToolResult])
        .eligible,
    ).toBe(true);
    const openai = evaluateInputMedia(buildOpenAIRow('gpt-4.1', freshness, false), [
      imageInToolResult,
    ]);
    expect(openai).toEqual({
      eligible: false,
      exclusionReason: 'openai/gpt-4.1 accepts no image in a tool result',
    });
    expect(
      evaluateInputMedia(buildGeminiRow('gemini-2.5-pro', freshness), [imageInToolResult]).eligible,
    ).toBe(false);
  });
});

describe('sub-agent media', () => {
  const imageResponse: GenerateResponse = {
    content: 'A chart.',
    parts: [{ type: 'text', text: 'A chart.' }, inlineImage],
    toolCalls: [],
  };

  function childOptions() {
    const admitter = createScriptedMediaAdmitter();
    const child = createAgent({
      generate: createMockGenerate([imageResponse]),
      generatedMediaAdmitter: admitter.port,
    });
    return {
      name: 'draw',
      description: 'Draws',
      input: z.object({ what: z.string() }),
      agent: child,
      agentName: 'artist',
      toAgentInput: ({ what }: { what: string }) => what,
      returnMode: 'full' as const,
    };
  }

  it('refuses the default text-only projection rather than dropping the media', async () => {
    const result = await createTestToolbox([createSubagentTool(childOptions())]).execute({
      name: 'draw',
      arguments: { what: 'a chart' },
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain('returned media parts');
  });

  it('carries the child text and managed-asset media through subagentToolContent', async () => {
    const result = await createTestToolbox([
      createSubagentTool({ ...childOptions(), toToolOutput: subagentToolContent }),
    ]).execute({
      name: 'draw',
      arguments: { what: 'a chart' },
    });
    expect(result.outcome).toBe('success');
    expect(result.parts).toEqual([
      { type: 'text', text: 'A chart.' },
      { ...inlineImage, source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } },
    ]);
  });
});

describe('tool-result media in context assembly', () => {
  it("costs a tool result's media under its row and part, and its text as text", () => {
    const positions: string[] = [];
    const conversation = new Conversation();
    conversation.appendToolCall({ id: 'call-a', name: 'chart', arguments: {} });
    conversation.appendToolResult({
      callId: 'call-a',
      outcome: 'success',
      content: null,
      parts: [{ type: 'text', text: 'see' }, inlineImage],
    });
    const row = conversation.getMessages().find((message) => message.role === 'tool-result');
    const result = createContextAssembler()({
      conversation,
      budget: createTokenBudget({
        maxTokens: 100_000,
        mediaCostEstimator: (part, position) => {
          positions.push(`${position.messageId}:${position.partIndex}:${part.type}`);
          return {
            ...position,
            modality: part.type,
            outcome: 'estimated',
            tokens: 50,
            basis: 'catalog-estimate',
          };
        },
      }),
    });
    expect(positions).toEqual([`${row?.id}:1:image`]);
    expect(result.mediaCosts).toEqual([expect.objectContaining({ partIndex: 1, tokens: 50 })]);
  });

  it('does not cost the structured value beside parts, which no provider sends', () => {
    const estimated: string[] = [];
    const conversation = new Conversation();
    conversation.appendToolCall({ id: 'call-b', name: 'chart', arguments: {} });
    conversation.appendToolResult({
      callId: 'call-b',
      outcome: 'success',
      content: { sidecar: 'SIDECAR-VALUE' },
      parts: [{ type: 'text', text: 'see' }],
    });
    createContextAssembler()({
      conversation,
      budget: createTokenBudget({
        maxTokens: 100_000,
        tokenEstimator: (text) => {
          estimated.push(text);
          return 1;
        },
      }),
    });
    expect(estimated.some((text) => text.includes('SIDECAR-VALUE'))).toBe(false);
    expect(estimated).toContain('see');
  });
});
