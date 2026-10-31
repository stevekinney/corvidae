import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createNameMapper,
  createProviderToolNameMapper,
  createTool,
  createToolbox,
  formatAnthropicToolResults,
  formatGeminiToolResults,
  formatOpenAIToolResults,
  parseAnthropicToolCalls,
  parseGeminiToolCalls,
  parseOpenAIToolCalls,
  PROVIDER_TOOL_NAME_LIMIT,
  toAnthropicTools,
  toGeminiTools,
  toOpenAITools,
  toProviderToolName,
} from '../src';
import { createOpenAIToolGate, toOpenAIAgentTools } from '../src/adapters/open-ai/agents';

// `plugin-<fill>:search@1.0.0` is exactly 70 characters.
const LONG_NAMESPACE = `plugin-${'x'.repeat(70 - 'plugin-'.length - ':search@1.0.0'.length)}`;

function longTool(namespace = LONG_NAMESPACE, executed: string[] = []) {
  return createTool({
    name: 'search',
    namespace,
    version: '1.0.0',
    description: 'Search',
    input: z.object({ query: z.string() }),
    async execute({ query }) {
      executed.push(`${namespace}:${query}`);
      return query;
    },
  });
}

const LEGAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

describe('provider tool names', () => {
  it('encodes a 70-character id as a legal, bounded, distinct name', () => {
    const tool = longTool();
    expect(tool.id).toHaveLength(70);

    const name = toProviderToolName(tool.id);
    expect(name.length).toBeLessThanOrEqual(PROVIDER_TOOL_NAME_LIMIT);
    expect(name).toMatch(LEGAL_NAME);
    expect(toProviderToolName(longTool(`${LONG_NAMESPACE.slice(0, -1)}y`).id)).not.toBe(name);
  });

  it('keeps ids that sanitize to the same text apart', () => {
    expect(toProviderToolName('a:b')).not.toBe(toProviderToolName('a_b'));
    expect(toProviderToolName('1:b')).toMatch(LEGAL_NAME);
  });

  it('maps the same tool listed twice without complaint', () => {
    const tool = longTool();
    expect(() => createProviderToolNameMapper([tool, tool])).not.toThrow();
  });

  it('passes a name it did not encode through unchanged', () => {
    expect(createProviderToolNameMapper([longTool()])('other')).toBe('other');
  });
});

describe('a 70-character namespaced id round-trips through each provider adapter', () => {
  it('Anthropic', async () => {
    const executed: string[] = [];
    const tool = longTool(LONG_NAMESPACE, executed);
    const toolbox = createToolbox([tool, longTool('other', executed)]);

    const sent = toAnthropicTools(toolbox, { naming: 'safe-id' }).map((entry) => entry.name);
    expect(new Set(sent).size).toBe(2);
    for (const name of sent) expect(name).toMatch(LEGAL_NAME);
    const name = toAnthropicTools(tool, { naming: 'safe-id' }).name;
    expect(name.length).toBeLessThanOrEqual(PROVIDER_TOOL_NAME_LIMIT);

    const calls = parseAnthropicToolCalls(
      [{ type: 'tool_use', id: 'toolu_1', name, input: { query: 'q' } }],
      createProviderToolNameMapper(toolbox),
    );
    expect(calls.map((call) => call.name)).toEqual([tool.id]);
    const result = await toolbox.execute(calls[0]!);
    expect(result.outcome).toBe('success');
    expect(executed).toEqual([`${LONG_NAMESPACE}:q`]);
  });

  it('OpenAI', async () => {
    const executed: string[] = [];
    const tool = longTool(LONG_NAMESPACE, executed);
    const toolbox = createToolbox([tool, longTool('other', executed)]);

    const name = toOpenAITools(tool, { naming: 'safe-id' }).function.name;
    expect(name).toMatch(LEGAL_NAME);
    expect(name.length).toBeLessThanOrEqual(PROVIDER_TOOL_NAME_LIMIT);

    const calls = parseOpenAIToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: { name, arguments: JSON.stringify({ query: 'q' }) },
        },
      ],
      createNameMapper([...toolbox.tools()]),
    );
    expect(calls.map((call) => call.name)).toEqual([tool.id]);
    const result = await toolbox.execute(calls[0]!);
    expect(result.outcome).toBe('success');
    expect(executed).toEqual([`${LONG_NAMESPACE}:q`]);
  });

  it('Gemini', async () => {
    const executed: string[] = [];
    const tool = longTool(LONG_NAMESPACE, executed);
    const toolbox = createToolbox([tool, longTool('other', executed)]);

    const declarations = toGeminiTools(tool, { naming: 'safe-id' })[0]!.functionDeclarations;
    const name = declarations[0]!.name;
    expect(name).toMatch(LEGAL_NAME);
    expect(name.length).toBeLessThanOrEqual(PROVIDER_TOOL_NAME_LIMIT);

    const calls = parseGeminiToolCalls(
      [{ functionCall: { id: 'g1', name, args: { query: 'q' } } }],
      createProviderToolNameMapper(toolbox),
    );
    expect(calls.map((call) => call.name)).toEqual([tool.id]);
    const result = await toolbox.execute(calls[0]!);
    expect(result.outcome).toBe('success');
    expect(executed).toEqual([`${LONG_NAMESPACE}:q`]);
  });

  it('OpenAI Agents SDK', async () => {
    const executed: string[] = [];
    const tool = longTool(LONG_NAMESPACE, executed);
    const toolbox = createToolbox([tool, longTool('other', executed)]);

    const { tools, toolNames } = await toOpenAIAgentTools(toolbox, { naming: 'safe-id' });
    expect(toolNames).toHaveLength(2);
    for (const name of toolNames) {
      expect(name).toMatch(LEGAL_NAME);
      expect(name.length).toBeLessThanOrEqual(PROVIDER_TOOL_NAME_LIMIT);
    }
    // The SDK rewrites `-` to `_`; the adapter already does, so the names agree.
    expect(tools.map((entry) => entry.name)).toEqual(toolNames);
    const sdkTool = tools[toolbox.tools().findIndex((entry) => entry.id === tool.id)];
    expect(sdkTool).toBeDefined();

    await sdkTool!.invoke(undefined as never, JSON.stringify({ query: 'q' }));
    expect(executed).toEqual([`${LONG_NAMESPACE}:q`]);

    const gate = createOpenAIToolGate({ registry: toolbox, naming: 'safe-id' });
    const known = await gate(sdkTool!.name);
    const unknown = await gate('search');
    expect(known.behavior).toBe('allow');
    expect(unknown.behavior).toBe('deny');
  });

  it('runs the converted tool even when two namespaces share its bare name', async () => {
    const executed: string[] = [];
    const toolbox = createToolbox([longTool('a', executed), longTool('b', executed)]);

    const { tools } = await toOpenAIAgentTools(toolbox, { naming: 'safe-id' });
    const second = tools[toolbox.tools().findIndex((entry) => entry.id === 'b:search@1.0.0')];
    await second!.invoke(undefined as never, JSON.stringify({ query: 'q' }));
    expect(executed).toEqual(['b:q']);
  });
});

describe('naming through the toolbox and the Gemini result formatter', () => {
  it('toProvider forwards naming to every provider', async () => {
    const toolbox = createToolbox([longTool(), longTool('other')]);
    const expected = toolbox.tools().map((tool) => toProviderToolName(tool.id));

    const anthropic = (await toolbox.toProvider('anthropic', { naming: 'safe-id' })) as {
      name: string;
    }[];
    expect(anthropic.map((entry) => entry.name)).toEqual(expected);
    const openai = (await toolbox.toProvider('openai', { naming: 'safe-id' })) as {
      function: { name: string };
    }[];
    expect(openai.map((entry) => entry.function.name)).toEqual(expected);
    const gemini = (await toolbox.toProvider('gemini', { naming: 'safe-id' })) as {
      functionDeclarations: { name: string }[];
    }[];
    expect(gemini[0]!.functionDeclarations.map((entry) => entry.name)).toEqual(expected);
    const rejection = await toolbox
      .toProvider('anthropic', { naming: 'nope' })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(TypeError);
  });

  it('answers a Gemini call under the encoded name when the caller maps it', () => {
    const tool = longTool();
    const encoded = toProviderToolName(tool.id);
    const [part] = formatGeminiToolResults(
      { callId: 'g1', toolName: 'search', outcome: 'success', content: { ok: true } },
      { toolNameByCallId: { g1: encoded } },
    );
    expect(part?.functionResponse.name).toBe(encoded);

    const [bare] = formatGeminiToolResults({
      callId: 'g1',
      toolName: 'search',
      outcome: 'success',
      content: { ok: true },
    });
    expect(bare?.functionResponse.name).toBe('search');
  });
});

describe('default naming of a namespaced tool', () => {
  function searchIn(namespace: string | undefined, executed: string[]) {
    return createTool({
      name: 'search',
      ...(namespace === undefined ? {} : { namespace }),
      version: '2.0.0',
      description: 'Search',
      input: z.object({ query: z.string() }),
      async execute({ query }) {
        executed.push(`${namespace ?? 'default'}:${query}`);
        return query;
      },
    });
  }

  it('exports namespace__name, a name every provider accepts, and keeps a default tool bare', async () => {
    const toolbox = createToolbox([searchIn('a', []), searchIn('b', []), searchIn(undefined, [])]);
    const anthropic = await toolbox.toAnthropicTools();
    const gemini = await toolbox.toGeminiTools();
    const openai = await toolbox.toOpenAITools();
    const expected = ['a__search', 'b__search', 'search'];

    expect(anthropic.map(({ name }) => name)).toEqual(expected);
    expect(gemini[0]!.functionDeclarations.map(({ name }) => name)).toEqual(expected);
    expect(openai.map(({ function: { name } }) => name)).toEqual(expected);
    for (const name of expected) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // The id a durable record pins is unchanged by the provider name.
    expect(toolbox.tools().map(({ id }) => id)).toEqual([
      'a:search@2.0.0',
      'b:search@2.0.0',
      'default:search@2.0.0',
    ]);
  });

  it('runs the tool a provider called by namespace__name, through each adapter’s parsed call', async () => {
    const executed: string[] = [];
    const toolbox = createToolbox([searchIn('a', executed), searchIn('b', executed)]);

    const [anthropicCall] = parseAnthropicToolCalls([
      { type: 'tool_use', id: 'call-1', name: 'b__search', input: { query: 'from-claude' } },
    ]);
    const [geminiCall] = parseGeminiToolCalls([
      { functionCall: { id: 'g1', name: 'a__search', args: { query: 'from-gemini' } } },
    ]);
    expect(toolbox.resolveTool('b__search')).toMatchObject({
      ok: true,
      tool: { id: 'b:search@2.0.0' },
    });
    await toolbox.execute(anthropicCall!);
    await toolbox.execute(geminiCall!);
    expect(executed).toEqual(['b:from-claude', 'a:from-gemini']);
  });

  it('answers each adapter’s call under the name it exported (COR-1879)', async () => {
    const toolbox = createToolbox([searchIn('a', []), searchIn('b', [])]);
    const [gemini] = await toolbox.toGeminiTools();
    const exported = gemini!.functionDeclarations[0]!.name;
    expect(exported).toBe('a__search');

    const [geminiCall] = parseGeminiToolCalls([
      { functionCall: { id: 'g1', name: exported, args: { query: 'q' } } },
    ]);
    const [anthropicCall] = parseAnthropicToolCalls([
      { type: 'tool_use', id: 'c1', name: exported, input: { query: 'q' } },
    ]);
    const [openaiCall] = parseOpenAIToolCalls([
      { id: 'o1', type: 'function', function: { name: exported, arguments: '{"query":"q"}' } },
    ]);
    const geminiResult = await toolbox.execute(geminiCall!);
    const anthropicResult = await toolbox.execute(anthropicCall!);
    const openaiResult = await toolbox.execute(openaiCall!);

    expect(geminiResult.toolName).toBe('a:search');
    expect(formatGeminiToolResults([geminiResult])[0]!.functionResponse.name).toBe(exported);
    // Anthropic and OpenAI answer by call id, never by name.
    expect(formatAnthropicToolResults([anthropicResult])[0]).toMatchObject({ tool_use_id: 'c1' });
    expect(JSON.stringify(formatAnthropicToolResults([anthropicResult]))).not.toContain('a:search');
    expect(formatOpenAIToolResults([openaiResult])[0]).toMatchObject({ tool_call_id: 'o1' });
    expect(JSON.stringify(formatOpenAIToolResults([openaiResult]))).not.toContain('a:search');
  });

  it('refuses to export two tools that would reach a provider under one name (COR-1879)', async () => {
    const toolbox = createToolbox([
      createTool({ name: 'a__search', description: 'Bare', execute: async () => 'bare' }),
      searchIn('a', []),
    ]);
    const clash =
      'Tools "default:a__search" and "a:search@2.0.0" both reach a provider as "a__search"';

    expect(() => toolbox.toAnthropicTools()).toThrow(clash);
    expect(() => toolbox.toGeminiTools()).toThrow(clash);
    expect(() => toolbox.toOpenAITools()).toThrow(clash);
    expect(() => toAnthropicTools(toolbox.tools())).toThrow(clash);
    expect(toAnthropicTools(toolbox.tools(), { naming: 'safe-id' })).toHaveLength(2);
    expect(await throwingRejectionOf(toOpenAIAgentTools(toolbox))).toThrow(clash);
  });

  it('prefers a registered bare name that contains __ over the namespaced reading', () => {
    const toolbox = createToolbox([
      createTool({ name: 'a__search', description: 'Bare', execute: async () => 'bare' }),
      searchIn('a', []),
    ]);
    expect(toolbox.resolveTool('a__search')).toMatchObject({
      ok: true,
      tool: { id: 'default:a__search' },
    });
  });
});
