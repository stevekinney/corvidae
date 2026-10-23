import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import { createTool } from '../../create-tool';
import { createToolbox } from '../../create-toolbox';
import {
  formatGeminiToolResults,
  formatGeminiToolResultsAsync,
  fromGeminiTools,
  parseGeminiToolCalls,
  toGeminiTools,
} from './index';

function approvalAction(message: string, idempotencyKey: string) {
  return {
    type: 'approval' as const,
    message,
    risk: 'high' as const,
    operation: { kind: 'other' as const },
    policyVersion: 'policy:test',
    idempotencyKey,
  };
}
describe('toGeminiTools', () => {
  const schema = z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results'),
  });

  const tool = defineTool({
    name: 'search',
    description: 'Search for items',
    input: schema,
  }) as AnyToolDefinition;

  const serializedTool = serializeToolDefinition(tool);

  describe('single tool conversion', () => {
    it('includes function name', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.name).toBe('search');
    });

    it('includes function description', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.description).toBe('Search for items');
    });

    it('includes parameters object', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty('type', 'object');
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty('properties');
    });

    it('includes required fields', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty('required');
      expect(result[0]?.functionDeclarations[0]?.parameters.required).toContain('query');
    });

    it('does not include $schema property', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).not.toHaveProperty('$schema');
    });
  });

  describe('array conversion', () => {
    it('returns a single Gemini tool for array input', () => {
      const result = toGeminiTools([serializedTool, serializedTool]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]?.functionDeclarations).toHaveLength(2);
    });

    it('returns array for empty array', () => {
      const result = toGeminiTools([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const registry = createRegistry();
      registry.register(tool);
      const result = toGeminiTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty registry', () => {
      const registry = createRegistry();
      const result = toGeminiTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('serialized tool conversion', () => {
    it('works with serialized tool definitions', () => {
      const serialized = serializeToolDefinition(tool);
      const result = toGeminiTools(serialized);
      expect(result[0]?.functionDeclarations[0]?.name).toBe('search');
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty('type', 'object');
    });
  });

  describe('usage pattern', () => {
    it('returns Gemini tools that are ready for the SDK', () => {
      const tools = toGeminiTools([tool]);

      expect(tools).toEqual([
        {
          functionDeclarations: [
            expect.objectContaining({
              name: 'search',
            }),
          ],
        },
      ]);
    });
  });
});

describe('parseGeminiToolCalls', () => {
  it('parses function call parts', () => {
    expect(
      parseGeminiToolCalls([
        { text: 'thinking' },
        { functionCall: { name: 'search', args: { query: 'gemini' } } },
      ]),
    ).toEqual([{ name: 'search', arguments: { query: 'gemini' } }]);
  });

  it('reads the all-optional function calls that @google/genai returns', () => {
    expect(
      parseGeminiToolCalls([
        { functionCall: { id: 'call-1', name: 'search', args: { query: 'id' } } },
        { functionCall: { name: 'list' } },
        { functionCall: { args: { query: 'nameless' } } },
        { functionCall: undefined },
      ]),
    ).toEqual([
      { id: 'call-1', providerCallId: 'call-1', name: 'search', arguments: { query: 'id' } },
      { name: 'list', arguments: {} },
    ]);
  });

  it('returns an empty array for missing parts', () => {
    expect(parseGeminiToolCalls(undefined)).toEqual([]);
    expect(parseGeminiToolCalls(null)).toEqual([]);
  });

  it('parses function calls from Gemini envelope shapes', () => {
    const parts = [
      {
        functionCall: {
          name: 'search',
          args: { query: 'envelope' },
        },
      },
    ];

    expect(parseGeminiToolCalls({ parts })).toEqual([
      { name: 'search', arguments: { query: 'envelope' } },
    ]);
    expect(parseGeminiToolCalls({ content: { parts } })).toEqual([
      { name: 'search', arguments: { query: 'envelope' } },
    ]);
    expect(parseGeminiToolCalls({ contents: [{ parts }] })).toEqual([
      { name: 'search', arguments: { query: 'envelope' } },
    ]);
  });

  it('returns an empty array for unsupported Gemini envelope shapes', () => {
    expect(parseGeminiToolCalls({ contents: undefined })).toEqual([]);
    expect(parseGeminiToolCalls({ unrelated: true } as never)).toEqual([]);
  });
});

describe('formatGeminiToolResults', () => {
  it('formats provider responses for success and action-required outcomes', () => {
    expect(
      formatGeminiToolResults([
        {
          callId: 'result-1',
          outcome: 'success',
          content: { ok: true },
          toolCallId: 'result-1',
          toolName: 'search',
          result: { ok: true },
        },
        {
          callId: 'call-2',
          outcome: 'action_required',
          content: { prompt: 'approve' },
          toolCallId: 'call-2',
          toolName: 'approve',
          result: { prompt: 'approve' },
          action: approvalAction('Approve this request', 'approval:gemini-format'),
        },
      ]),
    ).toEqual([
      {
        functionResponse: {
          name: 'search',
          response: { ok: true },
        },
      },
      {
        functionResponse: {
          name: 'approve',
          response: {
            outcome: 'action_required',
            content: { prompt: 'approve' },
            action: approvalAction('Approve this request', 'approval:gemini-format'),
          },
        },
      },
    ]);
  });

  it('round-trips Gemini-issued ids through execution with no formatter option', async () => {
    const lookup = createTool({
      name: 'lookup',
      version: '1.0.0',
      description: 'Look something up',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ q }),
    });
    const toolbox = createToolbox([lookup]);
    const calls = parseGeminiToolCalls([
      { functionCall: { id: 'gem-1', name: 'lookup', args: { q: 'first' } } },
      { functionCall: { id: 'gem-2', name: 'lookup', args: { q: 'second' } } },
      { functionCall: { name: 'lookup', args: { q: 'no id' } } },
    ]);
    const results = await toolbox.execute(calls);

    const parts = formatGeminiToolResults(results);
    expect(parts.map((part) => part.functionResponse.id)).toEqual(['gem-1', 'gem-2', undefined]);
    expect(parts.map((part) => part.functionResponse.response)).toEqual([
      { q: 'first' },
      { q: 'second' },
      { q: 'no id' },
    ]);
    expect(parts[2]?.functionResponse).not.toHaveProperty('id');
    const asyncParts = await formatGeminiToolResultsAsync(results);
    expect(asyncParts.map((part) => part.functionResponse.id)).toEqual([
      'gem-1',
      'gem-2',
      undefined,
    ]);
  });

  it('echoes a provider-issued id on a result with parts and never an Armorer-generated id', () => {
    const withParts = formatGeminiToolResults({
      callId: 'gem-parts',
      providerCallId: 'gem-parts',
      outcome: 'success',
      content: 'text',
      toolName: 'lookup',
      parts: [{ type: 'text', text: 'three' }],
    });
    expect(withParts[0]?.functionResponse.id).toBe('gem-parts');
    const generated = formatGeminiToolResults({
      callId: 'generated-never-parsed',
      outcome: 'success',
      content: { n: 4 },
      toolName: 'lookup',
    });
    expect(generated[0]?.functionResponse).not.toHaveProperty('id');
  });

  it('formats the marker alone, with no prior parse in this module state', async () => {
    const result = {
      callId: 'never-parsed-here',
      providerCallId: 'never-parsed-here',
      outcome: 'success' as const,
      content: { n: 1 },
      toolName: 'lookup',
    };
    expect(formatGeminiToolResults(result)[0]?.functionResponse.id).toBe('never-parsed-here');
    const asyncParts = await formatGeminiToolResultsAsync(result);
    expect(asyncParts[0]?.functionResponse.id).toBe('never-parsed-here');
    const { providerCallId: _marker, ...unmarked } = result;
    expect(formatGeminiToolResults(unmarked)[0]?.functionResponse).not.toHaveProperty('id');
  });

  it('resolves tool names from explicit mappings and defaults', () => {
    expect(
      formatGeminiToolResults(
        {
          callId: 'call-function',
          outcome: 'success',
          content: { ok: true },
        },
        {
          toolNameByCallId: (callId) =>
            callId === 'call-function' ? 'function-mapped' : undefined,
        },
      ),
    ).toEqual([
      {
        functionResponse: {
          name: 'function-mapped',
          response: { ok: true },
        },
      },
    ]);

    expect(
      formatGeminiToolResults(
        {
          callId: 'call-object',
          outcome: 'success',
          content: { ok: true },
        },
        {
          toolNameByCallId: { 'call-object': 'object-mapped' },
        },
      ),
    ).toEqual([
      {
        functionResponse: {
          name: 'object-mapped',
          response: { ok: true },
        },
      },
    ]);

    expect(
      formatGeminiToolResults(
        {
          callId: 'call-default',
          outcome: 'success',
          content: { ok: true },
        },
        {
          defaultToolName: 'fallback-name',
        },
      ),
    ).toEqual([
      {
        functionResponse: {
          name: 'fallback-name',
          response: { ok: true },
        },
      },
    ]);
  });
});

describe('formatGeminiToolResultsAsync', () => {
  it('collects stream payloads and stringifies non-JSON chunks', async () => {
    expect(
      await formatGeminiToolResultsAsync([
        {
          callId: 'call-stream',
          outcome: 'success',
          content: [],
          result: {
            async *[Symbol.asyncIterator]() {
              yield 'alpha';
              yield 'beta';
            },
          },
        },
        {
          callId: 'call-symbol',
          outcome: 'success',
          content: [],
          stream: {
            async *[Symbol.asyncIterator]() {
              yield Symbol('chunk');
            },
          },
        },
      ]),
    ).toEqual([
      {
        functionResponse: {
          name: 'unknown',
          response: { result: ['alpha', 'beta'] },
        },
      },
      {
        functionResponse: {
          name: 'unknown',
          response: { result: ['Symbol(chunk)'] },
        },
      },
    ]);
  });
});

describe('fromGeminiTools', () => {
  it('converts Gemini tools into imported tool configurations', () => {
    const imported = fromGeminiTools([
      {
        functionDeclarations: [
          {
            name: 'search',
            description: 'Search for items',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                includeArchived: { type: 'boolean', nullable: true },
              },
              required: ['query'],
            },
          },
        ],
      },
    ]);

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('search');
    expect(imported[0]?.input.safeParse({ query: 'gemini', includeArchived: null }).success).toBe(
      true,
    );
  });

  it('accepts direct function declaration input', () => {
    const imported = fromGeminiTools({
      name: 'lookup',
      description: 'Lookup',
      parameters: { type: 'object', properties: {} },
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('lookup');
  });

  it('accepts direct function declaration arrays', () => {
    const imported = fromGeminiTools([
      {
        name: 'array-tool',
        description: 'Array input',
        parameters: { type: 'object', properties: {} },
      },
    ]);

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('array-tool');
  });

  it('accepts a single Gemini tool input', () => {
    const imported = fromGeminiTools({
      functionDeclarations: [
        {
          name: 'single-tool',
          description: 'Single tool import',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('single-tool');
  });
});
