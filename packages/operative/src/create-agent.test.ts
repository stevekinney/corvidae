/**
 * AB-241: `AgentRunContext.principal` forwards into `RunOptions.principal`
 * on `createAgent`'s run path, the same way `signal`/`traceContext` already
 * forward — proven here through `OPERATIVE_RESOLVE_RUN_OPTIONS` (AB-21's
 * definition-resolution protocol), which resolves the exact `RunOptions` bag
 * `run()` itself builds, without starting an in-memory run.
 */
import { describe, expect, it } from 'bun:test';

import { createAgent } from './create-agent';
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
