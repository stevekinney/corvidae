/**
 * COR-1650 — `bureau.agents.list` names each agent's tools, as an optional `tools` field: a
 * code-defined agent's `toolNames`, a file agent's `tools` frontmatter, and nothing for an agent
 * that does not say (which is not the same as an agent with none).
 */
import { createAgent } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentsListOperation } from './deployment-operations.ts';
import {
  callAs,
  disposeServed,
  listOf,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

const lookup = createTool({
  name: 'lookup-order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  execute: async () => 'found',
});
const generate = async () => ({ content: 'ok', toolCalls: [] });

describe('bureau.agents.list tools', () => {
  it('names a code agent’s tools, says [] for one with none, and omits it for an agent that does not say', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({ name: 'alpha', generate, tools: { 'look-up': lookup } }),
        bare: createAgent({ name: 'bare', generate }),
        // A runnable agent that is not a `createAgent` result states no tools at all.
        opaque: Object.assign(createAgent({ name: 'opaque', generate }), {
          toolNames: undefined,
        }),
      },
    });

    const byName = new Map(
      listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents').map((entry) => [
        entry['name'],
        entry,
      ]),
    );

    expect(byName.get('alpha')?.['tools']).toEqual(['look-up']);
    expect(byName.get('bare')?.['tools']).toEqual([]);
    expect('tools' in (byName.get('opaque') ?? {})).toBe(false);
  });

  it('names a file agent’s tools from its definition', async () => {
    const served = await serve();
    await seed(served);

    const listed = listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents');

    expect(listed.find((entry) => entry['name'] === 'researcher')?.['tools']).toEqual([
      'lookup-order',
    ]);
  });
});

describe('the bureau.agents.list output schema tools (COR-1650)', () => {
  const entry = (tools: unknown) => ({
    name: 'alpha',
    displayName: 'Alpha',
    description: null,
    definitionRevision: 1,
    kind: 'code',
    publishState: 'published',
    media: null,
    ...(tools === undefined ? {} : { tools }),
  });
  const parses = (tools: unknown) =>
    agentsListOperation.outputSchema.safeParse({ agents: [entry(tools)] }).success;

  it('takes a list of names, or none', () => {
    expect(parses(undefined)).toBe(true);
    expect(parses([])).toBe(true);
    expect(parses(['lookup-order'])).toBe(true);
  });

  it.each([['lookup-order'], [1], [[1]], [null]])('refuses tools of %j', (tools) => {
    expect(parses(tools)).toBe(false);
  });
});
