/**
 * COR-1650 — `bureau.agents.list` names each agent's tools, as an optional `tools` field: a
 * code-defined agent's `toolNames`, a file agent's `tools` frontmatter, and nothing for an agent
 * that does not say (which is not the same as an agent with none). It also names the prompts an
 * agent suggests, as an optional `examples` field, with the same code-agent and file-agent sources.
 */
import { readFile } from 'node:fs/promises';

import { createAgent } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentsListOperation } from './deployment-operations.ts';
import {
  callAs,
  disposeServed,
  listOf,
  ownerPath,
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
    a2a: true,
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

describe('bureau.agents.list examples', () => {
  it('lists a code agent’s examples, and omits the field for one that has none', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate,
          examples: ['Refund order 1234', 'Look up order 1001'],
        }),
        bare: createAgent({ name: 'bare', generate }),
        empty: createAgent({ name: 'empty', generate, examples: [] }),
      },
    });

    const byName = new Map(
      listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents').map((entry) => [
        entry['name'],
        entry,
      ]),
    );

    expect(byName.get('alpha')?.['examples']).toEqual(['Refund order 1234', 'Look up order 1001']);
    expect('examples' in (byName.get('bare') ?? {})).toBe(false);
    // An agent that lists none suggests none: the field is absent, never an empty list.
    expect('examples' in (byName.get('empty') ?? {})).toBe(false);
  });

  it('lists no examples for a runnable that states more than the bounds allow, and still lists the others', async () => {
    const odd = Object.assign(createAgent({ name: 'odd', generate }), {
      examples: ['a', 'b', 'c', 'd'],
    });
    const served = await serve({
      agents: { odd, alpha: createAgent({ name: 'alpha', generate, examples: ['Fine'] }) },
    });

    const byName = new Map(
      listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents').map((entry) => [
        entry['name'],
        entry,
      ]),
    );

    expect(byName.get('alpha')?.['examples']).toEqual(['Fine']);
    expect(byName.has('odd')).toBe(true);
    expect('examples' in (byName.get('odd') ?? {})).toBe(false);
  });

  it('lists a file agent’s examples frontmatter, and an update that does not carry them keeps them', async () => {
    const served = await serve();
    await served.put(
      'researcher.md',
      '---\nname: Researcher\nmodel: anthropic/claude-opus-5-5\nexamples:\n  - Find the latest filing\n  - Summarise it\n---\nOriginal.\n',
    );
    await served.bureau.agents.refresh();
    const examplesOfResearcher = async () =>
      listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents').find(
        (entry) => entry['name'] === 'researcher',
      )?.['examples'];

    expect(await examplesOfResearcher()).toEqual(['Find the latest filing', 'Summarise it']);

    const updated = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      // A new model makes the frontmatter itself change, so the file is rewritten around the list.
      definition: {
        name: 'Researcher',
        model: 'anthropic/claude-opus-5',
        instructions: 'Rewritten.\n',
      },
    });
    expect(updated.error).toBeUndefined();
    expect(await readFile(ownerPath(served), 'utf8')).toContain('model: anthropic/claude-opus-5\n');
    await served.bureau.agents.refresh();

    expect(await examplesOfResearcher()).toEqual(['Find the latest filing', 'Summarise it']);
  });

  it('writes nothing for an update that changes nothing in a file that has examples', async () => {
    const served = await serve();
    await served.put(
      'researcher.md',
      '---\nname: Researcher\nmodel: anthropic/claude-opus-5-5\nexamples: [Find it]\n---\nSame.\n',
    );
    await served.bureau.agents.refresh();
    const hash = served.hashOf('researcher');

    const same = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: hash,
      definition: {
        name: 'Researcher',
        model: 'anthropic/claude-opus-5-5',
        instructions: 'Same.\n',
      },
    });

    expect(same.result?.['hash']).toBe(hash);
  });

  it('refuses a file whose examples are not a list of text', async () => {
    const served = await serve();
    await served.put(
      'researcher.md',
      '---\nname: Researcher\nmodel: anthropic/claude-opus-5-5\nexamples: 3\n---\nBody.\n',
    );
    await served.bureau.agents.refresh();

    const listed = listOf(await callAs(served.local, 'bureau.agents.list', {}), 'agents');

    expect(listed.some((entry) => entry['name'] === 'researcher')).toBe(false);
  });
});

describe('the bureau.agents.list output schema examples', () => {
  const parses = (examples: unknown) =>
    agentsListOperation.outputSchema.safeParse({
      agents: [
        {
          name: 'alpha',
          displayName: 'Alpha',
          description: null,
          definitionRevision: 1,
          kind: 'code',
          a2a: true,
          media: null,
          ...(examples === undefined ? {} : { examples }),
        },
      ],
    }).success;

  it('takes a list of prompts, or none', () => {
    expect(parses(undefined)).toBe(true);
    expect(parses(['Refund order 1234'])).toBe(true);
  });

  it.each([['Refund'], [1], [[1]], [null], [['']], [['  ']]])(
    'refuses examples of %j',
    (examples) => {
      expect(parses(examples)).toBe(false);
    },
  );

  it('refuses more than three prompts, and a prompt over 200 characters', () => {
    expect(parses(['a', 'b', 'c'])).toBe(true);
    expect(parses(['a'.repeat(200)])).toBe(true);
    expect(parses(['a', 'b', 'c', 'd'])).toBe(false);
    expect(parses(['a'.repeat(201)])).toBe(false);
  });
});
