import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  formatAnthropicToolResults,
  formatAnthropicToolResultsAsync,
} from '../src/adapters/anthropic';
import { formatGeminiToolResults, formatGeminiToolResultsAsync } from '../src/adapters/gemini';
import { formatOpenAIToolResults, formatOpenAIToolResultsAsync } from '../src/adapters/openai';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createToolResultCache } from '../src/idempotency/create-tool-result-cache';
import { withToolboxIdempotency } from '../src/idempotency/with-toolbox-idempotency';
import {
  assertToolResultParts,
  isToolContent,
  materializeToolResult,
  toolContent,
  type ToolResultPart,
} from '../src/protocol';
import type { SignedPendingToolApproval } from '../src/types';

const PARTS: ToolResultPart[] = [
  { type: 'text', text: 'Here is the chart:' },
  {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: 'iVBORw0KGgo=', encoding: 'base64' },
  },
  { type: 'text', text: 'and the source data.' },
  {
    type: 'document',
    mimeType: 'application/pdf',
    source: { kind: 'managed-asset', assetId: 'asset-1', revision: 2 },
  },
];

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

function chartTool(onExecute: () => void = () => {}) {
  return createTool({
    name: 'chart',
    description: 'Draws a chart',
    input: z.object({ series: z.string() }),
    idempotencyKey: (input) => (input as { series: string }).series,
    async execute({ series }) {
      onExecute();
      return toolContent(PARTS, { value: { series, points: 3 } });
    },
  });
}

describe('tool-result parts contract', () => {
  it('validates parts and keeps them in order', () => {
    const content = toolContent(PARTS, { value: { ok: true } });
    expect(content.parts).toEqual(PARTS);
    expect(isToolContent(JSON.parse(JSON.stringify(content)))).toBe(true);
    expect(isToolContent({ kind: 'armorer.tool-content', parts: [{ type: 'video' }] })).toBe(false);
    expect(() =>
      toolContent([{ type: 'image', source: { kind: 'remote-url' } } as unknown as ToolResultPart]),
    ).toThrow(/part 0 is invalid: source.url must be a string/);
    expect(() => toolContent([])).toThrow(/must not be empty/);
    expect(() =>
      assertToolResultParts([{ type: 'thinking', thinking: 'x', signature: 'y' }]),
    ).toThrow(/"thinking" is not a tool-result part type/);
    expect(() =>
      assertToolResultParts([
        { type: 'file', source: { kind: 'managed-asset', assetId: 'a', revision: -1 } },
      ]),
    ).toThrow(/revision must be a non-negative integer/);
  });

  it('turns a tool returning toolContent into ordered parts beside its JSON value', async () => {
    const result = await createToolbox([chartTool()]).execute({
      id: 'call-1',
      name: 'chart',
      arguments: { series: 'sales' },
    });
    expect(result.outcome).toBe('success');
    expect(result.parts).toEqual(PARTS);
    expect(result.content).toEqual({ series: 'sales', points: 3 });
  });

  it('leaves a plain JSON result without parts', async () => {
    const tool = createTool({
      name: 'plain',
      description: 'Returns JSON',
      input: z.object({}),
      async execute() {
        return { answer: 42 };
      },
    });
    const result = await createToolbox([tool]).execute({ name: 'plain', arguments: {} });
    expect(result.content).toEqual({ answer: 42 });
    expect(Object.hasOwn(result, 'parts')).toBe(false);
    expect(Object.hasOwn(materializeToolResult(result), 'parts')).toBe(false);
  });

  it('digests the whole return value, parts included', async () => {
    const digest = async (parts: ToolResultPart[]) => {
      const tool = createTool({
        name: 'digested',
        description: 'Digested output',
        input: z.object({}),
        digests: true,
        async execute() {
          return toolContent(parts);
        },
      });
      const result = await createToolbox([tool]).execute({ name: 'digested', arguments: {} });
      return result.outputDigest;
    };
    const first = await digest(PARTS);
    expect(first).toEqual(expect.any(String));
    expect(await digest(PARTS)).toBe(first);
    expect(await digest(PARTS.toReversed())).not.toBe(first);
  });

  it('materializes parts for persistence and survives a JSON round trip', async () => {
    const result = await createToolbox([chartTool()]).execute({
      id: 'call-2',
      name: 'chart',
      arguments: { series: 'sales' },
    });
    const materialized = materializeToolResult(result);
    expect(materialized).toEqual({
      callId: 'call-2',
      outcome: 'success',
      content: { series: 'sales', points: 3 },
      parts: PARTS,
    });
    expect(materializeToolResult(JSON.parse(JSON.stringify(materialized)))).toEqual(materialized);
    expect(() =>
      materializeToolResult({ callId: 'x', outcome: 'success', content: null, parts: [{}] }),
    ).toThrow(/part 0 is invalid/);
  });

  it('materializes a raw toolContent payload into parts', () => {
    expect(
      materializeToolResult({
        callId: 'raw',
        outcome: 'success',
        content: toolContent(PARTS, { value: 'summary' }),
      }),
    ).toEqual({ callId: 'raw', outcome: 'success', content: 'summary', parts: PARTS });
  });

  it('replays identical parts on an idempotent hit', async () => {
    let executions = 0;
    const map = new Map<string, string>();
    const cache = createToolResultCache({
      store: {
        get: async (key) => map.get(key) ?? null,
        set: async (key, value) => void map.set(key, value),
        delete: async (key) => void map.delete(key),
        list: async (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)),
      },
    });
    const toolbox = withToolboxIdempotency(createToolbox([chartTool(() => (executions += 1))]), {
      cache,
      tenantId: 'tenant-a',
    });
    const call = { name: 'chart', arguments: { series: 'sales' } };
    const fresh = await toolbox.execute(call, { requestContext });
    const replayed = await toolbox.execute(call, { requestContext });
    expect(executions).toBe(1);
    expect(replayed.idempotency?.outcome).toBe('deduped');
    expect(replayed.parts).toEqual(fresh.parts);
    expect(replayed.parts).toEqual(PARTS);
    expect(replayed.content).toEqual(fresh.content);
  });

  it('returns parts from a call that resumes after approval', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'render',
          description: 'Renders after approval',
          version: '1.0.0',
          input: z.object({ confirmed: z.boolean().optional() }),
          async execute() {
            return toolContent(PARTS);
          },
        }),
      ],
      {
        approvalSecret: 'test-secret',
        policy: {
          beforeExecute(context) {
            const params = context.params as { confirmed?: boolean } | undefined;
            return params?.confirmed === true
              ? { allow: true }
              : { allow: false, status: 'needs_approval', reason: 'Approve render' };
          },
        },
      },
    );
    const paused = await toolbox.execute(
      { id: 'call-3', name: 'render', arguments: {} },
      { requestContext },
    );
    expect(paused.error).toBeUndefined();
    expect(paused.outcome).toBe('action_required');
    expect(Object.hasOwn(paused, 'parts')).toBe(false);
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      { arguments: { confirmed: true }, requestContext },
    );
    expect(resumed.outcome).toBe('success');
    expect(resumed.parts).toEqual(PARTS);
    expect(resumed.content).toBeNull();
  });

  it('sends parts through the provider formatters, and refuses what a provider cannot carry', async () => {
    const result = await createToolbox([chartTool()]).execute({
      id: 'call-4',
      name: 'chart',
      arguments: { series: 'sales' },
    });
    // The PDF part is a managed asset: Anthropic needs inline bytes, so it is refused, not dropped.
    expect(() => formatAnthropicToolResults(result)).toThrow(
      /Anthropic cannot carry tool-result part 3/,
    );
    expect(formatAnthropicToolResults({ ...result, parts: PARTS.slice(0, 3) })[0]?.content).toEqual(
      [
        { type: 'text', text: 'Here is the chart:' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
        { type: 'text', text: 'and the source data.' },
      ],
    );
    expect(() => formatOpenAIToolResults(result)).toThrow(/OpenAI cannot carry tool-result part 1/);
    const textOnly = { ...result, parts: [{ type: 'text' as const, text: 'one' }] };
    expect(formatOpenAIToolResults(textOnly)[0]?.content).toBe('one');
    const gemini = formatGeminiToolResults({ ...result, parts: PARTS.slice(0, 3) })[0];
    expect(gemini?.functionResponse.response).toEqual({
      output: ['Here is the chart:', { $ref: 'part-1' }, 'and the source data.'],
    });
    expect(gemini?.functionResponse.parts).toHaveLength(1);
  });

  it('keeps a text part’s citations in Anthropic tool_result blocks', async () => {
    const result = await createToolbox([chartTool()]).execute({
      id: 'call-cite',
      name: 'chart',
      arguments: { series: 'sales' },
    });
    const citations = [{ type: 'char_location', cited_text: 'x', start_char_index: 0 }];
    const cited = { ...result, parts: [{ type: 'text' as const, text: 'see', citations }] };
    expect(formatAnthropicToolResults(cited)[0]?.content).toEqual([
      { type: 'text', text: 'see', citations },
    ]);
  });

  it('formats a settled result with parts the same way through every async formatter', async () => {
    const result = await createToolbox([chartTool()]).execute({
      id: 'call-async',
      name: 'chart',
      arguments: { series: 'sales' },
    });
    const media = { ...result, parts: PARTS.slice(0, 3) };
    const textOnly = { ...result, parts: [{ type: 'text' as const, text: 'one' }] };
    expect(await formatGeminiToolResultsAsync(media)).toEqual(formatGeminiToolResults(media));
    expect(await formatAnthropicToolResultsAsync(media)).toEqual(formatAnthropicToolResults(media));
    expect(await formatOpenAIToolResultsAsync(textOnly)).toEqual(formatOpenAIToolResults(textOnly));
  });
});
