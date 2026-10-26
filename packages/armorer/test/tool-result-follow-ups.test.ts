// COR-1634: review items deferred from COR-792 (#463), Armorer's share.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { formatOpenAIToolResults, formatOpenAIToolResultsAsync } from '../src/adapters/openai';
import { createToolbox } from '../src/create-toolbox';
import { fromMcpTools } from '../src/integrations/mcp';
import { parseMcpCallResult, toCallToolResult } from '../src/integrations/mcp/content';
import { mcpBlocksToParts, partsToMcpBlocks } from '../src/integrations/mcp/parts';
import type { ToolConfiguration } from '../src/is-tool';
import { createTruncationMiddleware } from '../src/middleware';
import {
  assertToolResultParts,
  isToolContent,
  toolContent,
  ToolResultError,
  type ToolResultPart,
} from '../src/protocol';
import { DEFAULT_TRUNCATION_MARKER } from '../src/truncation/index';

const PNG = 'iVBORw0KGgo=';
const image = { type: 'image' as const, data: PNG, mimeType: 'image/png' };
const caption = { type: 'text' as const, text: 'caption' };

describe('MCP isError results keep their non-text blocks (client direction)', () => {
  const failing = {
    isError: true,
    content: [caption, image, { type: 'text' as const, text: 'second' }],
    structuredContent: { code: 7 },
  };

  it('throws a ToolResultError that holds every block as an ordered part', () => {
    let thrown: unknown;
    try {
      parseMcpCallResult(failing, { serverId: 'files' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolResultError);
    const error = thrown as ToolResultError;
    expect(error.message).toBe('caption\nsecond');
    expect(error.content.parts.map((part) => part.type)).toEqual(['text', 'image', 'text']);
    expect(error.content.value).toEqual({ code: 7 });
  });

  it('still throws a plain error for a text-only error result', () => {
    expect(() => parseMcpCallResult({ isError: true, content: [caption] })).toThrow('caption');
    try {
      parseMcpCallResult({ isError: true, content: [caption] });
    } catch (error) {
      expect(error).not.toBeInstanceOf(ToolResultError);
    }
  });

  it('settles the tool result with the parts, and re-exposes them flagged as an error', async () => {
    const [tool] = fromMcpTools(
      [{ name: 'remote', description: 'remote', inputSchema: z.object({}) }],
      {
        callTool: async () => failing,
      },
    );
    const result = await createToolbox([tool!]).execute({
      id: 'c1',
      name: 'remote',
      arguments: {},
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toBe('caption\nsecond');
    expect(result.parts?.map((part) => part.type)).toEqual(['text', 'image', 'text']);
    expect(result.content).toEqual({ code: 7 });
    // The server direction sends the same blocks back, in order, as an error.
    expect(toCallToolResult(result)).toEqual({
      content: [caption, image, { type: 'text', text: 'second' }],
      structuredContent: { code: 7 },
      isError: true,
    });
  });

  it('keeps the error result free of parts when the tool threw an ordinary error', async () => {
    const [tool] = fromMcpTools(
      [{ name: 'remote', description: 'remote', inputSchema: z.object({}) }],
      {
        callTool: async () => ({ isError: true, content: [caption] }),
      },
    );
    const result = await createToolbox([tool!]).execute({
      id: 'c2',
      name: 'remote',
      arguments: {},
    });
    expect(result.outcome).toBe('error');
    expect(Object.hasOwn(result, 'parts')).toBe(false);
  });

  it('never puts the part bytes on the error an event shows', async () => {
    const [tool] = fromMcpTools(
      [{ name: 'remote', description: 'remote', inputSchema: z.object({}) }],
      { callTool: async () => failing },
    );
    const errors: unknown[] = [];
    const toolbox = createToolbox([tool!]);
    toolbox.addEventListener('execute-error', (event) => {
      errors.push(event.error);
    });
    toolbox.addEventListener('settled', (event) => {
      errors.push(event.error);
    });
    await toolbox.execute({ id: 'c3', name: 'remote', arguments: {} });
    toolbox.addEventListener('error', (event) => {
      errors.push(event.result);
    });
    await toolbox.execute({ id: 'c4', name: 'remote', arguments: {} });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors.at(-1))).not.toContain(PNG);
    expect(JSON.stringify(errors.at(-1))).toContain('"redacted":true');
    for (const error of errors.slice(0, -1)) {
      expect(JSON.stringify(error)).not.toContain(PNG);
      expect(Object.keys(error as object)).not.toContain('content');
    }
  });
});

describe('MCP resource provenance on re-export', () => {
  it('re-exports an embedded image resource as a resource block, not a native image', () => {
    const block = {
      type: 'resource' as const,
      resource: { uri: 'file:///chart.png', mimeType: 'image/png', blob: PNG },
    };
    const parts = mcpBlocksToParts([block], 'files');
    expect(parts[0]?.type).toBe('image');
    expect(partsToMcpBlocks(parts)).toEqual([block]);
  });

  it('re-exports an embedded audio resource as a resource block', () => {
    const block = {
      type: 'resource' as const,
      resource: { uri: 'file:///clip.wav', mimeType: 'audio/wav', blob: PNG },
    };
    expect(partsToMcpBlocks(mcpBlocksToParts([block], 'files'))).toEqual([block]);
  });

  it('still re-exports a native image block as an image block', () => {
    expect(partsToMcpBlocks(mcpBlocksToParts([image], undefined))).toEqual([image]);
  });

  it('round-trips the metadata of a resource link', () => {
    const link = {
      type: 'resource_link' as const,
      uri: 'file:///a.png',
      name: 'a',
      title: 'Chart A',
      description: 'The first chart',
      mimeType: 'image/png',
      size: 1024,
      annotations: { audience: ['user' as const], priority: 0.5 },
      _meta: { 'example.com/trace': 'abc' },
    };
    const parts = mcpBlocksToParts([link], 'files');
    expect(parts[0]).toMatchObject({ source: { kind: 'mcp-resource', serverId: 'files' } });
    expect(partsToMcpBlocks(parts)).toEqual([link]);
  });
});

describe('assertToolResultParts validates optional fields', () => {
  const base = { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/a.png' } };

  it.each(['name', 'alt', 'caption', 'transcript', 'extractedText', 'mimeType'])(
    'rejects a non-string %s',
    (field) => {
      expect(() => assertToolResultParts([{ ...base, [field]: 42 }])).toThrow(
        new RegExp(`part 0 is invalid: ${field} must be a string`),
      );
    },
  );

  it('rejects a non-JSON metadata record and non-record metadata', () => {
    expect(() => assertToolResultParts([{ ...base, metadata: [1] }])).toThrow(
      /metadata must be an object of JSON values/,
    );
    expect(() => assertToolResultParts([{ ...base, metadata: { k: () => 1 } }])).toThrow(
      /metadata must be an object of JSON values/,
    );
    expect(() => assertToolResultParts([{ ...base, metadata: { k: undefined } }])).toThrow(
      /metadata must be an object of JSON values/,
    );
  });

  it('rejects non-JSON citations on a text part and a non-string text-part field', () => {
    expect(() =>
      assertToolResultParts([{ type: 'text', text: 'x', citations: { f: () => 1 } }]),
    ).toThrow(/citations must be a JSON value/);
  });

  it('accepts a part with every optional field well formed', () => {
    expect(() =>
      assertToolResultParts([
        { type: 'text', text: 'x', citations: [{ a: 1 }] },
        {
          ...base,
          mimeType: 'image/png',
          name: 'n',
          alt: 'a',
          caption: 'c',
          transcript: 't',
          extractedText: 'e',
          metadata: { nested: { ok: [1, 'two', null] } },
        },
      ]),
    ).not.toThrow();
  });
});

describe('OpenAI formatters keep a non-success outcome beside parts', () => {
  const parts: ToolResultPart[] = [{ type: 'text', text: 'partial output' }];
  const failed = {
    callId: 'call-1',
    outcome: 'error' as const,
    content: null,
    parts,
    error: { code: 'E_X', category: 'internal' as const, retryable: false, message: 'failed' },
  };

  it('prefixes the canonical payload, synchronously and asynchronously', async () => {
    const expected = `${JSON.stringify({
      outcome: 'error',
      content: null,
      error: failed.error,
    })}\n\npartial output`;
    expect(formatOpenAIToolResults(failed)[0]?.content).toBe(expected);
    const formatted = await formatOpenAIToolResultsAsync(failed);
    expect(formatted[0]?.content).toBe(expected);
  });

  it('sends only the parts for a successful result', () => {
    expect(formatOpenAIToolResults({ ...failed, outcome: 'success' })[0]?.content).toBe(
      'partial output',
    );
  });
});

describe('truncation middleware shares one budget across the text parts', () => {
  async function truncate(
    parts: ToolResultPart[],
    maxCharacters: number,
    extra: { isError?: boolean; errorMaxCharacters?: number } = {},
    defaultMarker = false,
  ) {
    const configuration = createTruncationMiddleware({
      maxCharacters,
      ...(defaultMarker ? {} : { marker: '…' }),
      ...extra,
    })({
      name: 't',
      description: 't',
      execute: async () => toolContent(parts),
    } as unknown as ToolConfiguration);
    const result = await (
      configuration.execute as (params: unknown, context: unknown) => Promise<unknown>
    )({}, {});
    expect(isToolContent(result)).toBe(true);
    return (result as ReturnType<typeof toolContent>).parts;
  }

  const media: ToolResultPart = {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: PNG, encoding: 'base64' },
  };

  it('spends the budget across parts instead of per part', async () => {
    const parts = await truncate(
      [
        { type: 'text', text: 'a'.repeat(15) },
        media,
        { type: 'text', text: 'b'.repeat(15) },
        { type: 'text', text: 'c'.repeat(15) },
      ],
      20,
    );
    const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
    expect(text.join('').length).toBeLessThanOrEqual(20);
    expect(text[0]).toBe('a'.repeat(15));
    expect(text[1]?.endsWith('…')).toBe(true);
    // Media is kept, in place; the part that no longer fits is dropped.
    expect(parts.map((part) => part.type)).toEqual(['text', 'image', 'text']);
  });

  it('uses the error budget when isError is set, as the string path does', async () => {
    const parts = await truncate([{ type: 'text', text: 'e'.repeat(2000) }], 1000, {
      isError: true,
      errorMaxCharacters: 20,
    });
    expect(parts).toEqual([{ type: 'text', text: `${'e'.repeat(19)}…` }]);
  });

  it('marks the cut when the budget left is no longer than the marker', async () => {
    const parts = await truncate(
      [
        { type: 'text', text: 'a'.repeat(7990) },
        { type: 'text', text: 'b'.repeat(500) },
      ],
      8000,
      {},
      true,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'a'.repeat(7990) },
      { type: 'text', text: DEFAULT_TRUNCATION_MARKER },
    ]);
  });

  it('leaves parts that fit the whole budget unchanged', async () => {
    const parts = await truncate(
      [
        { type: 'text', text: 'a'.repeat(10) },
        { type: 'text', text: 'b'.repeat(10) },
      ],
      20,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'a'.repeat(10) },
      { type: 'text', text: 'b'.repeat(10) },
    ]);
  });

  it('marks the cut even when an earlier part used the whole budget', async () => {
    const parts = await truncate(
      [
        { type: 'text', text: 'a'.repeat(20) },
        { type: 'text', text: 'b' },
      ],
      20,
    );
    expect(parts).toEqual([
      { type: 'text', text: 'a'.repeat(20) },
      { type: 'text', text: '…' },
    ]);
  });
});
