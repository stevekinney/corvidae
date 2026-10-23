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

import { createAgent } from './create-agent';
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

  it('hands out a frozen list, so a caller cannot change what the agent reports', () => {
    const agent = createAgent({ generate: mockGenerate(), tools: { refund } });

    expect(Object.isFrozen(agent.toolNames)).toBe(true);
  });
});
