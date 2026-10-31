/**
 * AB-241: `AgentRunContext.principal` forwards into `RunOptions.principal`
 * on `createAgent`'s run path, the same way `signal`/`traceContext` already
 * forward — proven here through `OPERATIVE_RESOLVE_RUN_OPTIONS` (AB-21's
 * definition-resolution protocol), which resolves the exact `RunOptions` bag
 * `run()` itself builds, without starting an in-memory run.
 */
import { describe, expect, it } from 'bun:test';

import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { AGENT_EXAMPLE_LIMITS, createAgent } from './create-agent';
import { readGenerationProfile } from './generation-profile';
import { hasDefinitionResolver, OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';

function mockGenerate() {
  return async () => ({ content: 'ok', toolCalls: [] });
}

function resolver(agent: ReturnType<typeof createAgent>) {
  if (!hasDefinitionResolver(agent)) throw new Error('expected a createAgent resolver');
  return agent[OPERATIVE_RESOLVE_RUN_OPTIONS];
}

describe('createAgent: AgentRunContext.principal forwarding (AB-241)', () => {
  it('checks the symbol capability without accepting an ordinary agent-like object', () => {
    const agent = createAgent({ generate: mockGenerate() });

    expect(hasDefinitionResolver(agent)).toBe(true);
    expect(hasDefinitionResolver({})).toBe(false);
  });

  it('forwards context.principal into RunOptions.principal, matching signal/traceContext forwarding', async () => {
    const agent = createAgent({ generate: mockGenerate() });

    const options = await resolver(agent)('hi', { principal: 'user-42' });

    expect(options.principal).toBe('user-42');
  });

  it('leaves RunOptions.principal undefined when the context omits it, behaving exactly as before this field existed', async () => {
    const agent = createAgent({ generate: mockGenerate() });

    const options = await resolver(agent)('hi');

    expect(options.principal).toBeUndefined();
  });
});

describe('createAgent: descriptive metadata (COR-1301)', () => {
  const skillDescriptors = [
    { id: 'summarize', name: 'Summarize', description: 'Condense text.', tags: ['nlp'] },
  ] as const;

  it('surfaces description and skillDescriptors on the returned agent', () => {
    const agent = createAgent({
      generate: mockGenerate(),
      description: 'Summarizes things.',
      skillDescriptors,
    });

    expect(agent.description).toBe('Summarizes things.');
    expect(agent.skillDescriptors).toBe(skillDescriptors);
  });

  it('omits both properties when the agent declares neither', () => {
    const agent = createAgent({ generate: mockGenerate() });

    expect('description' in agent).toBe(false);
    expect('skillDescriptors' in agent).toBe(false);
  });

  it('does not leak descriptive metadata into the resolved run options', async () => {
    const agent = createAgent({
      generate: mockGenerate(),
      description: 'Summarizes things.',
      skillDescriptors,
    });

    const options = await resolver(agent)('hello');

    expect('description' in options).toBe(false);
    expect('skillDescriptors' in options).toBe(false);
  });

  it('leaves the runtime skills seam independent of skillDescriptors', () => {
    const agent = createAgent({ generate: mockGenerate(), skillDescriptors });

    expect('skills' in agent).toBe(false);
  });
});

describe('createAgent: generation profile revision (COR-1584)', () => {
  it('reports revision 1 when no revision is given', () => {
    const agent = createAgent({ generate: mockGenerate() });

    expect(readGenerationProfile(agent).revision).toBe(1);
  });

  it('reports the revision it was created with', () => {
    const agent = createAgent({ generate: mockGenerate(), revision: 4 });

    expect(readGenerationProfile(agent).revision).toBe(4);
  });

  it('does not leak the revision into the resolved run options', async () => {
    const agent = createAgent({ generate: mockGenerate(), revision: 4 });

    const options = await resolver(agent)('hello');

    expect('revision' in options).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %p, which is not a positive safe integer',
    (revision) => {
      expect(() => createAgent({ generate: mockGenerate(), revision })).toThrow(/revision/u);
    },
  );
});

describe('createAgent: namespaced tool keys (COR-1879)', () => {
  function searchIn(namespace: string, executed: string[]) {
    return createTool({
      name: 'search',
      namespace,
      version: '2.0.0',
      description: `Search in ${namespace}`,
      input: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        executed.push(`${namespace}:${query}`);
        return query;
      },
    });
  }

  it('keeps plugin:tool as the identity, shows providers plugin__tool, and runs the tool a provider names', async () => {
    const executed: string[] = [];
    const payloads: { anthropic: string[]; gemini: string[]; ids: string[] }[] = [];
    let step = 0;
    const agent = createAgent({
      tools: { 'a:search': searchIn('a', executed), 'b:search': searchIn('b', executed) },
      generate: async (context) => {
        const gemini = await context.toolbox.toGeminiTools();
        const anthropic = await context.toolbox.toAnthropicTools();
        payloads.push({
          anthropic: anthropic.map(({ name }) => name),
          gemini: (gemini[0]?.functionDeclarations ?? []).map(({ name }) => name),
          ids: context.toolbox.tools().map(({ id }) => id),
        });
        step += 1;
        return step === 1
          ? { content: '', toolCalls: [{ id: 'c1', name: 'b__search', arguments: { query: 'q' } }] }
          : { content: 'done', toolCalls: [] };
      },
    });

    await agent.run('Search.').result();

    expect(agent.toolNames).toEqual(['a:search', 'b:search']);
    expect(payloads[0]).toEqual({
      anthropic: ['a__search', 'b__search'],
      gemini: ['a__search', 'b__search'],
      ids: ['a:search@2.0.0', 'b:search@2.0.0'],
    });
    expect(executed).toEqual(['b:q']);
  });

  it('names a bare-keyed tool by its key and keeps its own namespace', async () => {
    let names: string[] = [];
    let provider: string[] = [];
    const agent = createAgent({
      tools: {
        lookup: searchIn('a', []),
        plain: createTool({ name: 'x', description: 'x', execute: async () => 'x' }),
      },
      generate: async (context) => {
        names = context.toolbox.tools().map(({ name }) => name);
        const exported = await context.toolbox.toAnthropicTools();
        provider = exported.map(({ name }) => name);
        return { content: 'done', toolCalls: [] };
      },
    });
    await agent.run('Look.').result();
    expect(names).toEqual(['lookup', 'plain']);
    // A tool authored in namespace `a` stays there, so a provider sees it as `a__lookup`.
    expect(provider).toEqual(['a__lookup', 'plain']);
  });
});

describe('createAgent: tool names', () => {
  const lookup = createTool({
    name: 'lookup-order',
    description: 'Look up an order',
    input: z.object({ id: z.string() }),
    execute: async () => 'found',
  });
  const refund = createTool({
    name: 'refund-order',
    description: 'Refund an order',
    input: z.object({ id: z.string() }),
    execute: async () => 'refunded',
  });

  it('lists the keys of the tools map, which are the names the model calls them by', () => {
    const agent = createAgent({ generate: mockGenerate(), tools: { 'look-up': lookup, refund } });

    expect(agent.toolNames).toEqual(['look-up', 'refund']);
  });

  it('lists an empty array, not undefined, for an agent created without tools', () => {
    expect(createAgent({ generate: mockGenerate() }).toolNames).toEqual([]);
  });

  it('lists the tools of a pre-built toolbox by their own names', () => {
    const agent = createAgent({
      generate: mockGenerate(),
      toolbox: createToolbox([lookup, refund]),
    });

    expect(agent.toolNames).toEqual(['lookup-order', 'refund-order']);
  });

  it('lists a name once when a pre-built toolbox holds two tools under it', () => {
    const lookupAgain = createTool({
      name: 'lookup-order',
      namespace: 'second',
      description: 'Look up an order a second way',
      input: z.object({ id: z.string() }),
      execute: async () => 'found again',
    });
    const toolbox = createToolbox([lookup, refund, lookupAgain]);
    // The toolbox keeps both: the duplicate is real, not an artifact of how the test built it.
    expect(toolbox.tools().map((tool) => tool.name)).toEqual([
      'lookup-order',
      'refund-order',
      'lookup-order',
    ]);

    const agent = createAgent({ generate: mockGenerate(), toolbox });

    expect(agent.toolNames).toEqual(['lookup-order', 'refund-order']);
  });

  it('hands out a frozen list, so a caller cannot change what the agent reports', () => {
    const agent = createAgent({ generate: mockGenerate(), tools: { refund } });

    expect(Object.isFrozen(agent.toolNames)).toBe(true);
  });
});

describe('createAgent instructions', () => {
  it('reports the instructions it was created with, exactly as given', () => {
    const agent = createAgent({
      generate: mockGenerate(),
      instructions: '  You are a research assistant.\n',
    });

    expect(agent.instructions).toBe('  You are a research assistant.\n');
  });

  it('omits the member for an agent created with none or with an empty string', () => {
    expect('instructions' in createAgent({ generate: mockGenerate() })).toBe(false);
    expect('instructions' in createAgent({ generate: mockGenerate(), instructions: '' })).toBe(
      false,
    );
  });
});

describe('createAgent examples', () => {
  it('reports the prompts it was created with, in order, as a frozen copy', () => {
    const given = ['Refund order 1234', 'Look up order 1001'];
    const agent = createAgent({ generate: mockGenerate(), examples: given });

    expect(agent.examples).toEqual(['Refund order 1234', 'Look up order 1001']);
    expect(Object.isFrozen(agent.examples)).toBe(true);
    // A later change to the caller's array does not change what the agent reports.
    given.push('Another');
    expect(agent.examples).toHaveLength(2);
  });

  it('refuses more prompts than the limit, an empty or blank prompt, and one that is too long', () => {
    const { maxPrompts, maxLength } = AGENT_EXAMPLE_LIMITS;
    const examples = (prompts: string[]) => () =>
      createAgent({ generate: mockGenerate(), examples: prompts });

    expect(
      examples(Array.from({ length: maxPrompts }, (_, index) => `Prompt ${index}`)),
    ).not.toThrow();
    expect(examples(['a'.repeat(maxLength)])).not.toThrow();
    expect(examples([])).not.toThrow();
    expect(
      examples(Array.from({ length: maxPrompts + 1 }, (_, index) => `Prompt ${index}`)),
    ).toThrow(/at most 3 prompts/);
    expect(examples([''])).toThrow(/non-empty/);
    expect(examples(['   '])).toThrow(/non-empty/);
    expect(examples(['a'.repeat(maxLength + 1)])).toThrow(/at most 200 characters/);
  });

  it('omits the field for an agent created without any, so none is not an empty list', () => {
    expect('examples' in createAgent({ generate: mockGenerate() })).toBe(false);
  });
});
