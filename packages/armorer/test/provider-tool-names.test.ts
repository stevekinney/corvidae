import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createNameMapper,
  createProviderToolNameMapper,
  createTool,
  createToolbox,
  formatGeminiToolResults,
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
